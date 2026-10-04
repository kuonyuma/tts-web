from app.services import database as database_service
"""Business behavior with real isolated storage and mocked network synthesis."""

import sqlite3
from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest

from app.config import settings
from app.schemas.tts import TTSRequest
from app.services import private_tts_storage, tts_service
from app.services.engines.base import SentenceCue, TimedSynthesisResult
from app.services.errors import StorageFullError, TTSConfigError, TTSNotFoundError, TTSAudioTooLargeError


@pytest.fixture(params=["legacy", "private"])
def service(request, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", request.param)
    store = private_tts_storage.PrivateTTSStore(tmp_path / "history.db", tmp_path / "private_audio")
    monkeypatch.setattr(private_tts_storage, "_store", store)
    return request.param, store


def unified_service():
    assert hasattr(tts_service, "get_tts_service"), "TTS requests need a unified business entry"
    return tts_service.get_tts_service()


@pytest.mark.anyio
async def test_generation_cache_hit_records_each_owner_without_rebilling(service):
    mode, _ = service
    business = unified_service()
    request = TTSRequest(text="hello", engine="gemini")
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"audio") as synth:
        first = await business.generate("alice", request, "byok")
        again = await business.generate("alice", request, None)
        assert first.asset.audio == again.asset.audio == b"audio"
        assert first.cached is False and again.cached is True
        assert first.key == again.key
        assert len(await business.list_history("alice")) == 1
        assert await business.list_history("bob") == []
        if mode == "private":
            with pytest.raises(TTSConfigError):
                await business.generate("bob", request, None)
            other = await business.generate("bob", request, "byok")
            assert other.cached is False
            assert synth.await_count == 2
        else:
            other = await business.generate("bob", request, None)
            assert other.cached is True
            assert synth.await_count == 1
        assert len(await business.list_history("bob")) == 1


@pytest.mark.anyio
async def test_timeline_policy_preserves_each_storage_contract(service):
    mode, _ = service
    business = unified_service()
    request = TTSRequest(text="hello")
    timed = TimedSynthesisResult(b"timed", [SentenceCue("hello", 0, 100)])
    with patch("app.services.engines.edge_engine.EdgeTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"plain") as plain:
        with patch("app.services.engines.edge_engine.EdgeTTSEngine.synthesize_with_timeline", new_callable=AsyncMock, return_value=timed) as timeline:
            first = await business.generate("alice", request, None)
            flow = await business.generate("alice", request, None, flow=True)
            repeat = await business.generate("alice", request, None, flow=True)
    assert flow.asset.sentences == [{"index": 0, "text": "hello", "start_ms": 0, "end_ms": 100}]
    assert repeat.cached and repeat.asset.audio == b"timed"
    assert timeline.await_count == 1
    assert (first.key == flow.key) is (mode == "private")
    assert plain.await_count == (0 if mode == "private" else 1)


@pytest.mark.anyio
async def test_replay_never_synthesizes_and_history_delete_obeys_ownership(service):
    mode, _ = service
    business = unified_service()
    request = TTSRequest(text="hello", engine="gemini")
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"original") as synth:
        created = await business.generate("alice", request, "byok")
        replayed = await business.replay("alice", created.key)
        assert replayed.cached and replayed.asset.audio == b"original"
        assert replayed.cache_control == ("private, no-store" if mode == "private" else "no-cache")
        history = await business.list_history("alice")
        assert await business.delete_history("bob", history[0]["id"]) is False
        assert await business.delete_history("alice", history[0]["id"]) is True
        assert await business.list_history("alice") == []
        if mode == "private":
            with pytest.raises(TTSNotFoundError):
                await business.replay("alice", created.key)
        else:
            assert (await business.replay("bob", created.key)).asset.audio == b"original"
        synth.assert_awaited_once()


@pytest.mark.anyio
async def test_save_failure_does_not_report_success_or_create_history(service):
    business = unified_service()
    request = TTSRequest(text="hello", engine="gemini")
    with patch.object(business.storage, "save", side_effect=StorageFullError("full")):
        with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, return_value=b"audio"):
            with pytest.raises(StorageFullError):
                await business.generate("alice", request, "byok")
    assert await business.list_history("alice") == []


@pytest.mark.anyio
async def test_oversized_upstream_audio_preserves_storage_error_policy(service):
    mode, _ = service
    business = unified_service()
    request = TTSRequest(text="hello", engine="gemini")
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock, side_effect=TTSAudioTooLargeError):
        with pytest.raises(StorageFullError if mode == "private" else TTSAudioTooLargeError):
            await business.generate("alice", request, "byok")
    assert await business.list_history("alice") == []


@pytest.mark.anyio
async def test_private_manifest_read_does_not_touch_playback_time(service):
    mode, _ = service
    business = unified_service()
    timed = TimedSynthesisResult(b"audio", [])
    with patch("app.services.engines.edge_engine.EdgeTTSEngine.synthesize_with_timeline", new_callable=AsyncMock, return_value=timed):
        result = await business.generate("alice", TTSRequest(text="hello"), None, flow=True)
    table = "tts_history_v2" if mode == "private" else "history"
    with sqlite3.connect(database_service.DB_PATH) as connection:
        connection.execute(f"update {table} set last_played_at='2000-01-01 00:00:00'")
    await business.replay("alice", result.key, flow=True)
    history = await business.list_history("alice")
    retained_time = datetime(2000, 1, 1).astimezone().isoformat()
    assert (history[0]["last_played_at"] == retained_time) is (mode == "private")
    # A synthesis cache hit is an access, even though lookup itself does not touch.
    with patch("app.services.engines.edge_engine.EdgeTTSEngine.synthesize_with_timeline", new_callable=AsyncMock, side_effect=AssertionError("cache hit must not synthesize")):
        assert (await business.generate("alice", TTSRequest(text="hello"), None, flow=True)).cached
    assert (await business.list_history("alice"))[0]["last_played_at"] != retained_time
