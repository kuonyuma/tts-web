import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.errors import LLMConfigError, LLMUpstreamError
from app.services.explain_service import build_explain_key
from app.services.llm.types import LLMResult


client = TestClient(app, headers={"X-Client-ID": "test-client"})
TEST_CLIENT = "test-explain-client"


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
