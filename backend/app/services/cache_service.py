import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from cachetools import LRUCache

from app.config import settings
from app.services.engines.base import SentenceCue
from app.services.errors import StorageFullError, TTSUpstreamError
from app.validation import CACHE_KEY_PATTERN

logger = logging.getLogger(__name__)
CACHE_DIR = Path(__file__).resolve().parent.parent / "cache" / "audio"
_lock = threading.RLock()
_memory_cache: LRUCache = LRUCache(maxsize=settings.MEMORY_CACHE_MAX_BYTES, getsizeof=len)
_flow_cache: LRUCache = LRUCache(
    maxsize=settings.MEMORY_CACHE_MAX_BYTES,
    getsizeof=lambda value: len(json.dumps(value, ensure_ascii=False).encode("utf-8")),
)


def compute_cache_key(text: str, voice: str, engine: str) -> str:
    raw = json.dumps(["audio-v2", text, voice, engine], ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def compute_flow_cache_key(text: str, voice: str, engine: str) -> str:
    raw = json.dumps(["sentence-flow-v2", text, voice, engine], ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _path(key: str, suffix: str) -> Path:
    if not re.fullmatch(CACHE_KEY_PATTERN, key):
        raise ValueError("Invalid cache key")
    root = CACHE_DIR.resolve()
    path = root / f"{key}{suffix}"
    if path.is_symlink() or path.resolve().parent != root:
        raise ValueError("Invalid cache path")
    return path


def _remember(key: str, audio: bytes, timeline: dict | None = None) -> None:
    if len(audio) <= _memory_cache.maxsize:
        _memory_cache[key] = audio
    if timeline is not None and _flow_cache.getsizeof(timeline) <= _flow_cache.maxsize:
        _flow_cache[key] = timeline


def _delete(key: str) -> None:
    paths = [_path(key, ".mp3"), _path(key, ".timeline.json")]
    for path in paths:
        path.unlink(missing_ok=True)
    _memory_cache.pop(key, None)
    _flow_cache.pop(key, None)


def _entries() -> list[tuple[float, str, int]]:
    entries = []
    for audio in CACHE_DIR.glob("*.mp3"):
        key = audio.stem
        if not re.fullmatch(CACHE_KEY_PATTERN, key) or audio.is_symlink():
            continue
        timeline = _path(key, ".timeline.json")
        stat = audio.stat()
        size = stat.st_size + (timeline.stat().st_size if timeline.exists() else 0)
        entries.append((stat.st_mtime, key, size))
    return sorted(entries)


def _make_room(incoming: int = 0, new_entries: int = 0) -> None:
    if incoming > settings.CACHE_MAX_BYTES:
        raise StorageFullError("Audio exceeds cache capacity")
    now = time.time()
    entries = []
    for modified, key, size in _entries():
        if now - modified >= settings.CACHE_TTL_SECONDS:
            _delete(key)
        else:
            entries.append((modified, key, size))
    total = sum(entry[2] for entry in entries)
    free = shutil.disk_usage(CACHE_DIR).free
    while entries and (
        total + incoming > settings.CACHE_MAX_BYTES
        or len(entries) + new_entries > settings.CACHE_MAX_ENTRIES
        or free - incoming < settings.CACHE_MIN_FREE_BYTES
    ):
        _, key, size = entries.pop(0)
        _delete(key)
        total -= size
        free = shutil.disk_usage(CACHE_DIR).free
    if free - incoming < settings.CACHE_MIN_FREE_BYTES:
        raise StorageFullError("Insufficient free disk space")


def cleanup_cache() -> None:
    """Enforce retention and quotas; discard incomplete writes after a restart."""
    with _lock:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        for path in CACHE_DIR.iterdir():
            if path.is_symlink() or not path.is_file():
                continue
            if re.fullmatch(r"[0-9a-f]{16}\.(?:mp3|timeline\.json)\.tmp_[0-9a-f]+", path.name):
                path.unlink()
            elif re.fullmatch(r"[0-9a-f]{16}\.timeline\.json", path.name):
                if not _path(path.name[:16], ".mp3").exists():
                    path.unlink()
        _make_room()


def get_cached_audio(cache_key: str) -> bytes | None:
    with _lock:
        path = _path(cache_key, ".mp3")
        if not path.exists():
            _memory_cache.pop(cache_key, None)
            _flow_cache.pop(cache_key, None)
            return None
        stat = path.stat()
        if time.time() - stat.st_mtime >= settings.CACHE_TTL_SECONDS or not 0 < stat.st_size <= settings.MAX_AUDIO_BYTES:
            _delete(cache_key)
            return None
        if cache_key in _memory_cache:
            return _memory_cache[cache_key]
        audio = path.read_bytes()
        _remember(cache_key, audio)
        return audio


def get_cached_flow(cache_key: str) -> tuple[bytes, dict] | None:
    with _lock:
        timeline_path = _path(cache_key, ".timeline.json")
        audio = get_cached_audio(cache_key)
        if audio is None or not timeline_path.exists():
            return None
        if cache_key in _flow_cache:
            return audio, _flow_cache[cache_key]
        if timeline_path.stat().st_size > settings.MAX_REQUEST_BODY_BYTES * 8:
            return None
        try:
            data = json.loads(timeline_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("audio_sha256") != hashlib.sha256(audio).hexdigest():
                return None
            cues = data.get("sentences")
            if not isinstance(cues, list) or any(
                not isinstance(cue, dict) or not isinstance(cue.get("text"), str)
                or not isinstance(cue.get("start_ms"), int) or not isinstance(cue.get("end_ms"), int)
                or not 0 <= cue["start_ms"] <= cue["end_ms"] for cue in cues
            ):
                return None
        except (ValueError, UnicodeError):
            logger.warning("Invalid timeline cache key=%s", cache_key)
            return None
        _remember(cache_key, audio, data)
        return audio, data


def _write_temp(path: Path, data: bytes) -> None:
    with path.open("xb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def _put(cache_key: str, audio: bytes, timeline: dict | None = None) -> None:
    if not 0 < len(audio) <= settings.MAX_AUDIO_BYTES:
        raise TTSUpstreamError(502, "Invalid audio size")
    with _lock:
        audio_path = _path(cache_key, ".mp3")
        timeline_path = _path(cache_key, ".timeline.json")
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # Published entries are immutable: an earlier manifest keeps its audio.
        if timeline is None and get_cached_audio(cache_key) is not None:
            return
        if timeline is not None and get_cached_flow(cache_key) is not None:
            return
        _delete(cache_key)
        metadata = json.dumps(timeline, ensure_ascii=False).encode("utf-8") if timeline is not None else b""
        _make_room(len(audio) + len(metadata), 1)
        nonce = uuid.uuid4().hex
        audio_temp = audio_path.with_name(f"{audio_path.name}.tmp_{nonce}")
        timeline_temp = timeline_path.with_name(f"{timeline_path.name}.tmp_{nonce}")
        try:
            _write_temp(audio_temp, audio)
            if timeline is not None:
                _write_temp(timeline_temp, metadata)
            audio_temp.replace(audio_path)
            if timeline is not None:
                timeline_temp.replace(timeline_path)
        except BaseException:
            _delete(cache_key)
            raise
        finally:
            audio_temp.unlink(missing_ok=True)
            timeline_temp.unlink(missing_ok=True)
        # Do not expose a memory hit until both files have been committed.
        _remember(cache_key, audio, timeline)
        logger.info("Cached audio key=%s bytes=%d", cache_key, len(audio))


def put_audio_cache(cache_key: str, audio_bytes: bytes) -> None:
    _put(cache_key, audio_bytes)


def put_flow_cache(
    cache_key: str, audio_bytes: bytes, engine: str, voice: str,
    sentences: list[SentenceCue] | list[dict],
) -> None:
    cues = []
    for index, cue in enumerate(sentences):
        value = vars(cue) if isinstance(cue, SentenceCue) else cue
        cues.append({"index": index, "text": value["text"], "start_ms": value["start_ms"], "end_ms": value["end_ms"]})
    _put(cache_key, audio_bytes, {
        "version": 1, "engine": engine, "voice": voice,
        "audio_sha256": hashlib.sha256(audio_bytes).hexdigest(), "sentences": cues,
    })


def delete_audio_cache(cache_key: str) -> None:
    with _lock:
        _delete(cache_key)


def delete_audio_caches(cache_keys: list[str]) -> None:
    for key in cache_keys:
        delete_audio_cache(key)
