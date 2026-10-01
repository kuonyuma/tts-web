"""Routes must use the injected business service for every audio/history operation."""

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.private_tts_adapter import PrivateTTSStorage
from app.services.private_tts_storage import PrivateTTSStore
from app.services.tts_service import TTSService, get_tts_service


def test_all_audio_and_history_routes_use_the_injected_store(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", "legacy")
    store = PrivateTTSStore(tmp_path / "injected.db", tmp_path / "injected_audio")
    business = TTSService(PrivateTTSStorage(store))
    app.dependency_overrides[get_tts_service] = lambda: business
    try:
        with TestClient(app, headers={"X-Client-ID": "alice"}) as client:
            with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"original") as synth:
                payload = {"text": "hello", "engine": "gemini"}
                created = client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"})
                assert created.status_code == 200
                key = created.headers["X-Cache-Key"]
                assert len(key) == 64
                assert created.headers["Cache-Control"] == "private, no-store"
                assert client.post("/api/tts", json=payload).headers["X-Cache"] == "HIT"
                assert client.get(f"/api/tts/{key}").content == b"original"
                manifest = client.get(f"/api/tts/flow/{key}")
                assert manifest.status_code == 200
                assert manifest.json()["engine"] == "gemini"
                history = client.get("/api/history").json()
                assert history[0]["cache_key"] == key
                assert store.list_history("alice")[0]["cache_key"] == key
                assert client.delete(f"/api/history/{history[0]['id']}").status_code == 204
                assert client.get(f"/api/tts/{key}").status_code == 404
                assert client.get("/api/history").json() == []
                assert client.post("/api/tts", json=payload, headers={"X-Gemini-Api-Key": "byok"}).status_code == 200
                assert client.delete("/api/history").status_code == 204
                assert store.list_history("alice") == []
                assert synth.await_count == 2
    finally:
        app.dependency_overrides.pop(get_tts_service, None)


def test_flow_post_uses_injected_storage_timeline_policy(tmp_path, monkeypatch):
    from app.services.engines.base import SentenceCue, TimedSynthesisResult

    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", "legacy")
    store = PrivateTTSStore(tmp_path / "injected.db", tmp_path / "injected_audio")
    app.dependency_overrides[get_tts_service] = lambda: TTSService(PrivateTTSStorage(store))
    try:
        with TestClient(app, headers={"X-Client-ID": "alice"}) as client:
            timed = TimedSynthesisResult(b"audio", [SentenceCue("hello", 0, 100)])
            with patch("app.services.engines.edge_engine.EdgeTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"plain"):
                with patch("app.services.engines.edge_engine.EdgeTTSEngine.synthesize_with_timeline", new_callable=AsyncMock, return_value=timed) as synth:
                    created = client.post("/api/tts", json={"text": "hello"})
                    flow = client.post("/api/tts/flow", json={"text": "hello"})
                    assert flow.status_code == 200
                    assert flow.json()["cache_key"] == created.headers["X-Cache-Key"]
                    assert flow.json()["cached"]
                    assert flow.json()["sentences"][0]["end_ms"] == 100
                    synth.assert_awaited_once()
    finally:
        app.dependency_overrides.pop(get_tts_service, None)
