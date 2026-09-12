import json
import hashlib
import pytest
from pathlib import Path
from app.services.cache_service import (
    compute_cache_key,
    compute_flow_cache_key,
    get_cached_flow,
    put_flow_cache,
    delete_audio_cache,
    CACHE_DIR,
    _memory_cache,
    _flow_cache,
)
from app.services.engines.base import SentenceCue


@pytest.fixture(autouse=True)
def clean_test_cache():
    test_key = "test_flow_key_99"
    delete_audio_cache(test_key)
    _memory_cache.pop(test_key, None)
    _flow_cache.pop(test_key, None)
    yield
    delete_audio_cache(test_key)
    _memory_cache.pop(test_key, None)
    _flow_cache.pop(test_key, None)


def test_flow_cache_key_distinct():
    """Verify compute_flow_cache_key produces a different key from regular compute_cache_key."""
    k1 = compute_cache_key("こんにちは", "voice1", "edge")
    k2 = compute_flow_cache_key("こんにちは", "voice1", "edge")
    assert k1 != k2
    assert len(k2) == 16


def test_put_and_get_cached_flow():
    """Verify paired cache writing, reading, and sha256 validation."""
    test_key = "test_flow_key_99"
    audio = b"fake-paired-audio-stream"
    cues = [
        SentenceCue(text="こんにちは。", start_ms=0, end_ms=1000),
        SentenceCue(text="いい天気ですね。", start_ms=1000, end_ms=2500),
    ]

    put_flow_cache(test_key, audio, "edge", "ja-JP-NanamiNeural", cues)

    # Check files on disk
    mp3_file = CACHE_DIR / f"{test_key}.mp3"
    json_file = CACHE_DIR / f"{test_key}.timeline.json"
    assert mp3_file.exists()
    assert json_file.exists()

    # Verify get_cached_flow hits
    cached = get_cached_flow(test_key)
    assert cached is not None
    cached_audio, cached_data = cached
    assert cached_audio == audio
    assert cached_data["engine"] == "edge"
    assert cached_data["voice"] == "ja-JP-NanamiNeural"
    assert len(cached_data["sentences"]) == 2
    assert cached_data["sentences"][0]["text"] == "こんにちは。"
    assert cached_data["sentences"][1]["end_ms"] == 2500


def test_get_cached_flow_detects_tampering():
    """Verify get_cached_flow treats sha256 mismatch as a cache miss."""
    test_key = "test_flow_key_99"
    audio = b"original-audio"
    cues = [SentenceCue(text="テスト", start_ms=0, end_ms=500)]

    put_flow_cache(test_key, audio, "edge", "voice1", cues)

    # Tamper with MP3 content on disk
    _memory_cache.pop(test_key, None)
    _flow_cache.pop(test_key, None)
    mp3_file = CACHE_DIR / f"{test_key}.mp3"
    mp3_file.write_bytes(b"tampered-audio")

    # Mismatch should yield miss
    assert get_cached_flow(test_key) is None


def test_get_cached_flow_missing_sidecar():
    """Verify get_cached_flow fails if JSON timeline sidecar is missing."""
    test_key = "test_flow_key_99"
    audio = b"some-audio"
    cues = [SentenceCue(text="テスト", start_ms=0, end_ms=500)]

    put_flow_cache(test_key, audio, "edge", "voice1", cues)

    _memory_cache.pop(test_key, None)
    _flow_cache.pop(test_key, None)
    json_file = CACHE_DIR / f"{test_key}.timeline.json"
    json_file.unlink()

    assert get_cached_flow(test_key) is None


def test_delete_audio_cache_removes_both():
    """Verify delete_audio_cache cleans up both the MP3 and the JSON sidecar."""
    test_key = "test_flow_key_99"
    put_flow_cache(test_key, b"audio", "edge", "voice", [SentenceCue("a", 0, 10)])

    mp3_file = CACHE_DIR / f"{test_key}.mp3"
    json_file = CACHE_DIR / f"{test_key}.timeline.json"
    assert mp3_file.exists() and json_file.exists()

    delete_audio_cache(test_key)
    assert not mp3_file.exists()
    assert not json_file.exists()
    assert test_key not in _memory_cache
    assert test_key not in _flow_cache
