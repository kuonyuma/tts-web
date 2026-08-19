import hashlib
import logging
from pathlib import Path

from cachetools import LRUCache

logger = logging.getLogger(__name__)

# Cache directory: backend/cache/audio/
CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "audio"

# In-memory LRU cache: max 100 entries (~8MB for typical MP3 files)
_memory_cache: LRUCache = LRUCache(maxsize=100)


def compute_cache_key(text: str, voice: str, engine: str) -> str:
    """Generate a short hash key from text + voice + engine combination."""
    raw = f"{text}|{voice}|{engine}"
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


def put_audio_cache(cache_key: str, audio_bytes: bytes) -> None:
    """Store audio in both memory and disk cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _memory_cache[cache_key] = audio_bytes
    file_path = CACHE_DIR / f"{cache_key}.mp3"
    file_path.write_bytes(audio_bytes)
    logger.info("Cached audio for key=%s (size=%d bytes)", cache_key, len(audio_bytes))


def delete_audio_cache(cache_key: str) -> None:
    """Remove audio from both memory and disk cache."""
    _memory_cache.pop(cache_key, None)
    file_path = CACHE_DIR / f"{cache_key}.mp3"
    if file_path.exists():
        file_path.unlink()
        logger.info("Deleted cached audio for key=%s", cache_key)


def delete_audio_caches(cache_keys: list[str]) -> None:
    """Batch remove audio cache entries."""
    for key in cache_keys:
        delete_audio_cache(key)
