from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.config import settings, Settings
from app.services import private_tts_storage
from app.services.engines.base import SentenceCue, TimedSynthesisResult


SECRET = "test-proxy-secret-" * 3


def headers(user="alice", **extra):
    return {"X-Authenticated-User": user, "X-Auth-Proxy-Secret": SECRET, **extra}


@pytest.fixture
def private_client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", "private")
    monkeypatch.setattr(settings, "COPILOT_AUTH_MODE", "trusted_proxy")
    monkeypatch.setattr(settings, "AUTH_PROXY_SECRET", SECRET)
    store = private_tts_storage.PrivateTTSStore(tmp_path / "history.db", tmp_path / "private_audio")
    monkeypatch.setattr(private_tts_storage, "_store", store)
    with TestClient(app, headers=headers()) as client:
        yield client, store


def test_private_identity_ignores_browser_id_and_rejects_forgery(private_client):
    client, _ = private_client
    assert client.get("/api/history", headers={"X-Client-ID": "spoof"}).status_code == 200
    for supplied in ({"X-Client-ID": "alice"}, {"X-Authenticated-User": "alice"},
                     {"X-Authenticated-User": "alice", "X-Auth-Proxy-Secret": "fake"}):
        with TestClient(app, headers=supplied) as public:
            assert public.get("/api/history").status_code == 401


def test_private_gemini_key_cache_ownership_and_model_revision(private_client, monkeypatch):
    client, store = private_client
    payload = {"text": " hello ", "engine": "gemini", "voice": "Kore"}
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"original") as synth:
        missing = client.post("/api/tts", json=payload)
        assert missing.status_code == 400
        synth.assert_not_awaited()
        first = client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"})
        assert first.status_code == 200
        key = first.headers["X-Cache-Key"]
        assert len(key) == 64
        assert client.post("/api/tts", json=payload).headers["X-Cache"] == "HIT"
        assert client.get(f"/api/tts/{key}").content == b"original"
        assert client.get(f"/api/tts/{key}", headers=headers("bob")).status_code == 404
        assert client.get(f"/api/tts/flow/{key}", headers=headers("bob")).status_code == 404
        assert client.get("/api/history", headers=headers("bob")).json() == []
        assert client.post("/api/tts", json=payload, headers=headers("bob")).status_code == 400
        monkeypatch.setattr(settings, "GEMINI_TTS_MODEL", "model-next")
        second = client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"})
        assert second.headers["X-Cache-Key"] != key
        monkeypatch.setattr(settings, "TTS_CACHE_REVISION", "next")
        third = client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"})
        assert third.headers["X-Cache-Key"] != second.headers["X-Cache-Key"]
        assert client.get(f"/api/tts/{key}").content == b"original"
        assert synth.await_count == 3
        history = client.get("/api/history").json()
        assert all(row["audio_status"] == "ready" for row in history)
        row = next(row for row in history if row["cache_key"] == key)
        assert client.delete(f'/api/history/{row["id"]}', headers=headers("bob")).status_code == 404
        assert client.delete(f'/api/history/{row["id"]}').status_code == 204
        assert client.get(f"/api/tts/{key}").status_code == 404


def test_missing_audio_get_is_410_and_only_explicit_post_regenerates(private_client):
    client, store = private_client
    payload = {"text": "hello", "engine": "gemini"}
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"audio") as synth:
        first = client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"})
        assert first.status_code == 200
        key = first.headers["X-Cache-Key"]
        next(store.root.rglob("*.mp3")).unlink()
        assert client.get("/api/history").json()[0]["audio_status"] == "unavailable"
        assert client.get(f"/api/tts/{key}").status_code == 410
        assert client.get(f"/api/tts/flow/{key}").status_code == 410
        assert client.post("/api/tts", json=payload).status_code == 400
        assert synth.await_count == 1
        assert client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"}).status_code == 200
        assert synth.await_count == 2


def test_private_flow_and_audio_share_original_and_timeline(private_client):
    client, _ = private_client
    payload = {"text": "hello", "engine": "edge"}
    result = TimedSynthesisResult(b"edge-audio", [SentenceCue("hello", 0, 100)])
    with patch("app.services.engines.edge_engine.EdgeTTSEngine.synthesize_with_timeline", new_callable=AsyncMock, return_value=result) as synth:
        first = client.post("/api/tts", json=payload)
        assert first.status_code == 200
        key = first.headers["X-Cache-Key"]
        flow = client.post("/api/tts/flow", json=payload)
        assert flow.status_code == 200
        assert flow.json()["cache_key"] == key
        assert flow.json()["sentences"][0]["end_ms"] == 100
        assert client.get(f"/api/tts/flow/{key}").json()["timeline_available"]
        assert client.get(f"/api/tts/{key}").headers["Cache-Control"] == "private, no-store"
        synth.assert_awaited_once()
        assert client.delete("/api/history").status_code == 204
        assert client.get(f"/api/tts/{key}").status_code == 404


@pytest.mark.parametrize("failure", ["capacity", "fsync", "rename", "database"])
def test_failed_regeneration_preserves_unavailable_history(private_client, failure):
    import errno
    import sqlite3
    from contextlib import nullcontext

    client, store = private_client
    payload = {"text": "hello", "engine": "gemini"}
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"original") as synth:
        created = client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"})
        key = created.headers["X-Cache-Key"]
        next(store.root.rglob("*.mp3")).unlink()
        assert client.get(f"/api/tts/{key}").status_code == 410
        retained = client.get("/api/history").json()
        synth.return_value = b"replacement"
        if failure == "capacity":
            injected = patch.object(store, "user_max_bytes", 1)
        elif failure == "fsync":
            injected = patch("app.services.private_tts_storage.os.fsync", side_effect=OSError(errno.ENOSPC, "full"))
        elif failure == "rename":
            injected = patch("pathlib.Path.replace", side_effect=OSError("rename failed"))
        else:
            with sqlite3.connect(store.db_path) as connection:
                connection.execute("create trigger fail_regenerate before insert on tts_history_v2 begin select raise(abort, 'injected'); end")
            injected = nullcontext()
        with injected:
            failed = client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"})
        assert failed.status_code == (507 if failure in ("capacity", "fsync") else 503)
        assert client.get("/api/history").json() == retained
        assert client.get(f"/api/tts/{key}").status_code == 410
        assert client.get(f"/api/tts/flow/{key}").status_code == 410
        assert synth.await_count == 2
        assert not list(store.root.rglob("*.mp3.tmp_*"))
        if failure == "database":
            with sqlite3.connect(store.db_path) as connection:
                connection.execute("drop trigger fail_regenerate")
        regenerated = client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"})
        assert regenerated.status_code == 200
        restored = client.get("/api/history").json()
        assert restored[0]["id"] == retained[0]["id"]
        assert restored[0]["created_at"] == retained[0]["created_at"]
        assert restored[0]["audio_status"] == "ready"
        assert client.get(f"/api/tts/{key}").content == b"replacement"


def test_production_private_requires_trusted_proxy(monkeypatch):
    monkeypatch.setattr(Settings, "APP_ENV", "production")
    monkeypatch.setattr(Settings, "TTS_STORAGE_MODE", "private")
    monkeypatch.setattr(Settings, "COPILOT_AUTH_MODE", "development")
    with pytest.raises(ValueError, match="trusted_proxy|trusted proxy"):
        Settings()


def test_real_edge_stream_size_limit_returns_507(private_client, monkeypatch):
    client, _ = private_client
    monkeypatch.setattr(settings, "MAX_AUDIO_BYTES", 4)
    class Stream:
        async def stream(self):
            yield {"type": "audio", "data": b"12345"}
    monkeypatch.setattr("edge_tts.Communicate", lambda *args, **kwargs: Stream())
    response = client.post("/api/tts/flow", json={"text": "hello"})
    assert response.status_code == 507
    assert client.get("/api/history").json() == []


def test_private_sqlite_and_disk_full_fail_without_publishing(private_client):
    import errno
    import sqlite3
    client, store = private_client
    payload = {"text": "hello", "engine": "gemini"}
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"audio"):
        with patch("app.services.private_tts_storage.os.fsync", side_effect=OSError(errno.ENOSPC, "full")):
            assert client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"}).status_code == 507
        with sqlite3.connect(store.db_path) as conn:
            conn.execute("create trigger fail_write before insert on tts_history_v2 begin select raise(abort, 'injected'); end")
        assert client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"}).status_code == 503
    assert client.get("/api/history").json() == []
    assert not list(store.root.rglob("*.mp3*"))


@pytest.mark.anyio
async def test_same_owner_requests_coalesce_but_other_owners_synthesize_independently(private_client):
    import asyncio
    import httpx
    arrived = 0
    both_owners = asyncio.Event()

    async def synthesize(*args, **kwargs):
        nonlocal arrived
        arrived += 1
        if arrived == 2:
            both_owners.set()
        await asyncio.wait_for(both_owners.wait(), 2)
        return b"audio"

    payload = {"text": "hello", "engine": "gemini"}
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", side_effect=synthesize) as synth:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            responses = await asyncio.gather(*[
                client.post("/api/tts", json=payload, headers=headers(owner, **{"X-Gemini-Api-Key": "byok"}))
                for owner in ("alice", "alice", "bob")
            ])
        assert all(response.status_code == 200 for response in responses)
        assert synth.await_count == 2
        assert sorted(response.headers["X-Cache"] for response in responses) == ["HIT", "MISS", "MISS"]


@pytest.mark.anyio
async def test_gemini_conversion_size_error_keeps_distinct_type(monkeypatch):
    from types import SimpleNamespace
    from app.services.engines.gemini_engine import pcm_to_mp3
    from app.services.errors import TTSAudioTooLargeError
    monkeypatch.setattr(settings, "MAX_AUDIO_BYTES", 4)
    process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(b"12345", b"")))
    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=process):
        with pytest.raises(TTSAudioTooLargeError):
            await pcm_to_mp3(b"\0\0")
