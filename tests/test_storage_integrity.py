from app.services import database as database_service
"""Regressions for synthesis identity, absolute history time and failed publication."""

import errno
import hashlib
import json
import sqlite3
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.config import settings
from app.schemas.tts import TTSRequest
from app.services import cache_service as cache, history_service as history, tts_service
from app.services.legacy_tts_storage import LegacyTTSStorage
from app.services.errors import AudioUnavailable
from app.services.private_tts_adapter import PrivateTTSStorage
from app.services.private_tts_storage import PrivateTTSStore
from app.services.tts_storage import AudioAsset, SynthesisSpec


def test_repeated_startup_drops_redundant_indexes_without_losing_owner_data(monkeypatch):
    from app.services import explain_service as explain

    history.add_or_touch("alice", "first", "voice", "edge", "edge", "key-one")
    history.add_or_touch("bob", "private", "voice", "edge", "edge", "key-bob")
    history.add_or_touch("alice", "second", "voice", "edge", "edge", "key-two")
    explain.save_explanation("alice", "hello", "zh", "explanation-one", "saved answer")
    explain.save_explanation("bob", "secret", "zh", "explanation-bob", "private answer")
    with database_service.connection() as conn:
        conn.execute("create index if not exists idx_history_client on history(client_id, last_played_at desc)")
        conn.execute("create index if not exists idx_explanations_client on explanations(client_id, updated_at desc)")
        conn.execute("update history set last_played_at='2026-01-01T01:00:00+00:00' where cache_key='key-one'")
        conn.execute("update history set last_played_at='2026-01-01T03:00:00+03:00' where cache_key='key-two'")

    for _ in range(2):
        monkeypatch.setattr(database_service, "_initialized", False)
        database_service.init_db()
        with database_service.connection() as conn:
            indexes = {row["name"] for row in conn.execute("select name from sqlite_master where type='index'")}
        assert not {"idx_history_client", "idx_explanations_client"} & indexes
        assert [row["cache_key"] for row in history.list_history("alice")] == ["key-one", "key-two"]
        assert explain.get_explanation("alice", "explanation-one")["explanation"] == "saved answer"
        assert explain.get_explanation("alice", "explanation-bob") is None

    assert explain.clear_explanations("alice") == 1
    assert explain.get_explanation("bob", "explanation-bob")["explanation"] == "private answer"
    assert history.clear_all_history("alice") == 2
    assert [row["cache_key"] for row in history.list_history("bob")] == ["key-bob"]


@pytest.mark.anyio
async def test_legacy_model_and_revision_changes_generate_new_audio_and_replay_old(monkeypatch):
    monkeypatch.setattr(settings, "TTS_STORAGE_MODE", "legacy")
    monkeypatch.setattr(settings, "GEMINI_TTS_MODEL", "model-one")
    monkeypatch.setattr(settings, "TTS_CACHE_REVISION", "revision-one")
    business = tts_service.get_tts_service()
    request = TTSRequest(text="hello", engine="gemini")
    with patch("app.services.engines.gemini_engine.GeminiTTSEngine.synthesize", new_callable=AsyncMock,
               side_effect=[b"model-one", b"model-two", b"revision-two"]):
        first = await business.generate("alice", request, "key")
        monkeypatch.setattr(settings, "GEMINI_TTS_MODEL", "model-two")
        second = await business.generate("alice", request, "key")
        monkeypatch.setattr(settings, "TTS_CACHE_REVISION", "revision-two")
        third = await business.generate("alice", request, "key")
        assert second.asset.audio == b"model-two" and not second.cached
        assert third.asset.audio == b"revision-two" and not third.cached
        assert len({first.key, second.key, third.key}) == 3
        assert (await business.replay("alice", first.key)).asset.audio == b"model-one"


@pytest.mark.parametrize("mode", ["legacy", "private"])
def test_storage_keys_share_outer_whitespace_normalization(mode, tmp_path):
    store = (LegacyTTSStorage() if mode == "legacy" else
             PrivateTTSStorage(PrivateTTSStore(tmp_path / "private.db", tmp_path / "private")))
    def plan(text, flow=False):
        return store.prepare("alice", SynthesisSpec(text, "edge", "voice", "edge", True), flow=flow)
    assert plan("  a b \n").key == plan("a b").key
    assert plan("a  b").key != plan("a b").key
    if mode == "legacy":
        assert plan("a b").key != plan("a b", flow=True).key


def test_old_legacy_cache_key_remains_available_only_for_explicit_replay():
    raw = json.dumps(["audio-v2", "hello", "Kore", "gemini"], ensure_ascii=False)
    old_key = hashlib.sha256(raw.encode()).hexdigest()[:16]
    cache.put_audio_cache(old_key, b"old-audio")
    store = LegacyTTSStorage()
    plan = store.prepare("alice", SynthesisSpec("hello", "gemini", "Kore", "new-model", False), flow=False)
    assert store.get("alice", plan) is None
    assert store.replay("alice", old_key, flow=False).audio == b"old-audio"


@pytest.mark.parametrize("mode", ["legacy", "private"])
def test_history_new_writes_are_absolute_and_old_values_use_server_local_time(mode, tmp_path):
    if mode == "legacy":
        storage = LegacyTTSStorage()
        table, database = "history", database_service.DB_PATH
    else:
        storage = PrivateTTSStorage(PrivateTTSStore(tmp_path / "private.db", tmp_path / "private"))
        table, database = "tts_history_v2", storage.store.db_path
    plan = storage.prepare("alice", SynthesisSpec("hello", "edge", "voice", "edge", False), flow=False)
    before = datetime.now(timezone.utc)
    storage.save("alice", plan, AudioAsset(b"audio", "edge", "voice"))
    row = storage.list_history("alice")[0]
    for field in ("created_at", "last_played_at"):
        parsed = datetime.fromisoformat(row[field])
        assert parsed.tzinfo is not None
        assert before.timestamp() - 1 <= parsed.timestamp() <= datetime.now(timezone.utc).timestamp() + 1
    with sqlite3.connect(database) as conn:
        conn.execute(f"update {table} set created_at='2026-01-02 03:04:05', "
                     "last_played_at='2026-01-02T03:04:05+03:00'")
    row = storage.list_history("alice")[0]
    parsed = datetime.fromisoformat(row["created_at"])
    assert parsed.tzinfo is not None
    assert parsed.timestamp() == datetime(2026, 1, 2, 3, 4, 5).astimezone().timestamp()
    assert row["last_played_at"] == "2026-01-02T03:04:05+03:00"
    storage.record_hit("alice", plan)
    assert datetime.fromisoformat(storage.list_history("alice")[0]["last_played_at"]).tzinfo is not None


@pytest.mark.parametrize("scope", ["user", "global"])
@pytest.mark.parametrize("quota", ["entries", "bytes"])
@pytest.mark.parametrize("failure", ["write", "rename", "database", "commit"])
def test_private_failed_publication_preserves_quota_victims(tmp_path, scope, quota, failure):
    store = PrivateTTSStore(tmp_path / "private.db", tmp_path / "private", min_free_bytes=0)
    old = "1" * 64
    new = "2" * 64
    store.put("alice", old, "old", "voice", "edge", "edge", b"old-audio", [])
    retained = store.list_history("alice")
    if quota == "bytes":
        store.put("alice", "7" * 64, "second old", "voice", "edge", "edge", b"other-old", [])
        retained = store.list_history("alice")
        setattr(store, f"{scope}_max_bytes", 18)
    else:
        setattr(store, f"{scope}_max_entries", 1)
    injection = nullcontext()
    expected = OSError
    if failure == "write":
        injection = patch("app.services.private_tts_storage.os.fsync", side_effect=OSError(errno.ENOSPC, "full"))
    elif failure == "rename":
        injection = patch.object(Path, "replace", side_effect=OSError("rename failed"))
    elif failure == "database":
        with sqlite3.connect(store.db_path) as conn:
            conn.execute("create trigger fail_new before insert on tts_history_v2 "
                         "begin select raise(abort, 'injected'); end")
        expected = sqlite3.IntegrityError
    else:
        connect = sqlite3.connect
        class CommitFailure(sqlite3.Connection):
            def commit(self):
                if self.execute("select 1 from tts_audio_assets where cache_key=?", (new,)).fetchone():
                    raise sqlite3.OperationalError("injected commit failure")
                return super().commit()
        injection = patch("app.services.private_tts_storage.sqlite3.connect",
                          side_effect=lambda *args, **kwargs: connect(*args, **kwargs, factory=CommitFailure))
        expected = sqlite3.OperationalError
    with injection, pytest.raises(expected):
        store.put("alice", new, "new", "voice", "edge", "edge", b"new-audio", [])
    assert store.list_history("alice") == retained
    assert store.get("alice", old, touch=False)[0] == b"old-audio"
    assert store.get("alice", new, touch=False) is None
    assert not list(store.root.rglob("*.tmp_*"))


def test_legacy_history_orders_mixed_offsets_before_limiting():
    history.add_or_touch("alice", "older", "voice", "edge", "edge", "1" * 16)
    history.add_or_touch("alice", "newer", "voice", "edge", "edge", "2" * 16)
    # The later UTC instant has the previous day's wall-clock text.
    with sqlite3.connect(database_service.DB_PATH) as conn:
        conn.execute("update history set last_played_at='2026-01-02T00:15:00+08:00' where text='older'")
        conn.execute("update history set last_played_at='2026-01-01T17:00:00+00:00' where text='newer'")
    assert [row["text"] for row in history.list_history("alice", limit=1)] == ["newer"]


@pytest.mark.parametrize("failure", ["rename", "database", "database_with_unlink_failure"])
def test_failed_private_replacement_restores_previous_file_and_history(tmp_path, failure):
    store = PrivateTTSStore(tmp_path / "private.db", tmp_path / "private", min_free_bytes=0)
    key = "3" * 64
    store.put("alice", key, "old", "voice", "edge", "edge", b"old-audio", [])
    with sqlite3.connect(store.db_path) as conn:
        conn.execute("update tts_audio_assets set status='unavailable'")
        if failure != "rename":
            conn.execute("create trigger fail_new before insert on tts_history_v2 "
                         "begin select raise(abort, 'injected'); end")
    retained = store.list_history("alice")
    injection, expected = nullcontext(), sqlite3.IntegrityError
    if failure == "rename":
        replace = Path.replace
        def fail_publish(path, target):
            if ".tmp_" in path.name:
                raise OSError("new rename failed after old backup was saved")
            return replace(path, target)
        injection, expected = patch.object(Path, "replace", fail_publish), OSError
    elif failure == "database_with_unlink_failure":
        unlink = Path.unlink
        def fail_unlink(path, *args, **kwargs):
            if path == store.file_path("alice", key):
                raise OSError("cannot unlink published replacement")
            return unlink(path, *args, **kwargs)
        injection = patch.object(Path, "unlink", fail_unlink)
    with injection, pytest.raises(expected):
        store.put("alice", key, "replacement", "voice", "edge", "edge", b"replacement-audio", [])
    assert store.file_path("alice", key).read_bytes() == b"old-audio"
    assert store.list_history("alice") == retained
    assert not list(store.root.rglob("*.bak_*"))


def test_committed_private_publication_finishes_failed_victim_delete_on_restart(tmp_path):
    store = PrivateTTSStore(tmp_path / "private.db", tmp_path / "private", min_free_bytes=0)
    old, new = "4" * 64, "5" * 64
    store.put("alice", old, "old", "voice", "edge", "edge", b"old-audio", [])
    store.user_max_entries = 1
    old_path = store.file_path("alice", old)
    unlink = Path.unlink
    def fail_old(path, *args, **kwargs):
        if path == old_path:
            raise OSError("injected victim deletion failure")
        return unlink(path, *args, **kwargs)
    with patch.object(Path, "unlink", fail_old):
        store.put("alice", new, "new", "voice", "edge", "edge", b"new-audio", [])
    assert store.get("alice", new, touch=False)[0] == b"new-audio"
    assert store.get("alice", old, touch=False) is None
    assert old_path.exists()
    restarted = PrivateTTSStore(store.db_path, store.root, min_free_bytes=0)
    restarted.reconcile()
    assert not old_path.exists()
    assert [row["cache_key"] for row in restarted.list_history("alice")] == [new]


@pytest.mark.parametrize("published", [False, True])
def test_private_restart_restores_uncommitted_replacement_backup(tmp_path, published):
    store = PrivateTTSStore(tmp_path / "private.db", tmp_path / "private", min_free_bytes=0)
    key = "6" * 64
    store.put("alice", key, "old", "voice", "edge", "edge", b"old-audio", [])
    retained = store.list_history("alice")
    path = store.file_path("alice", key)
    backup = path.with_name(f"{path.name}.bak_dead")
    path.replace(backup)
    if published:
        path.write_bytes(b"uncommitted-new-audio")
    restarted = PrivateTTSStore(store.db_path, store.root, min_free_bytes=0)
    restarted.reconcile()
    assert restarted.get("alice", key, touch=False)[0] == b"old-audio"
    assert restarted.list_history("alice") == retained
    assert not backup.exists()


def test_private_restart_discards_backup_after_committed_replacement(tmp_path):
    store = PrivateTTSStore(tmp_path / "private.db", tmp_path / "private", min_free_bytes=0)
    key = "8" * 64
    store.put("alice", key, "ready", "voice", "edge", "edge", b"committed-audio", [])
    path = store.file_path("alice", key)
    backup = path.with_name(f"{path.name}.bak_dead")
    backup.write_bytes(b"previous-audio")
    restarted = PrivateTTSStore(store.db_path, store.root, min_free_bytes=0)
    restarted.reconcile()
    assert restarted.get("alice", key, touch=False)[0] == b"committed-audio"
    assert not backup.exists()


@pytest.mark.parametrize("failure", ["unlink", "database"])
def test_private_restart_keeps_serving_committed_audio_with_persistent_victim_cleanup_failure(tmp_path, failure):
    store = PrivateTTSStore(tmp_path / "private.db", tmp_path / "private", min_free_bytes=0)
    old, new = "9" * 64, "a" * 64
    store.put("alice", old, "old", "voice", "edge", "edge", b"old-audio", [])
    store.user_max_entries = 1
    old_path = store.file_path("alice", old)
    injection = nullcontext()
    if failure == "unlink":
        unlink = Path.unlink
        def fail_old(path, *args, **kwargs):
            if path == old_path:
                raise PermissionError("old victim is still locked")
            return unlink(path, *args, **kwargs)
        injection = patch.object(Path, "unlink", fail_old)
    else:
        with sqlite3.connect(store.db_path) as conn:
            conn.execute(f"create trigger fail_cleanup before delete on tts_audio_assets "
                         f"when old.cache_key='{old}' begin select raise(abort, 'cleanup blocked'); end")
    with injection:
        store.put("alice", new, "new", "voice", "edge", "edge", b"new-audio", [])
        restarted = PrivateTTSStore(store.db_path, store.root, min_free_bytes=0)
        restarted.reconcile()
        restarted.reconcile()
        assert restarted.get("alice", new, touch=False)[0] == b"new-audio"
        assert restarted.get("alice", old, touch=False) is None
        assert [row["cache_key"] for row in restarted.list_history("alice")] == [new]
        with sqlite3.connect(store.db_path) as conn:
            assert conn.execute("select status from tts_audio_assets where cache_key=?", (old,)).fetchone() == ("deleting",)
    if failure == "database":
        with sqlite3.connect(store.db_path) as conn:
            conn.execute("drop trigger fail_cleanup")
    restarted.reconcile()
    assert not old_path.exists()
    with sqlite3.connect(store.db_path) as conn:
        assert conn.execute("select 1 from tts_audio_assets where cache_key=?", (old,)).fetchone() is None


@pytest.mark.parametrize("suffix", ["bak_dead", "tmp_dead"])
def test_private_restart_defers_locked_backup_and_temporary_cleanup(tmp_path, suffix):
    store = PrivateTTSStore(tmp_path / "private.db", tmp_path / "private", min_free_bytes=0)
    key = "b" * 64
    store.put("alice", key, "ready", "voice", "edge", "edge", b"committed-audio", [])
    leftover = store.file_path("alice", key).with_name(f"{key}.mp3.{suffix}")
    leftover.write_bytes(b"obsolete-or-partial")
    unlink = Path.unlink
    def fail_leftover(path, *args, **kwargs):
        if path == leftover:
            raise PermissionError("leftover remains locked")
        return unlink(path, *args, **kwargs)
    restarted = PrivateTTSStore(store.db_path, store.root, min_free_bytes=0)
    with patch.object(Path, "unlink", fail_leftover):
        restarted.reconcile()
        restarted.reconcile()
        assert restarted.get("alice", key, touch=False)[0] == b"committed-audio"
        assert restarted.list_history("alice")[0]["audio_status"] == "ready"
        assert leftover.exists()
    restarted.reconcile()
    assert not leftover.exists()


def test_private_restart_retains_backup_when_restore_is_locked_and_recovers_after_retry(tmp_path):
    store = PrivateTTSStore(tmp_path / "private.db", tmp_path / "private", min_free_bytes=0)
    key = "c" * 64
    store.put("alice", key, "old", "voice", "edge", "edge", b"old-audio", [])
    retained = store.list_history("alice")[0]
    path = store.file_path("alice", key)
    backup = path.with_name(f"{path.name}.bak_dead")
    path.replace(backup)
    path.write_bytes(b"uncommitted-new-audio")
    restarted = PrivateTTSStore(store.db_path, store.root, min_free_bytes=0)
    with patch("app.services.private_tts_storage.os.replace", side_effect=PermissionError("restore remains locked")):
        restarted.reconcile()
        restarted.reconcile()
        row = restarted.list_history("alice")[0]
        assert row["id"] == retained["id"]
        assert row["audio_status"] == "unavailable"
        assert backup.read_bytes() == b"old-audio"
        with pytest.raises(AudioUnavailable):
            restarted.get("alice", key, touch=False)
    restarted.reconcile()
    assert restarted.get("alice", key, touch=False)[0] == b"old-audio"
    assert restarted.list_history("alice")[0]["audio_status"] == "ready"
    assert not backup.exists()
