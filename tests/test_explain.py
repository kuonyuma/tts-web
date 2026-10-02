import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.errors import LLMConfigError, LLMUpstreamError
from app.services.explain_service import build_explain_key
from app.services.llm.types import LLMResult


client = TestClient(app, headers={"X-Client-ID": "test-client"})
TEST_CLIENT = "test-explain-client"


def test_same_text_message_scopes_keep_followups_separate():
    payload = {"text": "同じ文です。", "lang": "zh", "context_id": "conversation-a_message-1"}
    with patch("app.api.explain.generate_explanation_text", AsyncMock(return_value=generated("explained"))), patch(
        "app.api.explain.generate_chat_answer", AsyncMock(return_value=generated("answer"))
    ):
        first = client.post("/api/explain", json=payload)
        assert first.status_code == 200
        first_key = first.json()["explain_key"]
        assert client.post("/api/explain/chat", json={"explain_key": first_key, "message": "why?"}).status_code == 200
        other = client.post("/api/explain", json={**payload, "context_id": "conversation-b_message-1"})
        assert other.status_code == 200
        assert other.json()["explain_key"] != first_key
        assert other.json()["messages"] == []
        restored = client.get("/api/explain", params=payload)
        assert restored.status_code == 200
        assert len(restored.json()["messages"]) == 2
        assert client.get("/api/explain", params=payload, headers={"X-Client-ID": "another-client"}).status_code == 404
        legacy = client.post("/api/explain", json={"text": payload["text"]})
        assert legacy.json()["explain_key"] == build_explain_key(payload["text"], "zh")


@pytest.mark.parametrize("scope", ["", "x" * 129, "invalid/scope", "中文"])
def test_explanation_context_id_validation(scope):
    with patch("app.api.explain.generate_explanation_text", AsyncMock(return_value=generated("unused"))):
        assert client.post("/api/explain", json={"text": "Hi", "context_id": scope}).status_code == 422
    assert client.get("/api/explain", params={"text": "Hi", "context_id": scope}).status_code == 422


def generated(content="1. 中文翻译：你好。", model="deepseek-flash", mode="direct"):
    return (
        LLMResult(content, "deepseek", "deepseek-flash", {"total_tokens": 20}),
        model,
        mode,
        "deepseek-flash-2026-09-v1",
    )


@patch("app.api.explain.save_explanation")
@patch("app.api.explain.get_explanation", return_value=None)
@patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock)
def test_explain_success_miss(mock_generate, _mock_get, mock_save):
    mock_generate.return_value = generated()
    response = client.post(
        "/api/explain",
        json={"text": "Hello.", "lang": "zh", "model_id": "deepseek-flash", "mode_id": "direct"},
        headers={"X-Client-ID": TEST_CLIENT, "X-Gemini-Api-Key": "must-be-ignored"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["cached"] is False
    assert data["model_id"] == "deepseek-flash"
    assert data["mode_id"] == "direct"
    assert len(data["explain_key"]) == 64
    assert mock_generate.call_args.kwargs == {
        "text": "Hello.", "lang": "zh", "model_id": "deepseek-flash", "mode_id": "direct"
    }
    assert "api_key" not in mock_generate.call_args.kwargs
    assert mock_save.call_args.kwargs["provider"] == "deepseek"


@patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock)
@patch("app.api.explain.get_explanation")
def test_explain_cache_hit(mock_get, mock_generate):
    mock_get.return_value = {
        "text": "Hello.", "lang": "zh", "explanation": "stored", "messages": [],
        "model_id": "deepseek-flash", "mode_id": "direct", "upstream_model": "deepseek-flash",
    }
    response = client.post("/api/explain", json={"text": "Hello."})
    assert response.status_code == 200
    assert response.json()["cached"] is True
    mock_generate.assert_not_awaited()


def test_explain_selection_validation():
    assert client.post("/api/explain", json={"text": ""}).status_code == 422
    assert client.post("/api/explain", json={"text": "Hi", "lang": "fr"}).status_code == 422
    assert client.post("/api/explain", json={"text": "Hi", "model_id": "unknown"}).status_code == 422
    assert client.post(
        "/api/explain", json={"text": "Hi", "model_id": "deepseek-flash", "mode_id": "ultra"}
    ).status_code == 422


@patch("app.api.explain.get_explanation", return_value=None)
@patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock)
def test_explain_sanitizes_upstream_error(mock_generate, _mock_get):
    mock_generate.side_effect = LLMUpstreamError(401)
    response = client.post("/api/explain", json={"text": "Hello."})
    assert response.status_code == 502
    assert "401" not in response.text


@pytest.mark.parametrize("failure", ["missing", "storage_full", "upstream"])
def test_redis_lock_preserves_http_errors_and_releases_ownership(monkeypatch, failure):
    from app.services import explain_service

    class FakeRedis:
        def __init__(self):
            self.owned_lock = None
            self.released_lock = None
            self.closed = False

        async def set(self, key, token, **kwargs):
            self.owned_lock = (key, token)
            return True

        async def eval(self, script, numkeys, *args):
            if numkeys == 1:
                self.released_lock = args
            return 1

        async def aclose(self):
            self.closed = True

    fake = FakeRedis()
    monkeypatch.setattr(settings, "REDIS_URL", "redis://mock")
    monkeypatch.setattr("app.services.llm.quota._redis_client", lambda: fake)
    if failure == "storage_full":
        monkeypatch.setattr(settings, "EXPLANATION_MAX_RECORDS", 0)
    with patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock) as generate:
        generate.side_effect = LLMUpstreamError(401)
        if failure == "missing":
            response = client.post("/api/explain/chat", json={
                "explain_key": "a" * 64, "message": "Why?",
            })
        else:
            response = client.post("/api/explain", json={"text": "Hello."})
    assert response.status_code == {"missing": 404, "storage_full": 507, "upstream": 502}[failure]
    assert fake.released_lock == fake.owned_lock
    assert fake.closed is True
    with explain_service._get_conn() as conn:
        assert conn.execute("select count(*) from explanation_storage_reservations").fetchone()[0] == 0


@patch("app.api.explain.append_chat_messages")
@patch("app.api.explain.generate_chat_answer", new_callable=AsyncMock)
@patch("app.api.explain.get_explanation")
def test_chat_uses_stored_model(mock_get, mock_answer, mock_append):
    key = "a" * 64
    mock_get.return_value = {
        "text": "Hello.", "lang": "zh", "explanation": "stored", "messages": [],
        "model_id": "deepseek-flash", "mode_id": "direct", "upstream_model": "deepseek-flash",
    }
    mock_answer.return_value = generated("回答", mode="low")
    mock_append.return_value = []
    response = client.post(
        "/api/explain/chat", json={"explain_key": key, "message": "为什么？", "mode_id": "low"},
        headers={"X-Client-ID": TEST_CLIENT},
    )
    assert response.status_code == 200
    assert response.json()["answer"] == "回答"
    assert mock_answer.call_args.kwargs["model_id"] == "deepseek-flash"
    assert mock_answer.call_args.kwargs["mode_id"] == "low"


def test_chat_deduplication_includes_generation_mode():
    from app.services import explain_service
    from app.services.explain_service import get_explanation, save_explanation

    key = "b" * 64
    save_explanation(
        TEST_CLIENT, "Hello.", "zh", key, "stored explanation",
        model_id="deepseek-flash", provider="deepseek", upstream_model="deepseek-flash",
        mode_id="direct",
    )
    with patch("app.api.explain.generate_chat_answer", new_callable=AsyncMock) as generate:
        generate.side_effect = [generated("direct answer"), generated("deep answer", mode="deep")]
        results = []
        for mode in ("direct", "direct", "deep", "deep"):
            response = client.post(
                "/api/explain/chat",
                json={"explain_key": key, "message": "Why?", "mode_id": mode},
                headers={"X-Client-ID": TEST_CLIENT},
            )
            assert response.status_code == 200
            results.append(response.json())

    assert [item["answer"] for item in results] == [
        "direct answer", "direct answer", "deep answer", "deep answer",
    ]
    assert [item["mode_id"] for item in results] == ["direct", "direct", "deep", "deep"]
    assert all(item["model_id"] == "deepseek-flash" for item in results)
    assert generate.await_count == 2
    stored = get_explanation(TEST_CLIENT, key)
    assert len(stored["messages"]) == 4
    assert stored["messages"][1]["mode_id"] == "direct"
    assert stored["messages"][3]["mode_id"] == "deep"
    assert stored["messages"][3]["model_id"] == "deepseek-flash"
    with explain_service._get_conn() as conn:
        usage = conn.execute(
            "select mode_id, calls, quota_units from copilot_usage_daily order by mode_id"
        ).fetchall()
    assert [tuple(row) for row in usage] == [("deep", 1, 5), ("direct", 1, 1)]


@pytest.mark.parametrize("mode", ["direct", "deep"])
def test_legacy_chat_without_mode_is_regenerated(mode):
    from app.services.explain_service import append_chat_messages, get_explanation, save_explanation

    key = "c" * 64
    save_explanation(
        TEST_CLIENT, "Hello.", "zh", key, "stored explanation",
        model_id="deepseek-flash", mode_id="direct",
    )
    append_chat_messages(TEST_CLIENT, key, "Why?", "legacy answer with unknown mode")
    with patch("app.api.explain.generate_chat_answer", new_callable=AsyncMock) as generate:
        generate.return_value = generated("new answer", mode=mode)
        response = client.post(
            "/api/explain/chat",
            json={"explain_key": key, "message": "Why?", "mode_id": mode},
            headers={"X-Client-ID": TEST_CLIENT},
        )
    assert response.status_code == 200
    assert response.json()["answer"] == "new answer"
    assert response.json()["mode_id"] == mode
    stored = get_explanation(TEST_CLIENT, key)
    assert len(stored["messages"]) == 4
    assert stored["messages"][-1]["mode_id"] == mode


def test_chat_generation_metadata_stays_out_of_provider_messages():
    from app.services.explain_service import build_chat_messages

    messages = build_chat_messages("Hello.", "zh", [
        {"role": "user", "content": "Why?"},
        {"role": "assistant", "content": "Because.", "model_id": "deepseek-flash", "mode_id": "deep"},
    ], "Next?")
    assert messages[2:] == [
        {"role": "user", "content": "Why?"},
        {"role": "assistant", "content": "Because."},
        {"role": "user", "content": "Next?"},
    ]


def test_truncated_explanation_is_not_cached_or_available_for_chat(monkeypatch):
    from app.services import explain_service

    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "server-secret")
    attempts = 0

    def handler(request):
        nonlocal attempts
        attempts += 1
        content = "partial explanation" if attempts == 1 else "complete explanation"
        return httpx.Response(200, json={
            "model": "deepseek-flash",
            "choices": [{
                "finish_reason": "length" if attempts == 1 else "stop",
                "message": {"role": "assistant", "content": content},
            }],
            "usage": {"total_tokens": 20},
        })

    transport = httpx.MockTransport(handler)

    def client_factory(timeout):
        return httpx.AsyncClient(transport=transport, timeout=timeout)

    request = {"text": "Hello.", "lang": "zh", "model_id": "deepseek-flash", "mode_id": "direct"}
    headers = {"X-Client-ID": TEST_CLIENT}
    key = build_explain_key("Hello.", "zh", "deepseek-flash", "direct")
    with patch("app.services.llm.providers.create_http_client", side_effect=client_factory):
        failed = client.post("/api/explain", json=request, headers=headers)
        assert failed.status_code == 502
        assert "partial explanation" not in failed.text
        assert explain_service.get_explanation(TEST_CLIENT, key) is None
        assert client.get("/api/explain", params=request, headers=headers).status_code == 404
        assert client.post("/api/explain/chat", json={
            "explain_key": key, "message": "Why?",
        }, headers=headers).status_code == 404
        with explain_service._get_conn() as conn:
            assert conn.execute("select count(*) from explanation_storage_reservations").fetchone()[0] == 0
            assert conn.execute("select count(*) from copilot_usage_daily").fetchone()[0] == 0

        retried = client.post("/api/explain", json=request, headers=headers)
        assert retried.status_code == 200
        assert retried.json()["explanation"] == "complete explanation"
        assert retried.json()["cached"] is False
        cached = client.post("/api/explain", json=request, headers=headers)
        assert cached.json()["cached"] is True
    assert attempts == 2


def test_truncated_followup_does_not_enter_history_or_next_context(monkeypatch):
    import json
    from app.services.explain_service import get_explanation, save_explanation

    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "server-secret")
    key = "d" * 64
    save_explanation(
        TEST_CLIENT, "Hello.", "zh", key, "stored explanation",
        model_id="deepseek-flash", mode_id="direct",
    )
    payloads = []

    def handler(request):
        payloads.append(json.loads(request.content))
        first = len(payloads) == 1
        return httpx.Response(200, json={
            "model": "deepseek-flash",
            "choices": [{
                "finish_reason": "length" if first else "stop",
                "message": {"role": "assistant", "content": "partial answer" if first else "complete answer"},
            }],
            "usage": {"total_tokens": 20},
        })

    transport = httpx.MockTransport(handler)

    def client_factory(timeout):
        return httpx.AsyncClient(transport=transport, timeout=timeout)

    request = {"explain_key": key, "message": "Why?", "mode_id": "deep"}
    headers = {"X-Client-ID": TEST_CLIENT}
    with patch("app.services.llm.providers.create_http_client", side_effect=client_factory):
        failed = client.post("/api/explain/chat", json=request, headers=headers)
        assert failed.status_code == 502
        assert get_explanation(TEST_CLIENT, key)["messages"] == []
        retried = client.post("/api/explain/chat", json=request, headers=headers)
        assert retried.status_code == 200
        assert retried.json()["answer"] == "complete answer"
        repeated = client.post("/api/explain/chat", json=request, headers=headers)
        assert repeated.json()["answer"] == "complete answer"
    assert len(payloads) == 2
    assert payloads[1]["messages"][-1] == {"role": "user", "content": "Why?"}
    assert all("partial answer" not in item["content"] for item in payloads[1]["messages"])
    assert len(get_explanation(TEST_CLIENT, key)["messages"]) == 2


def test_storage_roundtrip_and_migration_metadata():
    from app.services.explain_service import append_chat_messages, get_explanation, save_explanation

    key = build_explain_key("Storage sentence.", "zh")
    save_explanation(
        TEST_CLIENT, "Storage sentence.", "zh", key, "body",
        model_id="deepseek-flash", provider="deepseek", upstream_model="deepseek-flash",
        mode_id="direct", profile_revision="r1",
    )
    stored = get_explanation(TEST_CLIENT, key)
    assert stored["provider"] == "deepseek"
    assert stored["profile_revision"] == "r1"
    assert append_chat_messages(TEST_CLIENT, key, "q", "a")[-1]["content"] == "a"
    assert get_explanation("someone-else", key) is None


def test_key_separates_model_mode_profile_and_prompt(monkeypatch):
    direct = build_explain_key("Hello.", "zh", "deepseek-flash", "direct")
    deep = build_explain_key("Hello.", "zh", "deepseek-flash", "deep")
    assert direct != deep
    monkeypatch.setattr(settings, "COPILOT_PROMPT_VERSION", "changed")
    assert direct != build_explain_key("Hello.", "zh", "deepseek-flash", "direct")


def test_catalog_only_exposes_configured_models(monkeypatch):
    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "server-secret")
    monkeypatch.setattr(settings, "QWEN_API_KEY", "")
    monkeypatch.setattr(settings, "ZHIPU_API_KEY", "server-secret")
    monkeypatch.setattr(settings, "COPILOT_ENABLED_MODELS", (
        "deepseek-flash", "qwen-3.7-flash", "glm-5.3-flash",
    ))
    monkeypatch.setattr(settings, "COPILOT_ENABLE_UNVERIFIED_GLM53", False)
    data = client.get("/api/copilot/models").json()
    assert [model["id"] for model in data["models"]] == ["deepseek-flash"]
    assert "secret" not in str(data).lower()


def test_catalog_exposes_the_configured_request_deadline(monkeypatch):
    monkeypatch.setattr(settings, "LLM_TIMEOUT_SECONDS", 12.5)
    response = client.get("/api/copilot/models")
    assert response.status_code == 200
    assert response.json()["request_timeout_seconds"] == 12.5


def test_missing_server_key_is_service_configuration_error(monkeypatch):
    from app.services.llm.registry import provider_api_key

    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "")
    with pytest.raises(LLMConfigError):
        provider_api_key("deepseek")


def test_trusted_proxy_identity_is_required(monkeypatch):
    monkeypatch.setattr(settings, "COPILOT_AUTH_MODE", "trusted_proxy")
    monkeypatch.setattr(settings, "AUTH_PROXY_SECRET", "s" * 32)
    assert client.get("/api/copilot/models").status_code == 401
    response = client.get("/api/copilot/models", headers={
        "X-Authenticated-User": "user@example.com",
        "X-Auth-Proxy-Secret": "s" * 32,
    })
    assert response.status_code == 200


def test_production_configuration_fails_closed(monkeypatch):
    from app.config import Settings

    monkeypatch.setattr(Settings, "APP_ENV", "production")
    monkeypatch.setattr(Settings, "COPILOT_AUTH_MODE", "development")
    monkeypatch.setattr(Settings, "REDIS_URL", "")
    with pytest.raises(ValueError, match="trusted_proxy"):
        Settings()


def test_generate_calls_gateway_with_structured_messages():
    from app.services import explain_service

    async def run():
        with patch.object(explain_service, "complete", new_callable=AsyncMock) as complete_mock:
            complete_mock.return_value = generated()
            result = await explain_service.generate_explanation_text(
                "Hi.", "en", "deepseek-flash", "direct"
            )
            messages = complete_mock.call_args.args[2]
            assert messages[0]["role"] == "system"
            assert messages[1] == {"role": "user", "content": "请讲解下面这句话：\nHi."}
            assert "internal reasoning" in messages[0]["content"]
            return result

    assert asyncio.run(run())[0].content


def test_explain_full_database_zero_paid_calls(tmp_path, monkeypatch):
    import sqlite3
    from app.services import explain_service, history_service

    test_db = tmp_path / "test_explain.db"
    monkeypatch.setattr(history_service, "DB_PATH", test_db)
    monkeypatch.setattr(history_service, "_initialized", False)
    monkeypatch.setattr(explain_service, "_initialized", False)
    monkeypatch.setattr(settings, "EXPLANATION_MAX_RECORDS", 1)

    key_existing = build_explain_key("existing sentence", "zh", "deepseek-flash", "direct")
    explain_service.save_explanation(
        TEST_CLIENT, "existing sentence", "zh", key_existing, "existing explanation",
        model_id="deepseek-flash", mode_id="direct",
    )

    with patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock) as synth:
        synth.return_value = generated()
        # Two requests for new text on full database
        res1 = client.post("/api/explain", json={"text": "brand new sentence 1", "lang": "zh"}, headers={"X-Client-ID": TEST_CLIENT})
        res2 = client.post("/api/explain", json={"text": "brand new sentence 2", "lang": "zh"}, headers={"X-Client-ID": TEST_CLIENT})

        assert res1.status_code == 507
        assert res2.status_code == 507
        # Upstream model must NEVER have been called!
        assert synth.await_count == 0

    # Ensure no usage was recorded in copilot_usage_daily
    with sqlite3.connect(test_db) as conn:
        row = conn.execute("select sum(calls) from copilot_usage_daily").fetchone()
        assert row[0] is None or row[0] == 0

    # Cache hit for existing explanation must still work when database is full
    hit_res = client.post("/api/explain", json={"text": "existing sentence", "lang": "zh"}, headers={"X-Client-ID": TEST_CLIENT})
    assert hit_res.status_code == 200
    assert hit_res.json()["cached"] is True


def test_storage_reservation_contention_and_cleanup(tmp_path, monkeypatch):
    import time
    from app.services import explain_service, history_service
    from app.services.errors import StorageFullError

    test_db = tmp_path / "test_res.db"
    monkeypatch.setattr(history_service, "DB_PATH", test_db)
    monkeypatch.setattr(history_service, "_initialized", False)
    monkeypatch.setattr(explain_service, "_initialized", False)
    monkeypatch.setattr(settings, "EXPLANATION_MAX_RECORDS", 1)

    # 1. Reserve single available slot
    token1 = explain_service.reserve_storage_slot("alice", "key-1", ttl_seconds=60)
    assert token1 != ""

    # 2. Competing request for another key should be rejected before calling model
    with pytest.raises(StorageFullError):
        explain_service.reserve_storage_slot("bob", "key-2", ttl_seconds=60)

    # 3. Release slot on failure / cancellation
    explain_service.release_storage_slot(token1)

    # 4. Now bob can reserve
    token2 = explain_service.reserve_storage_slot("bob", "key-2", ttl_seconds=60)
    assert token2 != ""

    # 5. Expired reservations are automatically purged
    explain_service.release_storage_slot(token2)
    # Insert an expired reservation
    with explain_service._get_conn() as conn:
        conn.execute(
            "insert into explanation_storage_reservations (token, client_id, explain_key, expires_at) values (?, ?, ?, ?)",
            ("expired-tok", "carol", "key-3", time.time() - 10),
        )
        conn.commit()

    token3 = explain_service.reserve_storage_slot("dave", "key-4", ttl_seconds=60)
    assert token3 != ""
    explain_service.release_storage_slot(token3)


def test_save_explanation_retries_transient_locked_database(tmp_path, monkeypatch):
    import sqlite3
    from contextlib import contextmanager
    from app.services import explain_service, history_service

    test_db = tmp_path / "test_retry.db"
    monkeypatch.setattr(history_service, "DB_PATH", test_db)
    monkeypatch.setattr(history_service, "_initialized", False)
    monkeypatch.setattr(explain_service, "_initialized", False)

    key = build_explain_key("retry sentence", "zh")
    original_get_conn = explain_service._get_conn
    attempts = 0

    @contextmanager
    def flakey_conn():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise sqlite3.OperationalError("database is locked")
        with original_get_conn() as conn:
            yield conn

    monkeypatch.setattr(explain_service, "_get_conn", flakey_conn)

    explain_service.save_explanation(
        TEST_CLIENT, "retry sentence", "zh", key, "saved explanation after retry",
        model_id="deepseek-flash", mode_id="direct", quota_units=1, usage={"total_tokens": 10},
    )

    assert attempts >= 2
    monkeypatch.setattr(explain_service, "_get_conn", original_get_conn)
    stored = explain_service.get_explanation(TEST_CLIENT, key)
    assert stored is not None
    assert stored["explanation"] == "saved explanation after retry"
