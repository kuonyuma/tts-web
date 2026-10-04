"""Owner-scoped TTS audio and history for the opt-in private storage mode."""

import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from contextlib import AbstractContextManager

from cachetools import LRUCache

from app.config import settings
from app.services import database
from app.services.errors import AudioUnavailable, StorageFullError
from app.services.private_tts_migrations import migrate_private_tts
from app.services.timestamps import absolute_history_row, utc_timestamp
from app.services.tts_storage import synthesis_identity
from app.validation import PRIVATE_CACHE_KEY_PATTERN


KEY_PATTERN = re.compile(PRIVATE_CACHE_KEY_PATTERN)
logger = logging.getLogger(__name__)
_store = None
_store_lock = threading.Lock()


def compute_private_key(text: str, engine: str, voice: str, model: str, revision: str) -> str:
    material = json.dumps(
        ["private-audio-v1", *synthesis_identity(text, engine, voice, model, revision)],
        ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _matches_asset(path: Path, row: sqlite3.Row) -> bool:
    try:
        return (path.stat().st_size == row["byte_size"]
                and hashlib.sha256(path.read_bytes()).hexdigest() == row["sha256"])
    except FileNotFoundError:
        return False


class PrivateTTSStore:
    def __init__(
        self, db_path: Path, root: Path, *,
        user_max_bytes: int | None = None, user_max_entries: int | None = None,
        global_max_bytes: int | None = None, global_max_entries: int | None = None,
        min_free_bytes: int | None = None,
    ) -> None:
        self.db_path = db_path.resolve()
        self.root = root.resolve()
        self.user_max_bytes = user_max_bytes or settings.TTS_USER_MAX_BYTES
        self.user_max_entries = user_max_entries or settings.TTS_USER_MAX_ENTRIES
        self.global_max_bytes = global_max_bytes or settings.CACHE_MAX_BYTES
        self.global_max_entries = global_max_entries or settings.CACHE_MAX_ENTRIES
        self.min_free_bytes = settings.CACHE_MIN_FREE_BYTES if min_free_bytes is None else min_free_bytes
        self.lock = threading.RLock()
        self.memory = LRUCache(maxsize=settings.MEMORY_CACHE_MAX_BYTES, getsizeof=len)
        self._initialized = False

    def _connect(self) -> AbstractContextManager[sqlite3.Connection]:
        return database.connection(self.db_path, initialize=False)

    def init(self) -> None:
        with self.lock:
            if self._initialized:
                return
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self.root.mkdir(parents=True, exist_ok=True)
            with self._connect() as conn:
                conn.execute("pragma journal_mode=wal")
                conn.execute("begin immediate")
                migrate_private_tts(conn)
                conn.commit()
            self._initialized = True

    def file_path(self, owner: str, key: str) -> Path:
        if not KEY_PATTERN.fullmatch(key):
            raise ValueError("Invalid private audio key")
        owner_hash = hashlib.sha256(owner.encode("utf-8")).hexdigest()
        root = self.root.resolve()
        path = root / owner_hash[:2] / owner_hash / f"{key}.mp3"
        if any(p.is_symlink() or p.is_junction() for p in (path, path.parent, path.parent.parent)):
            raise OSError("Linked private audio paths are not allowed")
        if not path.resolve().is_relative_to(root):
            raise OSError("Invalid private audio path")
        return path

    @staticmethod
    def _scope(owner: str | None, protected: tuple[str, str] | None) -> tuple[str, tuple]:
        clause = "where owner_id = ? and status != 'deleting'" if owner else "where status != 'deleting'"
        args = (owner,) if owner else ()
        if protected:
            clause += " and not (owner_id=? and cache_key=?)"
            args += protected
        return clause, args

    def _usage(
        self, conn: sqlite3.Connection, owner: str | None, protected: tuple[str, str] | None = None,
    ) -> tuple[int, int]:
        clause, args = self._scope(owner, protected)
        row = conn.execute(
            f"select coalesce(sum(byte_size), 0), count(*) "
            f"from tts_audio_assets {clause}", args,
        ).fetchone()
        return int(row[0]), int(row[1])

    def _evict(self, conn: sqlite3.Connection, owner: str, key: str) -> None:
        conn.execute(
            "update tts_audio_assets set status='deleting' where owner_id=? and cache_key=?",
            (owner, key),
        )
        conn.commit()
        self.file_path(owner, key).unlink(missing_ok=True)
        conn.execute("delete from tts_audio_assets where owner_id=? and cache_key=?", (owner, key))
        conn.commit()
        self.memory.pop((owner, key), None)

    def _oldest(
        self, conn: sqlite3.Connection, owner: str | None, protected: tuple[str, str] | None,
    ) -> sqlite3.Row | None:
        clause, args = self._scope(owner, protected)
        return conn.execute(
            f"select owner_id, cache_key from tts_audio_assets {clause} order by last_access_ns asc limit 1", args,
        ).fetchone()

    def _prune(
        self, conn: sqlite3.Connection, owner: str, incoming: int,
        protected: tuple[str, str] | None = None,
    ) -> list[tuple[str, str]]:
        if incoming > min(self.user_max_bytes, self.global_max_bytes):
            raise StorageFullError("Audio exceeds retained storage capacity")
        # Staging must fit while previous assets still exist. Deleting victims
        # cannot be used to fund a write that might subsequently fail.
        if shutil.disk_usage(self.root).free - incoming < self.min_free_bytes:
            raise StorageFullError("Insufficient free disk space for retained audio staging")
        victims = []
        owners = [row[0] for row in conn.execute(
            "select owner_id from tts_audio_assets group by owner_id "
            "having sum(byte_size) * 10 >= ? * 9 or count(*) * 10 >= ? * 9",
            (self.user_max_bytes, self.user_max_entries),
        ) if row[0] != owner]
        scopes = [(user, self.user_max_bytes, self.user_max_entries) for user in [owner, *owners]]
        scopes.append((None, self.global_max_bytes, self.global_max_entries))
        for scoped_owner, byte_cap, count_cap in scopes:
            added_bytes = incoming if scoped_owner in (owner, None) else 0
            added_count = 1 if scoped_owner in (owner, None) else 0
            used, count = self._usage(conn, scoped_owner, protected)
            if (used + added_bytes) * 10 < byte_cap * 9 and (count + added_count) * 10 < count_cap * 9:
                continue
            target_bytes = int(byte_cap * 0.75)
            target_count = int(count_cap * 0.75)
            while used + added_bytes > target_bytes or count + added_count > target_count:
                victim = self._oldest(conn, scoped_owner, protected)
                if victim is None:
                    break
                victim_id = (victim["owner_id"], victim["cache_key"])
                conn.execute("update tts_audio_assets set status='deleting' where owner_id=? and cache_key=?", victim_id)
                victims.append(victim_id)
                used, count = self._usage(conn, scoped_owner, protected)
            if used + added_bytes > byte_cap or count + added_count > count_cap:
                raise StorageFullError("Retained storage capacity exhausted")
        return victims

    def get(self, owner: str, key: str, *, touch: bool = True) -> tuple[bytes, dict] | None:
        self.init()
        with self.lock, self._connect() as conn:
            row = conn.execute(
                "select a.* from tts_audio_assets a join tts_history_v2 h "
                "on h.owner_id=a.owner_id and h.cache_key=a.cache_key "
                "where a.owner_id=? and a.cache_key=?", (owner, key)
            ).fetchone()
            if row is None or row["status"] == "deleting":
                return None
            if row["status"] == "unavailable":
                raise AudioUnavailable()
            path = self.file_path(owner, key)
            cache_id = (owner, key)
            try:
                if path.stat().st_size != row["byte_size"]:
                    raise AudioUnavailable()
                audio = self.memory.get(cache_id)
                if audio is None:
                    audio = path.read_bytes()
                    digest = hashlib.sha256(audio).hexdigest()
                else:
                    # Windows timestamps cannot reliably detect replacement or
                    # corruption. Validate disk even when reusing immutable bytes.
                    with path.open("rb") as file:
                        digest = hashlib.file_digest(file, "sha256").hexdigest()
                if len(audio) != row["byte_size"] or digest != row["sha256"]:
                    raise AudioUnavailable()
                if len(audio) <= self.memory.maxsize:
                    self.memory[cache_id] = audio
            except (FileNotFoundError, AudioUnavailable):
                self._mark_unavailable(conn, owner, key)
                raise AudioUnavailable() from None
            if touch:
                self._touch(conn, owner, key)
            return audio, dict(row) | {"sentences": json.loads(row["timeline_json"])}

    def _touch(self, conn: sqlite3.Connection, owner: str, key: str) -> None:
        conn.execute(
            "update tts_audio_assets set last_access_ns=? where owner_id=? and cache_key=? and status='ready'",
            (time.time_ns(), owner, key),
        )
        conn.execute(
            "update tts_history_v2 set last_played_at=? "
            "where owner_id=? and cache_key=? and exists (select 1 from tts_audio_assets "
            "where owner_id=? and cache_key=? and status='ready')", (utc_timestamp(), owner, key, owner, key),
        )

    def touch(self, owner: str, key: str) -> None:
        """Record a previously validated cache hit without reading the file twice."""
        self.init()
        with self.lock, self._connect() as conn:
            self._touch(conn, owner, key)

    def _mark_unavailable(self, conn: sqlite3.Connection, owner: str, key: str) -> None:
        conn.execute(
            "update tts_audio_assets set status='unavailable' where owner_id=? and cache_key=?",
            (owner, key),
        )
        conn.commit()
        self.memory.pop((owner, key), None)

    def put(
        self, owner: str, key: str, text: str, voice: str, model: str,
        engine: str, audio: bytes, sentences: list[dict],
    ) -> None:
        self.init()
        if not 0 < len(audio) <= settings.MAX_AUDIO_BYTES:
            raise StorageFullError("Invalid retained audio size")
        path = self.file_path(owner, key)
        temporary = path.with_name(f"{path.name}.tmp_{uuid.uuid4().hex}")
        with self.lock:
            try:
                with self._connect() as conn:
                    self._put_locked(conn, owner, key, text, voice, model, engine, audio, sentences, path, temporary)
            finally:
                temporary.unlink(missing_ok=True)

    def _put_locked(
        self, conn: sqlite3.Connection, owner: str, key: str, text: str,
        voice: str, model: str, engine: str, audio: bytes, sentences: list[dict],
        path: Path, temporary: Path,
    ) -> None:
        # Quota selection, victim states, new asset and history are one decision.
        # Other SQLite writers cannot change the capacity calculation mid-write.
        conn.execute("begin immediate")
        existing = conn.execute(
            "select status from tts_audio_assets where owner_id=? and cache_key=?",
            (owner, key),
        ).fetchone()
        if existing and existing["status"] == "ready" and path.is_file():
            return
        backup = path.with_name(temporary.name.replace(".tmp_", ".bak_"))
        published = False
        try:
            victims = self._prune(conn, owner, len(audio), (owner, key) if existing else None)
            path.parent.mkdir(parents=True, exist_ok=True)
            with temporary.open("xb") as file:
                file.write(audio)
                file.flush()
                os.fsync(file.fileno())
            # Retain replacement bytes until the matching metadata is durable.
            if path.exists():
                path.replace(backup)
            temporary.replace(path)
            published = True
            conn.execute(
                "insert into tts_audio_assets "
                "(owner_id, cache_key, byte_size, sha256, engine, voice, model, timeline_json, last_access_ns) "
                "values (?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "on conflict(owner_id, cache_key) do update set "
                "byte_size=excluded.byte_size, sha256=excluded.sha256, engine=excluded.engine, "
                "voice=excluded.voice, model=excluded.model, timeline_json=excluded.timeline_json, "
                "last_access_ns=excluded.last_access_ns, status='ready'",
                (owner, key, len(audio), hashlib.sha256(audio).hexdigest(), engine, voice,
                 model, json.dumps(sentences, ensure_ascii=False), time.time_ns()),
            )
            conn.execute(
                "insert into tts_history_v2 (owner_id, cache_key, text, voice, model, engine, created_at, last_played_at) "
                "values (?, ?, ?, ?, ?, ?, ?, ?) "
                "on conflict(owner_id, cache_key) do update set text=excluded.text, voice=excluded.voice, "
                "model=excluded.model, engine=excluded.engine, last_played_at=excluded.last_played_at",
                (owner, key, text, voice, model, engine, utc_timestamp(), utc_timestamp()),
            )
            conn.commit()
        except BaseException:
            conn.rollback()
            if backup.exists():
                os.replace(backup, path)
            elif published:
                path.unlink(missing_ok=True)
            raise
        # Physical deletion is recoverable cleanup after the successful commit.
        # Its failure must not turn the durable new recording into an error.
        try:
            backup.unlink(missing_ok=True)
        except OSError:
            logger.warning("Retained audio backup cleanup deferred key=%s", key, exc_info=True)
        for victim_owner, victim_key in victims:
            try:
                self._evict(conn, victim_owner, victim_key)
            except (OSError, sqlite3.Error):
                conn.rollback()
                logger.warning("Retained audio deletion deferred key=%s", victim_key, exc_info=True)
        self.memory.pop((owner, key), None)
        if len(audio) <= self.memory.maxsize:
            self.memory[(owner, key)] = audio

    def list_history(self, owner: str, limit: int = 50) -> list[dict]:
        self.init()
        with self.lock, self._connect() as conn:
            rows = conn.execute(
                "select h.id, h.text, h.voice, h.model, h.engine, h.cache_key, "
                "h.created_at, h.last_played_at, a.status as audio_status "
                "from tts_history_v2 h join tts_audio_assets a "
                "on a.owner_id=h.owner_id and a.cache_key=h.cache_key "
                "where h.owner_id=? and a.status != 'deleting' order by a.last_access_ns desc limit ?", (owner, limit),
            ).fetchall()
            results = []
            for row in rows:
                status = row["audio_status"]
                if status == "ready" and not self.file_path(owner, row["cache_key"]).is_file():
                    self._mark_unavailable(conn, owner, row["cache_key"])
                    status = "unavailable"
                item = absolute_history_row(row)
                item["audio_status"] = status
                results.append(item)
            return results

    def delete(self, owner: str, history_id: int) -> bool:
        self.init()
        with self.lock, self._connect() as conn:
            row = conn.execute(
                "select cache_key from tts_history_v2 where owner_id=? and id=?",
                (owner, history_id),
            ).fetchone()
            if row is None:
                return False
            self._evict(conn, owner, row["cache_key"])
            return True

    def clear(self, owner: str) -> int:
        self.init()
        with self.lock, self._connect() as conn:
            keys = [row[0] for row in conn.execute(
                "select cache_key from tts_audio_assets where owner_id=?", (owner,)
            )]
            for key in keys:
                self._evict(conn, owner, key)
            return len(keys)

    def reconcile(self) -> None:
        self.init()
        with self.lock, self._connect() as conn:
            known = set()
            self.memory.clear()
            for row in conn.execute("select owner_id, cache_key, status, byte_size, sha256 from tts_audio_assets").fetchall():
                path = self.file_path(row["owner_id"], row["cache_key"])
                if row["status"] == "deleting":
                    try:
                        self._evict(conn, row["owner_id"], row["cache_key"])
                    except (OSError, sqlite3.Error):
                        conn.rollback()
                        # A pending deletion is already hidden from playback.
                        # Do not retry it again as an orphan in this same pass.
                        known.add(path)
                        logger.warning("Retained audio startup deletion deferred key=%s", row["cache_key"], exc_info=True)
                else:
                    known.add(path)
                    # A crash between file replacement and SQLite commit leaves
                    # the old file here. The committed digest decides which copy
                    # belongs to the retained asset, not its modification time.
                    backups = [backup for backup in path.parent.glob(f"{path.name}.bak_*")
                               if re.fullmatch(r"[0-9a-f]{64}\.mp3\.bak_[0-9a-f]+", backup.name)
                               and backup.is_file() and not backup.is_symlink()]
                    for backup in backups:
                        # Failed cleanup or restoration stays available to the
                        # next reconciliation, rather than the orphan scanner.
                        known.add(backup)
                        try:
                            if _matches_asset(path, row):
                                backup.unlink()
                            elif _matches_asset(backup, row):
                                os.replace(backup, path)
                        except OSError:
                            logger.warning("Retained audio startup backup recovery deferred key=%s", row["cache_key"], exc_info=True)
                    try:
                        valid = _matches_asset(path, row)
                    except OSError:
                        valid = False
                        logger.warning("Retained audio startup validation deferred key=%s", row["cache_key"], exc_info=True)
                    try:
                        if not valid and row["status"] == "ready":
                            self._mark_unavailable(conn, row["owner_id"], row["cache_key"])
                        elif valid and row["status"] == "unavailable":
                            # A previously blocked restore can now publish the
                            # original bytes proven by the committed digest.
                            conn.execute("update tts_audio_assets set status='ready' where owner_id=? and cache_key=?",
                                         (row["owner_id"], row["cache_key"]))
                            conn.commit()
                    except sqlite3.Error:
                        conn.rollback()
                        logger.warning("Retained audio startup status update deferred key=%s", row["cache_key"], exc_info=True)
            for path in self.root.rglob("*.mp3*"):
                if path in known:
                    continue
                try:
                    if path.is_symlink() or not path.is_file():
                        continue
                    path.unlink()
                except OSError:
                    logger.warning("Retained audio startup orphan cleanup deferred file=%s", path.name, exc_info=True)


def get_private_store() -> PrivateTTSStore:
    global _store
    with _store_lock:
        if _store is None:
            root = database.DB_PATH.parent / "private_audio"
            _store = PrivateTTSStore(database.DB_PATH, root)
        return _store
