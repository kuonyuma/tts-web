import sqlite3
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

from app.main import app
from app.services.explain_service import (
    TTSConfigError,
    TTSUpstreamError,
    build_explain_key,
)
from app.services.history_service import DB_PATH

client = TestClient(app)

TEST_CLIENT = "test-explain-client"


def _cleanup_test_rows():
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute("delete from explanations where client_id = ?", (TEST_CLIENT,))
        conn.commit()
    except sqlite3.OperationalError:
        pass
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def _isolate_db():
    _cleanup_test_rows()
    yield
    _cleanup_test_rows()


@patch("app.api.explain.save_explanation")
@patch("app.api.explain.get_explanation", return_value=None)
@patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock)
def test_explain_success_miss(mock_generate, mock_get, mock_save):
    """Verify a new sentence triggers model generation and returns uncached result"""
    mock_generate.return_value = "1. 中文翻译：经常锻炼的人更长寿。"

    response = client.post(
        "/api/explain",
        json={"text": "People who exercise regularly are more likely to live longer.", "lang": "zh"},
        headers={"X-Client-ID": TEST_CLIENT, "X-Gemini-Api-Key": "test-key"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["cached"] is False
    assert data["lang"] == "zh"
    assert "更长寿" in data["explanation"]
    assert data["messages"] == []
    assert len(data["explain_key"]) == 16
    mock_generate.assert_awaited_once()
    assert mock_generate.call_args[1]["lang"] == "zh"
    assert mock_generate.call_args[1]["thinking_level"] == "medium"
    assert mock_generate.call_args[1]["api_key"] == "test-key"
    mock_save.assert_called_once()


@patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock)
@patch("app.api.explain.get_explanation")
def test_explain_cache_hit(mock_get, mock_generate):
    """Verify a stored explanation is returned without calling the model"""
    mock_get.return_value = {
        "text": "Hello world.",
        "lang": "zh",
        "explain_key": "abc123",
        "explanation": "stored explanation",
        "messages": [{"role": "user", "content": "why?"}],
        "created_at": "2026-01-01 00:00:00",
        "updated_at": "2026-01-01 00:00:00",
    }

    response = client.post(
        "/api/explain",
        json={"text": "Hello world.", "lang": "zh"},
        headers={"X-Client-ID": TEST_CLIENT},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["cached"] is True
    assert data["explanation"] == "stored explanation"
    assert data["messages"] == [{"role": "user", "content": "why?"}]
    mock_generate.assert_not_awaited()


@patch("app.api.explain.get_explanation", return_value=None)
@patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock)
def test_explain_missing_key(mock_generate, mock_get):
    """Verify missing API Key results in 400 with setup prompt"""
    mock_generate.side_effect = TTSConfigError("AI 讲解服务需要 API Key。")

    response = client.post(
        "/api/explain",
        json={"text": "Hello.", "lang": "zh"},
        headers={"X-Client-ID": TEST_CLIENT},
    )
    assert response.status_code == 400
    assert "API Key" in response.json()["detail"]


@patch("app.api.explain.get_explanation", return_value=None)
@patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock)
def test_explain_upstream_error(mock_generate, mock_get):
    """Verify upstream provider error results in 502"""
    mock_generate.side_effect = TTSUpstreamError(500, "Gemini Error")

    response = client.post(
        "/api/explain",
        json={"text": "Hello.", "lang": "en"},
        headers={"X-Client-ID": TEST_CLIENT},
    )
    assert response.status_code == 502
    assert "暂时不可用" in response.json()["detail"]


def test_explain_validation():
    """Verify empty text and unsupported lang are rejected with 422"""
    assert client.post("/api/explain", json={"text": ""}).status_code == 422
    assert client.post("/api/explain", json={"text": "   "}).status_code == 422
    assert client.post("/api/explain", json={"text": "Hi", "lang": "fr"}).status_code == 422
    assert client.post("/api/explain", json={"text": "Hi", "thinking_level": "ultra"}).status_code == 422
    assert client.post("/api/explain", json={"text": "あ" * 1001}).status_code == 422


@patch("app.api.explain.get_explanation")
def test_fetch_explanation_hit(mock_get):
    """Verify stored explanation lookup returns cached result"""
    mock_get.return_value = {
        "text": "Hello.",
        "lang": "ja",
        "explain_key": "k1",
        "explanation": "stored",
        "messages": [],
        "created_at": "",
        "updated_at": "",
    }
    response = client.get(
        "/api/explain",
        params={"text": "Hello.", "lang": "ja"},
        headers={"X-Client-ID": TEST_CLIENT},
    )
    assert response.status_code == 200
    assert response.json()["cached"] is True
    assert response.json()["explanation"] == "stored"


@patch("app.api.explain.get_explanation", return_value=None)
def test_fetch_explanation_miss(mock_get):
    """Verify lookup without archive returns 404 and never calls the model"""
    with patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock) as mock_gen:
        response = client.get(
            "/api/explain",
            params={"text": "Never explained.", "lang": "zh"},
            headers={"X-Client-ID": TEST_CLIENT},
        )
        assert response.status_code == 404
        mock_gen.assert_not_awaited()


@patch("app.api.explain.append_chat_messages")
@patch("app.api.explain.generate_chat_answer", new_callable=AsyncMock)
@patch("app.api.explain.get_explanation")
def test_chat_success(mock_get, mock_answer, mock_append):
    """Verify follow-up question returns an answer and persists the turn"""
    mock_get.return_value = {
        "text": "Hello world.",
        "lang": "zh",
        "explain_key": "key1",
        "explanation": "stored",
        "messages": [],
        "created_at": "",
        "updated_at": "",
    }
    mock_answer.return_value = "这是追问的回答。"
    mock_append.return_value = [
        {"role": "user", "content": "为什么用 are？"},
        {"role": "assistant", "content": "这是追问的回答。"},
    ]

    response = client.post(
        "/api/explain/chat",
        json={"explain_key": "key1", "message": "为什么用 are？"},
        headers={"X-Client-ID": TEST_CLIENT, "X-Gemini-Api-Key": "k"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["answer"] == "这是追问的回答。"
    assert data["explain_key"] == "key1"
    mock_append.assert_called_once_with(TEST_CLIENT, "key1", "为什么用 are？", "这是追问的回答。")


@patch("app.api.explain.get_explanation", return_value=None)
def test_chat_unknown_key(mock_get):
    """Verify chat on a missing session returns 404"""
    response = client.post(
        "/api/explain/chat",
        json={"explain_key": "nope", "message": "hi"},
        headers={"X-Client-ID": TEST_CLIENT},
    )
    assert response.status_code == 404


def test_chat_validation():
    """Verify empty follow-up message is rejected with 422"""
    assert client.post("/api/explain/chat", json={"explain_key": "k", "message": ""}).status_code == 422
    assert client.post("/api/explain/chat", json={"explain_key": "k", "message": "  "}).status_code == 422


def test_storage_roundtrip_and_isolation():
    """Verify real save/get/append flow and per-client isolation"""
    from app.services.explain_service import (
        save_explanation,
        get_explanation,
        append_chat_messages,
    )

    text = "Storage roundtrip sentence."
    key = build_explain_key(text, "zh")
    save_explanation(TEST_CLIENT, text, "zh", key, "explanation body")

    stored = get_explanation(TEST_CLIENT, key)
    assert stored is not None
    assert stored["explanation"] == "explanation body"
    assert stored["messages"] == []

    updated = append_chat_messages(TEST_CLIENT, key, "q1", "a1")
    assert updated == [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
    ]
    assert get_explanation(TEST_CLIENT, key)["messages"] == updated

    # Other clients cannot see this record; unknown keys return None
    assert get_explanation("someone-else", key) is None
    assert append_chat_messages(TEST_CLIENT, "missing", "q", "a") is None


@patch("app.api.explain.save_explanation")
@patch("app.api.explain.get_explanation", return_value=None)
@patch("app.api.explain.generate_explanation_text", new_callable=AsyncMock)
def test_explain_thinking_level_passthrough(mock_generate, mock_get, mock_save):
    """Verify thinking_level reaches the generation layer"""
    mock_generate.return_value = "deep explanation"

    response = client.post(
        "/api/explain",
        json={"text": "Hello world.", "lang": "en", "thinking_level": "high"},
        headers={"X-Client-ID": TEST_CLIENT},
    )
    assert response.status_code == 200
    assert mock_generate.call_args[1]["thinking_level"] == "high"


def test_explain_key_separates_thinking_levels():
    """Verify the same sentence with different thinking levels maps to different keys"""
    assert build_explain_key("Hello.", "zh", "low") != build_explain_key("Hello.", "zh", "high")
    assert build_explain_key("Hello.", "zh") == build_explain_key("Hello.", "zh", "medium")


def test_call_text_model_uses_interactions_api():
    """Verify the text path uses Interactions API with thinking_level generation config"""
    import asyncio
    from types import SimpleNamespace
    from app.config import settings
    from app.services import explain_service
    from app.services.explain_service import generate_explanation_text

    create_mock = AsyncMock(return_value=SimpleNamespace(output_text="  explained text  "))
    stub_client = SimpleNamespace(aio=SimpleNamespace(interactions=SimpleNamespace(create=create_mock)))

    async def _run():
        with patch.object(explain_service, "resolve_text_client", return_value=stub_client):
            return await generate_explanation_text("Hi.", "zh", api_key="k", thinking_level="high")

    assert asyncio.run(_run()) == "explained text"
    create_mock.assert_awaited_once()
    kwargs = create_mock.call_args[1]
    assert kwargs["model"] == settings.GEMINI_TEXT_MODEL
    assert "Hi." in kwargs["input"]
    assert kwargs["generation_config"] == {"thinking_level": "high"}


def test_call_text_model_empty_output():
    """Verify empty model output surfaces as an upstream error"""
    import asyncio
    from types import SimpleNamespace
    from app.services import explain_service
    from app.services.explain_service import generate_explanation_text

    create_mock = AsyncMock(return_value=SimpleNamespace(output_text="   "))
    stub_client = SimpleNamespace(aio=SimpleNamespace(interactions=SimpleNamespace(create=create_mock)))

    async def _run():
        with patch.object(explain_service, "resolve_text_client", return_value=stub_client):
            await generate_explanation_text("Hi.", "zh", api_key="k")

    with pytest.raises(TTSUpstreamError):
        asyncio.run(_run())
