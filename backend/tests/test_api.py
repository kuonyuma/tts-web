import io
import wave
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

from app.main import app
from app.services.tts_service import (
    TTSTimeoutError,
    TTSUpstreamError,
    TTSConfigError,
    pcm_to_wav,
)

client = TestClient(app)


def test_health_check():
    """Verify GET /health returns status: ok"""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_static_files_served():
    """Verify root / serves index.html and static assets are accessible"""
    response_index = client.get("/")
    assert response_index.status_code == 200
    assert "TTS Web" in response_index.text

    response_css = client.get("/style.css")
    assert response_css.status_code == 200
    assert "font-family" in response_css.text

    response_js = client.get("/app.js")
    assert response_js.status_code == 200
    assert "handleGenerateTTS" in response_js.text


def test_get_engines():
    """Verify GET /api/engines returns registered engines and their voices"""
    response = client.get("/api/engines")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 2
    engine_ids = [e["id"] for e in data]
    assert "edge" in engine_ids
    assert "gemini" in engine_ids

    edge_eng = next(e for e in data if e["id"] == "edge")
    assert edge_eng["is_free"] is True
    assert len(edge_eng["voices"]) >= 2
    assert any(v["id"] == "ja-JP-NanamiNeural" for v in edge_eng["voices"])

    gemini_eng = next(e for e in data if e["id"] == "gemini")
    assert gemini_eng["is_free"] is False
    assert len(gemini_eng["voices"]) >= 4
    assert any(v["id"] == "Kore" for v in gemini_eng["voices"])


def test_tts_empty_text():
    """Verify empty text is rejected with 422"""
    response = client.post("/api/tts", json={"text": ""})
    assert response.status_code == 422


def test_tts_whitespace_text():
    """Verify whitespace-only text is rejected with 422"""
    response = client.post("/api/tts", json={"text": "    "})
    assert response.status_code == 422


def test_tts_over_max_length():
    """Verify text exceeding 1000 chars is rejected with 422"""
    long_text = "あ" * 1001
    response = client.post("/api/tts", json={"text": long_text})
    assert response.status_code == 422


def test_pcm_to_wav():
    """Verify raw PCM bytes are properly converted to valid WAV header container"""
    dummy_pcm = b"\x00\x00" * 2400  # 0.1s of silence
    wav_bytes = pcm_to_wav(dummy_pcm, sample_rate=24000, channels=1, sample_width=2)
    assert wav_bytes.startswith(b"RIFF")
    assert b"WAVE" in wav_bytes

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 24000
        assert wf.getnframes() == 2400


@patch("app.api.tts.add_or_touch")
@patch("app.api.tts.put_audio_cache")
@patch("app.api.tts.get_cached_audio", return_value=None)
@patch("app.api.tts.synthesize", new_callable=AsyncMock)
def test_tts_edge_success(mock_synthesize, mock_cache_get, mock_cache_put, mock_history):
    """Verify valid Edge TTS synthesis returns audio/mpeg binary stream"""
    fake_audio = b"fake-mp3-audio-data"
    mock_synthesize.return_value = fake_audio

    response = client.post(
        "/api/tts",
        json={
            "text": "今日はいい天気ですね。",
            "engine": "edge",
            "voice": "ja-JP-NanamiNeural"
        },
        headers={"X-Client-ID": "test-user-1"}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["x-engine"] == "edge"
    assert response.content == fake_audio
    mock_synthesize.assert_awaited_once_with(
        text="今日はいい天気ですね。",
        voice="ja-JP-NanamiNeural",
        engine="edge",
        api_key=None,
    )
    assert mock_history.call_count == 1
    assert mock_history.call_args[0][0] == "test-user-1"


@patch("app.api.tts.add_or_touch")
@patch("app.api.tts.put_audio_cache")
@patch("app.api.tts.get_cached_audio", return_value=None)
@patch("app.api.tts.synthesize", new_callable=AsyncMock)
def test_tts_gemini_byok_header(mock_synthesize, mock_cache_get, mock_cache_put, mock_history):
    """Verify X-Gemini-Api-Key and X-Client-ID headers are handled properly"""
    fake_audio = b"fake-gemini-mp3-audio"
    mock_synthesize.return_value = fake_audio

    response = client.post(
        "/api/tts",
        json={"text": "こんにちは", "engine": "gemini", "voice": "Kore"},
        headers={
            "X-Gemini-Api-Key": "test-byok-key-123",
            "X-Client-ID": "test-user-2",
        }
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["x-engine"] == "gemini"
    assert response.content == fake_audio
    mock_synthesize.assert_awaited_once_with(
        text="こんにちは",
        voice="Kore",
        engine="gemini",
        api_key="test-byok-key-123",
    )
    assert mock_history.call_count == 1
    assert mock_history.call_args[0][0] == "test-user-2"


@patch("app.api.tts.synthesize", new_callable=AsyncMock)
def test_tts_config_error(mock_synthesize):
    """Verify missing Gemini API Key results in 400 Bad Request with setup prompt"""
    mock_synthesize.side_effect = TTSConfigError("Gemini TTS 服务需要 API Key。")

    response = client.post("/api/tts", json={"text": "こんにちは", "engine": "gemini"})
    assert response.status_code == 400
    assert "需要 API Key" in response.json()["detail"]


@patch("app.api.tts.synthesize", new_callable=AsyncMock)
def test_tts_timeout_error(mock_synthesize):
    """Verify timeout results in 502 Bad Gateway"""
    mock_synthesize.side_effect = TTSTimeoutError("Timeout")

    response = client.post("/api/tts", json={"text": "こんにちは"})
    assert response.status_code == 502
    assert "超时" in response.json()["detail"]


@patch("app.api.tts.synthesize", new_callable=AsyncMock)
def test_tts_upstream_error(mock_synthesize):
    """Verify upstream provider error results in 502 Bad Gateway"""
    mock_synthesize.side_effect = TTSUpstreamError(500, "Gemini Error")

    response = client.post("/api/tts", json={"text": "こんにちは"})
    assert response.status_code == 502
    assert "暂时不可用" in response.json()["detail"]


def test_test_key_empty():
    """Verify empty key test validation"""
    response = client.post("/api/tts/test-key", json={"api_key": ""})
    # Pydantic validation rejects min_length=1
    assert response.status_code == 422


@patch("app.api.history.clear_all_history", return_value=2)
def test_clear_all_history(mock_clear_history):
    """Verify DELETE /api/history clears all records for client"""
    response = client.delete("/api/history", headers={"X-Client-ID": "test-client-a"})
    assert response.status_code == 204
    mock_clear_history.assert_called_once_with(client_id="test-client-a")


def test_history_multi_client_isolation():
    """Verify end-to-end multi-tenant isolation between different clients"""
    from app.services.history_service import add_or_touch, list_history

    client_a = "client_alpha"
    client_b = "client_beta"

    # Add history for client A
    add_or_touch(client_a, "Alpha text 1", "ja-JP-NanamiNeural", "edge", "edge", "key_alpha_1")
    add_or_touch(client_a, "Alpha text 2", "ja-JP-NanamiNeural", "edge", "edge", "key_alpha_2")

    # Add history for client B
    add_or_touch(client_b, "Beta text 1", "ja-JP-KeitaNeural", "edge", "edge", "key_beta_1")

    # Client A requests history
    res_a = client.get("/api/history", headers={"X-Client-ID": client_a})
    assert res_a.status_code == 200
    records_a = res_a.json()
    assert len(records_a) == 2
    assert all("Alpha" in r["text"] for r in records_a)

    # Client B requests history
    res_b = client.get("/api/history", headers={"X-Client-ID": client_b})
    assert res_b.status_code == 200
    records_b = res_b.json()
    assert len(records_b) == 1
    assert "Beta" in records_b[0]["text"]

    # Client A tries to delete Client B's record (IDOR protection)
    b_id = records_b[0]["id"]
    del_unauth = client.delete(f"/api/history/{b_id}", headers={"X-Client-ID": client_a})
    assert del_unauth.status_code == 404

    # Client B's record should still be intact
    res_b_after = client.get("/api/history", headers={"X-Client-ID": client_b})
    assert len(res_b_after.json()) == 1

    # Client A clears all their history
    del_all_a = client.delete("/api/history", headers={"X-Client-ID": client_a})
    assert del_all_a.status_code == 204

    # Client A is empty
    res_a_after = client.get("/api/history", headers={"X-Client-ID": client_a})
    assert len(res_a_after.json()) == 0

    # Client B still has their record
    res_b_final = client.get("/api/history", headers={"X-Client-ID": client_b})
    assert len(res_b_final.json()) == 1


@patch("app.api.tts.add_or_touch")
@patch("app.api.tts.put_flow_cache")
@patch("app.api.tts.get_cached_flow", return_value=None)
@patch("app.api.tts.synthesize_with_timeline", new_callable=AsyncMock)
def test_tts_flow_edge_success(mock_synthesize, mock_cache_get, mock_cache_put, mock_history):
    """Verify POST /api/tts/flow returns manifest JSON with sentences."""
    from app.services.engines.base import SentenceCue, TimedSynthesisResult

    fake_result = TimedSynthesisResult(
        audio_bytes=b"fake-flow-audio",
        sentences=[
            SentenceCue(text="今日はいい天気です。", start_ms=100, end_ms=1640),
            SentenceCue(text="散歩に行きましょう！", start_ms=1640, end_ms=3420),
        ]
    )
    mock_synthesize.return_value = fake_result

    response = client.post(
        "/api/tts/flow",
        json={
            "text": "今日はいい天気です。散歩に行きましょう！",
            "engine": "edge",
            "voice": "ja-JP-NanamiNeural",
        },
        headers={"X-Client-ID": "flow-client-1"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["version"] == 1
    assert data["engine"] == "edge"
    assert data["cached"] is False
    assert data["timeline_available"] is True
    assert data["audio_url"].startswith("/api/tts/")
    assert len(data["sentences"]) == 2
    assert data["sentences"][0] == {
        "index": 0,
        "text": "今日はいい天気です。",
        "start_ms": 100,
        "end_ms": 1640,
    }
    assert data["sentences"][1]["index"] == 1
    mock_history.assert_called_once()


def test_tts_flow_gemini_unsupported_422():
    """Verify POST /api/tts/flow rejects engines without timeline support with 422."""
    response = client.post(
        "/api/tts/flow",
        json={
            "text": "こんにちは",
            "engine": "gemini",
        }
    )
    assert response.status_code == 422
    assert "暂不支持句子时间轴" in response.json()["detail"]


@patch("app.api.tts.touch")
@patch("app.api.tts.get_cached_flow")
def test_tts_flow_get_manifest(mock_get_cached_flow, mock_touch):
    """Verify GET /api/tts/flow/{cache_key} returns cached timeline."""
    fake_timeline = {
        "version": 1,
        "engine": "edge",
        "voice": "ja-JP-NanamiNeural",
        "audio_sha256": "abc",
        "sentences": [{"index": 0, "text": "テスト", "start_ms": 0, "end_ms": 500}],
    }
    mock_get_cached_flow.return_value = (b"fake-audio", fake_timeline)

    response = client.get("/api/tts/flow/test_key_123", headers={"X-Client-ID": "test-c"})
    assert response.status_code == 200
    data = response.json()
    assert data["cache_key"] == "test_key_123"
    assert data["cached"] is True
    assert data["timeline_available"] is True
    assert len(data["sentences"]) == 1
    mock_touch.assert_called_once_with("test-c", "test_key_123")


def test_tts_flow_get_manifest_not_found():
    """Verify GET /api/tts/flow/{cache_key} returns 404 on cache miss."""
    response = client.get("/api/tts/flow/nonexistent_key_999")
    assert response.status_code == 404

