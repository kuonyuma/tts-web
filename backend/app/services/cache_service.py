import hashlib
import json
import logging
import uuid
from pathlib import Path

from cachetools import LRUCache
from app.services.engines.base import SentenceCue

logger = logging.getLogger(__name__)

# Cache directory: backend/cache/audio/
CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "audio"

# In-memory LRU cache: max 100 entries (~8MB for typical MP3 files)
_memory_cache: LRUCache = LRUCache(maxsize=100)
# In-memory LRU cache for timeline JSON sidecars
_flow_cache: LRUCache = LRUCache(maxsize=100)


def compute_cache_key(text: str, voice: str, engine: str) -> str:
    """Generate a short hash key from text + voice + engine combination."""
    raw = f"{text}|{voice}|{engine}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def compute_flow_cache_key(text: str, voice: str, engine: str) -> str:
    """Generate a dedicated cache key for full text + sentence timeline."""
    raw = f"{text}|{voice}|{engine}|sentence-flow-v1"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def get_cached_audio(cache_key: str) -> bytes | None:
    """Try to get cached audio from memory, then disk. Returns None on miss."""
    # Check memory first
    if cache_key in _memory_cache:
        logger.info("Cache hit (memory) for key=%s", cache_key)
        return _memory_cache[cache_key]

    # Check disk
    file_path = CACHE_DIR / f"{cache_key}.mp3"
    if file_path.exists():
        audio_bytes = file_path.read_bytes()
        _memory_cache[cache_key] = audio_bytes  # promote to memory
        logger.info("Cache hit (disk) for key=%s", cache_key)
        return audio_bytes

    logger.info("Cache miss for key=%s", cache_key)
    return None


def get_cached_flow(cache_key: str) -> tuple[bytes, dict] | None:
    """
    Retrieve paired audio and timeline sidecar.
    Returns (audio_bytes, timeline_dict) only if both exist and sha256 matches.
    """
    # Check memory first if both are present
    if cache_key in _memory_cache and cache_key in _flow_cache:
        logger.info("Flow cache hit (memory) for key=%s", cache_key)
        return _memory_cache[cache_key], _flow_cache[cache_key]

    audio_path = CACHE_DIR / f"{cache_key}.mp3"
    timeline_path = CACHE_DIR / f"{cache_key}.timeline.json"

    if not audio_path.exists() or not timeline_path.exists():
        logger.info("Flow cache miss (missing file) for key=%s", cache_key)
        return None

    try:
        audio_bytes = audio_path.read_bytes()
        timeline_data = json.loads(timeline_path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed reading flow cache files for key=%s: %s", cache_key, exc)
        return None

    expected_sha256 = timeline_data.get("audio_sha256")
    actual_sha256 = hashlib.sha256(audio_bytes).hexdigest()
    if not expected_sha256 or expected_sha256 != actual_sha256:
        logger.warning("Flow cache sha256 mismatch for key=%s, treating as miss", cache_key)
        return None

    _memory_cache[cache_key] = audio_bytes
    _flow_cache[cache_key] = timeline_data
    logger.info("Flow cache hit (disk) for key=%s", cache_key)
    return audio_bytes, timeline_data


def put_audio_cache(cache_key: str, audio_bytes: bytes) -> None:
    """Store audio in both memory and disk cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _memory_cache[cache_key] = audio_bytes
    temp_file = CACHE_DIR / f"{cache_key}.mp3.tmp_{uuid.uuid4().hex[:8]}"
    temp_file.write_bytes(audio_bytes)
    target_file = CACHE_DIR / f"{cache_key}.mp3"
    temp_file.replace(target_file)
    logger.info("Cached audio for key=%s (size=%d bytes)", cache_key, len(audio_bytes))


def put_flow_cache(
    cache_key: str,
    audio_bytes: bytes,
    engine: str,
    voice: str,
    sentences: list[SentenceCue] | list[dict],
) -> None:
    """Store paired audio and timeline sidecar atomically."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    audio_sha256 = hashlib.sha256(audio_bytes).hexdigest()

    formatted_sentences = []
    for idx, s in enumerate(sentences):
        if hasattr(s, "text"):
            formatted_sentences.append({
                "index": idx,
                "text": s.text,
                "start_ms": s.start_ms,
                "end_ms": s.end_ms,
            })
        elif isinstance(s, dict):
            formatted_sentences.append({
                "index": idx,
                "text": s["text"],
                "start_ms": s["start_ms"],
                "end_ms": s["end_ms"],
            })

    timeline_data = {
        "version": 1,
        "engine": engine,
        "voice": voice,
        "audio_sha256": audio_sha256,
        "sentences": formatted_sentences,
    }

    # Write MP3 atomically
    temp_audio = CACHE_DIR / f"{cache_key}.mp3.tmp_{uuid.uuid4().hex[:8]}"
    temp_audio.write_bytes(audio_bytes)
    target_audio = CACHE_DIR / f"{cache_key}.mp3"
    temp_audio.replace(target_audio)

    # Write timeline atomically
    temp_timeline = CACHE_DIR / f"{cache_key}.timeline.json.tmp_{uuid.uuid4().hex[:8]}"
    temp_timeline.write_text(json.dumps(timeline_data, ensure_ascii=False, indent=2), encoding="utf-8")
    target_timeline = CACHE_DIR / f"{cache_key}.timeline.json"
    temp_timeline.replace(target_timeline)

    _memory_cache[cache_key] = audio_bytes
    _flow_cache[cache_key] = timeline_data
    logger.info("Cached paired audio and timeline for key=%s (sentences=%d)", cache_key, len(formatted_sentences))


def delete_audio_cache(cache_key: str) -> None:
    """Remove audio and timeline from both memory and disk cache."""
    _memory_cache.pop(cache_key, None)
    _flow_cache.pop(cache_key, None)
    file_path = CACHE_DIR / f"{cache_key}.mp3"
    if file_path.exists():
        file_path.unlink()
        logger.info("Deleted cached audio for key=%s", cache_key)
    timeline_path = CACHE_DIR / f"{cache_key}.timeline.json"
    if timeline_path.exists():
        timeline_path.unlink()
        logger.info("Deleted cached timeline for key=%s", cache_key)


def delete_audio_caches(cache_keys: list[str]) -> None:
    """Batch remove audio cache entries."""
    for key in cache_keys:
        delete_audio_cache(key)

