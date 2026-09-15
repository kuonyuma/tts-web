import asyncio
import base64
import errno
import json
import os
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient
from google import genai

from app.api.limits import RequestLimits
from app.config import settings
from app.main import app
from app.services import cache_service as cache, explain_service as explain, history_service as history, runtime
from app.services.engines.base import SentenceCue, TimedSynthesisResult
from app.services.engines.edge_engine import EdgeTTSEngine
from app.services.errors import StorageFullError, TTSBusyError, TTSTimeoutError, TTSUpstreamError

KEY = "0123456789abcdef"
HEADERS = {"X-Client-ID": "release-client"}
client = TestClient(app, headers=HEADERS)


@pytest.mark.parametrize("value", [None, "", " ", [], {}, "あ" * 1001, "\ud800"])
def test_invalid_text_is_safe_422(value):
    response = client.post("/api/tts", json={"text": value}) if value != "\ud800" else client.post(
        "/api/tts", content=b'{"text":"\\ud800"}', headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]


@pytest.mark.parametrize("payload", [
    {"engine": "日本語"}, {"engine": "unknown"}, {"voice": 'x" onmouseover="alert(1)'},
    {"engine": "edge", "voice": "Kore"}, {"engine": "gemini", "voice": "ja-JP-NanamiNeural"},
])
def test_engine_and_voice_are_validated_before_provider(payload):
    assert client.post("/api/tts", json={"text": "Hello", **payload}).status_code == 422


@pytest.mark.parametrize("key", ["..\\sentinel", "../sentinel", "A:" + "\\test", "a" * 17, "..%5Csentinel"])
def test_cache_cannot_escape_audio_directory(key, isolated_storage):
    sentinel = isolated_storage / "sentinel.mp3"
    sentinel.write_bytes(b"private-sentinel")
    for operation in (cache.get_cached_audio, cache.get_cached_flow, cache.delete_audio_cache):
        with pytest.raises(ValueError):
            operation(key)
    response = client.get("/api/tts/..%5Csentinel")
    assert response.status_code == 422
    assert b"private-sentinel" not in response.content
    assert sentinel.read_bytes() == b"private-sentinel"


def test_cache_hash_has_no_delimiter_ambiguity():
    for function in (cache.compute_cache_key, cache.compute_flow_cache_key):
        assert function("a", "b|ja-JP-NanamiNeural", "edge") != function("a|b", "ja-JP-NanamiNeural", "edge")


@pytest.mark.parametrize("cid", [None, "", " ", "default", "a" * 129, "a/b"])
def test_no_shared_default_history(cid):
    headers = {} if cid is None else {"X-Client-ID": cid}
    bare = TestClient(app)
    assert bare.get("/api/history", headers=headers).status_code == 422
    assert bare.delete("/api/history", headers=headers).status_code == 422
    assert bare.post("/api/tts", headers=headers, json={"text": "Hi"}).status_code == 422
    assert bare.get("/api/explain", headers=headers, params={"text": "Hi"}).status_code == 422
    with pytest.raises(ValueError):
        history.list_history(cid)


def test_server_key_requires_separate_authorization(monkeypatch):
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "private-server-key")
    monkeypatch.setattr(settings, "SERVER_KEY_ACCESS_TOKEN", "a" * 32)
    payload = {"text": "server key access", "engine": "gemini"}
    assert client.post("/api/tts", json=payload).status_code == 400
    assert client.post("/api/explain", json={"text": "server key access"}).status_code == 400
    assert client.post("/api/tts", json=payload, headers={"X-Server-Key-Token": "wrong"}).status_code == 403
    fake = AsyncMock(return_value=b"audio")
    with patch("app.api.tts.synthesize", fake):
        response = client.post("/api/tts", json=payload, headers={"X-Server-Key-Token": "a" * 32})
    assert response.status_code == 200
    assert fake.call_args.kwargs["api_key"] == "private-server-key"


def test_body_limit_and_rate_limit_are_enforced(monkeypatch):
    monkeypatch.setattr(settings, "MAX_REQUEST_BODY_BYTES", 100)
    assert client.post("/api/tts", json={"text": "Hello", "unknown": "x" * 200}).status_code == 413
    monkeypatch.setattr(settings, "REQUESTS_PER_MINUTE", 2)
    assert client.get("/api/engines").status_code == 200
    response = client.get("/api/engines", headers={"X-Client-ID": "different-client"})
    assert response.status_code == 429
    assert response.headers["retry-after"]
    assert client.get("/health").status_code == 200


@pytest.mark.anyio
async def test_chunked_and_slow_request_bodies_are_bounded(monkeypatch):
    monkeypatch.setattr(settings, "MAX_REQUEST_BODY_BYTES", 8)
    monkeypatch.setattr(settings, "REQUEST_BODY_TIMEOUT_SECONDS", 0.03)
    called = False

    async def downstream(scope, receive, send):
        nonlocal called
        called = True

    scope = {"type": "http", "path": "/api/tts", "method": "POST", "headers": [], "client": ("test", 1)}
    responses = []

    async def send(message):
        responses.append(message)

    chunks = iter([{ "type": "http.request", "body": b"12345", "more_body": True}] * 2)

    async def receive_chunks():
        return next(chunks)

    limits = RequestLimits(downstream)
    await limits(scope, receive_chunks, send)
    assert responses[0]["status"] == 413
    assert not called and limits.active == 0
    responses.clear()

    async def slow_receive():
        await asyncio.sleep(10)

    await limits(scope, slow_receive, send)
    assert responses[0]["status"] == 408
    assert not called and limits.active == 0


@pytest.mark.anyio
async def test_same_key_concurrency_uses_one_synthesis_and_one_audio():
    calls = 0

    async def synthesize(**kwargs):
        nonlocal calls
        calls += 1
        number = calls
        await asyncio.sleep(0.03)
        return TimedSynthesisResult(f"audio-{number}".encode(), [SentenceCue(f"sentence-{number}", 0, 100)])

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=HEADERS) as http:
        with patch("app.api.tts.synthesize_with_timeline", synthesize):
            results = await asyncio.gather(*[http.post("/api/tts/flow", json={"text": "duplicate"}) for _ in range(8)])
        assert [r.status_code for r in results] == [200] * 8
        manifests = [r.json() for r in results]
        assert calls == 1
        assert sum(not item["cached"] for item in manifests) == 1
        assert all(item["sentences"][0]["text"] == "sentence-1" for item in manifests)
        assert (await http.get(manifests[0]["audio_url"])).content == b"audio-1"
        assert len((await http.get("/api/history")).json()) == 1
        assert runtime._state().locks == {}


@pytest.mark.anyio
async def test_empty_timeline_is_cached():
    fake = AsyncMock(return_value=TimedSynthesisResult(b"audio", []))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=HEADERS) as http:
        with patch("app.api.tts.synthesize_with_timeline", fake):
            first = await http.post("/api/tts/flow", json={"text": "no timeline"})
            second = await http.post("/api/tts/flow", json={"text": "no timeline"})
        assert first.status_code == second.status_code == 200
        assert second.json()["cached"] and not second.json()["timeline_available"]
        fake.assert_awaited_once()


@pytest.mark.anyio
async def test_explain_and_chat_duplicate_requests_do_not_repeat_billing():
    async def generate(**kwargs):
        await asyncio.sleep(0.02)
        return "explanation"

    fake = AsyncMock(side_effect=generate)
    chat = AsyncMock(side_effect=generate)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=HEADERS) as http:
        with patch("app.api.explain.generate_explanation_text", fake):
            responses = await asyncio.gather(*[http.post("/api/explain", json={"text": "Hello"}) for _ in range(4)])
        assert all(r.status_code == 200 for r in responses)
        fake.assert_awaited_once()
        key = responses[0].json()["explain_key"]
        with patch("app.api.explain.generate_chat_answer", chat):
            responses = await asyncio.gather(*[http.post("/api/explain/chat", json={"explain_key": key, "message": "why?"}) for _ in range(4)])
        assert all(r.status_code == 200 for r in responses)
        chat.assert_awaited_once()
        assert len(explain.get_explanation("release-client", key)["messages"]) == 2


@pytest.mark.anyio
async def test_deadline_cancels_provider_and_frees_key(monkeypatch):
    monkeypatch.setattr(settings, "TTS_TIMEOUT_SECONDS", 0.03)
    cancelled = asyncio.Event()

    async def stalled(**kwargs):
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.set()

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=HEADERS) as http:
        with patch("app.api.tts.synthesize", stalled):
            start = time.monotonic()
            response = await http.post("/api/tts", json={"text": "timeout"})
        assert response.status_code == 502 and "超时" in response.json()["detail"]
        assert time.monotonic() - start < 0.5
        assert cancelled.is_set() and not runtime._state().locks
        monkeypatch.setattr(settings, "TTS_TIMEOUT_SECONDS", 5.0)
        with patch("app.api.tts.synthesize", AsyncMock(return_value=b"audio")):
            assert (await http.post("/api/tts", json={"text": "timeout"})).status_code == 200


@pytest.mark.anyio
async def test_provider_queue_is_bounded_and_cancellation_recovers(monkeypatch):
    monkeypatch.setattr(settings, "EDGE_TTS_MAX_CONCURRENCY", 1)
    monkeypatch.setattr(settings, "QUEUE_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(settings, "MAX_PENDING_REQUESTS", 2)
    async with runtime.upstream_slot("edge"):
        with pytest.raises(TTSBusyError):
            async with runtime.upstream_slot("edge"):
                pytest.fail("Queue should time out")
    async with runtime.upstream_slot("edge"):
        assert runtime._state().pending["edge"] == 1
    assert runtime._state().pending["edge"] == 0


@pytest.mark.anyio
async def test_database_lock_does_not_block_health_and_recovers(monkeypatch):
    history.init_db()
    lock = history.connect_database()
    lock.execute("begin immediate")
    monkeypatch.setattr(settings, "DB_BUSY_TIMEOUT_SECONDS", 0.25)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=HEADERS) as http:
            with patch("app.api.tts.synthesize", AsyncMock(return_value=b"audio")):
                pending = asyncio.create_task(http.post("/api/tts", json={"text": "locked db"}))
                await asyncio.sleep(0.05)
                start = time.monotonic()
                assert (await http.get("/health")).status_code == 200
                assert time.monotonic() - start < 0.15
                assert (await pending).status_code == 503
                lock.rollback()
                assert (await http.post("/api/tts", json={"text": "locked db"})).status_code == 200
    finally:
        lock.close()


@pytest.mark.parametrize("paired", [False, True])
def test_failed_disk_write_never_produces_a_memory_hit(monkeypatch, paired):
    original = cache._write_temp

    def fail(path, data):
        if not paired or "timeline" in path.name:
            raise OSError(errno.ENOSPC, "private-path")
        original(path, data)

    with patch.object(cache, "_write_temp", fail):
        with pytest.raises(OSError):
            if paired:
                cache.put_flow_cache(KEY, b"audio", "edge", "voice", [SentenceCue("Hi", 0, 20)])
            else:
                cache.put_audio_cache(KEY, b"audio")
    assert cache.get_cached_audio(KEY) is None
    assert KEY not in cache._memory_cache and KEY not in cache._flow_cache
    assert list(cache.CACHE_DIR.iterdir()) == []
    cache.put_audio_cache(KEY, b"recovered")
    assert cache.get_cached_audio(KEY) == b"recovered"


def test_cache_quota_ttl_and_restart_recovery(monkeypatch):
    monkeypatch.setattr(settings, "CACHE_MAX_ENTRIES", 1)
    cache.put_audio_cache(KEY, b"first")
    cache.put_audio_cache("ffffffffffffffff", b"second")
    assert cache.get_cached_audio(KEY) is None
    cache._memory_cache.clear()
    assert cache.get_cached_audio("ffffffffffffffff") == b"second"
    path = cache.CACHE_DIR / "ffffffffffffffff.mp3"
    os.utime(path, (0, 0))
    assert cache.get_cached_audio("ffffffffffffffff") is None
    orphan = cache.CACHE_DIR / (KEY + ".timeline.json")
    orphan.write_text("{}")
    pending = cache.CACHE_DIR / (KEY + ".mp3.tmp_abc")
    pending.write_bytes(b"partial")
    cache.cleanup_cache()
    assert not orphan.exists() and not pending.exists()


def test_cache_byte_limit_and_reserve(monkeypatch):
    monkeypatch.setattr(settings, "CACHE_MAX_BYTES", 6)
    cache.put_audio_cache(KEY, b"1234")
    cache.put_audio_cache("ffffffffffffffff", b"5678")
    assert cache.get_cached_audio(KEY) is None
    with pytest.raises(StorageFullError):
        cache.put_audio_cache("aaaaaaaaaaaaaaaa", b"1234567")
    with patch("app.services.cache_service.shutil.disk_usage", return_value=SimpleNamespace(free=0)):
        with pytest.raises(StorageFullError):
            cache.put_audio_cache("aaaaaaaaaaaaaaaa", b"12")


def test_history_quota_does_not_delete_existing_records(monkeypatch):
    monkeypatch.setattr(settings, "HISTORY_MAX_RECORDS", 1)
    history.add_or_touch("one", "original", "voice", "edge", "edge", KEY)
    with pytest.raises(StorageFullError):
        history.add_or_touch("two", "new", "voice", "edge", "edge", "ffffffffffffffff")
    assert history.list_history("one")[0]["text"] == "original"
    history.clear_all_history("one")
    history.add_or_touch("two", "new", "voice", "edge", "edge", "ffffffffffffffff")
    assert len(history.list_history("two")) == 1


def test_chat_storage_serializes_read_modify_write():
    explain.save_explanation("one", "hello", "en", KEY, "explained")
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda n: explain.append_chat_messages("one", KEY, f"q{n}", f"a{n}"), range(6)))
    messages = explain.get_explanation("one", KEY)["messages"]
    assert len(messages) == 12
    assert {m["content"] for m in messages if m["role"] == "user"} == {f"q{n}" for n in range(6)}


def test_runtime_settings_change_validation_and_metadata(monkeypatch):
    monkeypatch.setattr(settings, "MAX_TEXT_LENGTH", 3)
    monkeypatch.setattr(settings, "MIN_TEXT_LENGTH", 2)
    monkeypatch.setattr(settings, "GEMINI_TTS_VOICE", "Aoede")
    assert client.post("/api/tts", json={"text": "abcd"}).status_code == 422
    assert client.post("/api/explain", json={"text": "a"}).status_code == 422
    meta = client.get("/api/engines").json()
    assert meta[0]["max_text_length"] == 3 and meta[0]["min_text_length"] == 2
    assert meta[1]["default_voice"] == "Aoede"
    with patch("app.api.tts.synthesize", AsyncMock(return_value=b"audio")) as fake:
        assert client.post("/api/tts", json={"text": "😀😀", "engine": "gemini"}).status_code == 200
    assert fake.call_args.kwargs["voice"] == "Aoede"


def test_unexpected_failure_has_safe_json_and_request_id(caplog):
    with patch("app.api.tts.synthesize", AsyncMock(side_effect=RuntimeError("secret-key-do-not-log"))):
        response = client.post("/api/tts", json={"text": "unexpected"})
    assert response.status_code == 500
    assert response.json()["detail"] == "服务器内部错误，请稍后重试。"
    assert "secret-key-do-not-log" not in response.text + caplog.text
    assert response.headers["x-request-id"] in caplog.text
    assert "RuntimeError" in caplog.text


def mock_gemini_sdk(monkeypatch, handler):
    real_client = genai.Client
    created = []
    requests = []

    async def record(request):
        requests.append(request)
        return await handler(request)

    def factory(**kwargs):
        options = dict(kwargs["http_options"])
        options["async_client_args"] = {"transport": httpx.MockTransport(record)}
        result = real_client(api_key=kwargs["api_key"], http_options=options)
        created.append(result)
        return result

    monkeypatch.setattr("app.services.gemini_client.genai.Client", factory)
    return created, requests


@pytest.mark.parametrize("status", [401, 403, 404, 429, 500])
@pytest.mark.parametrize("endpoint", ["/api/tts", "/api/explain", "/api/tts/test-key"])
def test_real_sdk_errors_are_mapped_without_retries_or_secrets(monkeypatch, caplog, status, endpoint):
    async def handler(request):
        return httpx.Response(status, json={"error": {"message": "secret-upstream-detail", "code": status}})

    created, requests = mock_gemini_sdk(monkeypatch, handler)
    payload = {"api_key": "fake-key"} if endpoint.endswith("test-key") else {"text": "SDK failure", "engine": "gemini"}
    response = client.post(endpoint, json=payload, headers={"X-Gemini-Api-Key": "fake-key"})
    assert response.status_code == 502
    assert str(status) in response.json()["detail"]
    assert "secret-upstream-detail" not in response.text + caplog.text
    assert len(requests) == 1
    assert all(value is not None for value in requests[0].extensions["timeout"].values())
    assert created[0]._api_client._async_httpx_client.is_closed
    assert created[0]._api_client._httpx_client.is_closed


@pytest.mark.parametrize("mode", ["timeout", "dns", "reset", "malformed", "empty"])
def test_real_sdk_transport_and_invalid_response_failures(monkeypatch, mode):
    async def handler(request):
        if mode == "timeout":
            raise httpx.ReadTimeout("secret", request=request)
        if mode == "dns":
            raise httpx.ConnectError("secret", request=request)
        if mode == "reset":
            raise httpx.ReadError("secret", request=request)
        if mode == "malformed":
            return httpx.Response(200, content=b"not-json")
        return httpx.Response(200, json={"id": "empty", "status": "completed", "steps": []})

    created, requests = mock_gemini_sdk(monkeypatch, handler)
    response = client.post("/api/explain", json={"text": mode}, headers={"X-Gemini-Api-Key": "fake-key"})
    assert response.status_code == 502
    if mode == "timeout":
        assert "超时" in response.json()["detail"]
    assert len(requests) == 1 and created[0]._api_client._async_httpx_client.is_closed


@pytest.mark.parametrize("mime", ["audio/L16;rate=24000", "audio/l16"])
def test_real_sdk_success_with_ffmpeg(monkeypatch, mime):
    async def handler(request):
        body = json.loads(request.content)
        if body.get("response_format"):
            content = {"type": "audio", "data": base64.b64encode(b"\0\0" * 2400).decode(), "mime_type": mime, "sample_rate": 24000, "channels": 1}
        else:
            content = {"type": "text", "text": "explained"}
        return httpx.Response(200, json={"id": "audit", "status": "completed", "steps": [{"type": "model_output", "content": [content]}]})

    created, requests = mock_gemini_sdk(monkeypatch, handler)
    response = client.post("/api/tts", json={"text": "Gemini PCM", "engine": "gemini"}, headers={"X-Gemini-Api-Key": "fake-key"})
    assert response.status_code == 200
    assert response.content.startswith((b"ID3", b"\xff"))
    assert client.get("/api/tts/" + response.headers["x-cache-key"]).content == response.content
    response = client.post("/api/explain", json={"text": "Gemini text"}, headers={"X-Gemini-Api-Key": "fake-key"})
    assert response.status_code == 200 and response.json()["explanation"] == "explained"
    assert all(c._api_client._async_httpx_client.is_closed for c in created)


@pytest.mark.anyio
@pytest.mark.parametrize("error", [TimeoutError("secret"), OSError("secret"), ConnectionResetError("secret")])
async def test_edge_stream_failures_are_controlled(error):
    async def stream():
        raise error
        yield

    with patch("edge_tts.Communicate", return_value=SimpleNamespace(stream=stream)):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=HEADERS) as http:
            response = await http.post("/api/tts/flow", json={"text": "Edge failure"})
    assert response.status_code == 502
    assert "secret" not in response.text
    assert runtime._state().pending["edge"] == 0


def test_legacy_migration_preserves_records_and_default_rows_are_private():
    with sqlite3.connect(history.DB_PATH) as conn:
        conn.execute("create table history (id integer primary key, text text, voice text, model text, cache_key text unique, created_at text, last_played_at text)")
        conn.execute("insert into history values (1,'legacy','Kore','gemini',?,'2026-01-01 00:00:00','2026-01-01 00:00:00')", (KEY,))
    history.init_db()
    with history.connect_database() as conn:
        row = conn.execute("select * from history").fetchone()
        assert row["id"] == 1 and row["text"] == "legacy" and row["client_id"] == "default"
        assert conn.execute("pragma integrity_check").fetchone()[0] == "ok"
    assert history.list_history("new-browser") == []
    assert TestClient(app).get("/api/history").status_code == 422


def test_migration_failure_rolls_back_original_table(monkeypatch):
    # A legacy NOT NULL violation must not leave the original table dropped.
    with sqlite3.connect(history.DB_PATH) as conn:
        conn.execute("create table history (id integer primary key, text text, voice text, model text, cache_key text, created_at text, last_played_at text)")
        conn.execute("insert into history values (1,NULL,'Kore','gemini',?,'date','date')", (KEY,))
    with pytest.raises(sqlite3.IntegrityError):
        history.init_db()
    with sqlite3.connect(history.DB_PATH) as conn:
        assert conn.execute("select count(*) from history").fetchone()[0] == 1
        assert conn.execute("select name from sqlite_master where name='history_migration'").fetchone() is None
    assert not history._initialized


def test_database_file_limit_is_transactional(monkeypatch):
    history.init_db()
    with history.connect_database() as conn:
        pages = conn.execute("pragma page_count").fetchone()[0]
        size = conn.execute("pragma page_size").fetchone()[0]
    monkeypatch.setattr(settings, "DB_MAX_BYTES", pages * size)
    with pytest.raises(sqlite3.OperationalError) as caught:
        history.add_or_touch("one", "x" * 100000, "voice", "edge", "edge", KEY)
    assert caught.value.sqlite_errorcode == sqlite3.SQLITE_FULL
    assert history.list_history("one") == []
    with history.connect_database() as conn:
        assert conn.execute("pragma integrity_check").fetchone()[0] == "ok"


@pytest.mark.parametrize("endpoint", ["/api/tts", "/api/explain", "/api/tts/test-key"])
def test_real_sdk_total_deadline_and_close(monkeypatch, endpoint):
    monkeypatch.setattr(settings, "TTS_TIMEOUT_SECONDS", 0.08)

    async def handler(request):
        await asyncio.sleep(10)

    created, requests = mock_gemini_sdk(monkeypatch, handler)
    payload = {"api_key": "fake-key"} if endpoint.endswith("test-key") else {"text": "deadline", "engine": "gemini"}
    start = time.monotonic()
    response = client.post(endpoint, json=payload, headers={"X-Gemini-Api-Key": "fake-key"})
    assert response.status_code == 502 and "超时" in response.json()["detail"]
    assert time.monotonic() - start < 0.6
    assert created and all(c._api_client._async_httpx_client.is_closed for c in created)


def test_cors_uses_configured_origins():
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    isolated_app = FastAPI()
    isolated_app.add_middleware(RequestLimits)
    isolated_app.add_middleware(CORSMiddleware, allow_origins=["https://allowed.example"], allow_methods=["*"], allow_headers=["*"])
    browser = TestClient(isolated_app)
    allowed = browser.options('/api/tts', headers={"Origin": "https://allowed.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-Client-ID"})
    denied = browser.options('/api/tts', headers={"Origin": "https://other.example", "Access-Control-Request-Method": "POST"})
    assert allowed.status_code == 200 and allowed.headers["access-control-allow-origin"] == "https://allowed.example"
    assert denied.status_code == 400 and "access-control-allow-origin" not in denied.headers


@pytest.mark.anyio
async def test_admission_limit_returns_503_without_starting_extra_work(monkeypatch):
    monkeypatch.setattr(settings, "MAX_PENDING_REQUESTS", 1)
    entered, finish = asyncio.Event(), asyncio.Event()

    async def downstream(scope, receive, send):
        entered.set()
        await finish.wait()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def receive():
        return {"type": "http.request", "body": b""}

    results = []

    async def send(message):
        if message["type"] == "http.response.start":
            results.append(message["status"])

    limits = RequestLimits(downstream)
    scope = {"type": "http", "path": "/api/test", "method": "GET", "headers": []}
    first = asyncio.create_task(limits(dict(scope), receive, send))
    await entered.wait()
    await limits(dict(scope), receive, send)
    assert results == [503]
    finish.set()
    await first
    assert results == [503, 200] and limits.active == 0


@pytest.mark.anyio
async def test_ffmpeg_is_terminated_when_conversion_times_out(monkeypatch):
    from app.services.engines.gemini_engine import pcm_to_mp3
    monkeypatch.setattr(settings, "TTS_TIMEOUT_SECONDS", 0.02)

    class StalledProcess:
        returncode = None
        killed = False

        async def communicate(self, data=None):
            if self.returncode is None:
                await asyncio.sleep(10)
            return b"", b""

        def kill(self):
            self.killed = True
            self.returncode = -1

    process = StalledProcess()
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)):
        with pytest.raises(TTSTimeoutError):
            await pcm_to_mp3(b"\0\0" * 100)
    assert process.killed


def test_storage_quota_returns_507_and_logs_actionable_reason(monkeypatch, caplog):
    monkeypatch.setattr(settings, "HISTORY_MAX_RECORDS", 1)
    history.add_or_touch("existing", "keep", "voice", "edge", "edge", KEY)
    with patch("app.api.tts.synthesize", AsyncMock(return_value=b"audio")):
        response = client.post("/api/tts", json={"text": "new record"})
    assert response.status_code == 507
    assert response.headers["x-request-id"] in caplog.text
    assert "History record quota reached" in caplog.text
    assert history.list_history("existing")[0]["text"] == "keep"
