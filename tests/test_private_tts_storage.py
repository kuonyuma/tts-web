import pytest
import errno
import sqlite3
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from app.services.errors import StorageFullError

from app.services.private_tts_storage import AudioUnavailable, PrivateTTSStore, compute_private_key


def make_store(tmp_path, **limits):
    return PrivateTTSStore(tmp_path / "history.db", tmp_path / "private_audio", **limits)


def test_key_uses_full_hash_and_model_revision():
    first = compute_private_key("こんにちは", "gemini", "Kore", "model-v1", "r1")
    assert len(first) == 64
    assert first != compute_private_key("こんにちは", "gemini", "Kore", "model-v2", "r1")
    assert first != compute_private_key("こんにちは", "gemini", "Kore", "model-v1", "r2")


def test_audio_and_history_are_owned_by_one_user(tmp_path):
    store = make_store(tmp_path)
    key = compute_private_key("secret", "edge", "voice", "edge", "r1")
    store.put("alice", key, "secret", "voice", "edge", "edge", b"alice-audio", [])
    assert store.get("alice", key)[0] == b"alice-audio"
    assert store.get("bob", key) is None
    assert store.list_history("bob") == []
    store.put("bob", key, "secret", "voice", "edge", "edge", b"bob-audio", [])
    assert store.get("alice", key)[0] == b"alice-audio"
    assert store.get("bob", key)[0] == b"bob-audio"
    assert store.delete("alice", store.list_history("alice")[0]["id"])
    assert store.get("bob", key)[0] == b"bob-audio"


def test_user_quota_eviction_uses_last_played_and_removes_history(tmp_path):
    store = make_store(tmp_path, user_max_bytes=40, user_max_entries=4,
                       global_max_bytes=100, global_max_entries=10, min_free_bytes=1)
    for index in range(3):
        store.put("alice", f"{index:064x}", str(index), "voice", "edge", "edge", b"12345678", [])
    store.get("alice", f"{0:064x}")
    store.put("alice", f"{3:064x}", "3", "voice", "edge", "edge", b"12345678", [])
    keys = {row["cache_key"] for row in store.list_history("alice")}
    assert f"{0:064x}" in keys
    assert f"{1:064x}" not in keys
    assert store.get("alice", f"{1:064x}") is None


def test_missing_file_is_marked_unavailable_without_synthesis(tmp_path):
    store = make_store(tmp_path)
    key = "a" * 64
    store.put("alice", key, "hello", "voice", "edge", "edge", b"audio", [])
    store.file_path("alice", key).unlink()
    with pytest.raises(AudioUnavailable):
        store.get("alice", key)
    assert store.list_history("alice")[0]["audio_status"] == "unavailable"


def save(store, index=0, owner="alice", audio=b"12345678"):
    key = f"{index:064x}"
    store.put(owner, key, str(index), "voice", "edge", "edge", audio, [])
    return key


def test_key_only_strips_outer_whitespace():
    def key(text):
        return compute_private_key(text, "edge", "v", "edge", "1")
    assert key("  a b \n") == key("a b")
    assert key("a  b") != key("a b")
    assert key("Ａ") != key("A")


def test_warm_cache_detects_same_size_corruption(tmp_path):
    store = make_store(tmp_path)
    key = save(store)
    store.file_path("alice", key).write_bytes(b"87654321")
    with pytest.raises(AudioUnavailable):
        store.get("alice", key)
    assert store.list_history("alice")[0]["audio_status"] == "unavailable"


def test_capacity_checked_before_any_file_write(tmp_path):
    store = make_store(tmp_path, min_free_bytes=64)
    store.init()
    with patch("app.services.private_tts_storage.shutil.disk_usage") as usage:
        usage.return_value.free = 65
        with patch("pathlib.Path.open", side_effect=AssertionError("write before capacity check")):
            with pytest.raises(StorageFullError):
                save(store)


def test_interrupted_write_cleans_temporary_file(tmp_path):
    store = make_store(tmp_path)
    with patch("app.services.private_tts_storage.os.fsync", side_effect=OSError(errno.ENOSPC, "full")):
        with pytest.raises(OSError):
            save(store)
    assert not list(store.root.rglob("*.mp3*"))
    assert store.list_history("alice") == []


def test_sqlite_insert_failure_removes_renamed_file(tmp_path):
    store = make_store(tmp_path)
    store.init()
    with sqlite3.connect(store.db_path) as conn:
        conn.execute("create trigger fail_insert before insert on tts_history_v2 begin select raise(abort, 'injected'); end")
    with pytest.raises(sqlite3.IntegrityError):
        save(store)
    assert not list(store.root.rglob("*.mp3*"))
    assert store.list_history("alice") == []


def test_global_watermark_evicts_oldest_after_user_limits(tmp_path):
    store = make_store(tmp_path, user_max_entries=10, global_max_entries=4)
    a = save(store, 0, "alice")
    b = save(store, 1, "bob")
    save(store, 2, "bob")
    store.get("alice", a)
    save(store, 3, "bob")
    assert store.get("bob", b) is None
    assert store.get("alice", a) is not None
    assert len(store.list_history("bob")) == 2


def test_recovery_finishes_deletions_and_reclaims_orphans(tmp_path):
    store = make_store(tmp_path)
    missing = save(store, 0)
    deleting = save(store, 1)
    store.file_path("alice", missing).unlink()
    orphan = store.file_path("bob", "b" * 64)
    orphan.parent.mkdir(parents=True)
    orphan.write_bytes(b"orphan")
    temporary = orphan.with_suffix(".mp3.tmp_dead")
    temporary.write_bytes(b"partial")
    with sqlite3.connect(store.db_path) as conn:
        conn.execute("update tts_audio_assets set status='deleting' where cache_key=?", (deleting,))
    restarted = make_store(tmp_path)
    restarted.reconcile()
    assert not orphan.exists() and not temporary.exists()
    assert not store.file_path("alice", deleting).exists()
    assert [r["audio_status"] for r in restarted.list_history("alice")] == ["unavailable"]


def test_corruption_with_preserved_timestamps_is_unavailable(tmp_path):
    store = make_store(tmp_path)
    key = save(store)
    path = store.file_path("alice", key)
    before = path.stat()
    path.write_bytes(b"87654321")
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    with pytest.raises(AudioUnavailable):
        store.get("alice", key)


def test_exact_byte_watermark_and_user_cleanup_before_global(tmp_path):
    store = make_store(tmp_path, user_max_bytes=100, global_max_bytes=200)
    bob = save(store, 0, "bob", b"b" * 60)
    save(store, 1, "alice", b"a" * 40)
    keep = save(store, 2, "alice", b"a" * 40)
    save(store, 3, "alice", b"a" * 10)  # exactly 90% of user's byte limit
    assert store.get("alice", f"{1:064x}") is None
    assert store.get("alice", keep) is not None
    assert store.get("bob", bob) is not None


def test_last_played_updates_only_for_audio_access(tmp_path):
    store = make_store(tmp_path)
    key = save(store)
    with sqlite3.connect(store.db_path) as conn:
        conn.execute("update tts_history_v2 set last_played_at='2000-01-01 00:00:00'")
    retained_time = store.list_history("alice")[0]["last_played_at"]
    store.get("alice", key, touch=False)
    assert store.list_history("alice")[0]["last_played_at"] == retained_time
    store.get("alice", key)
    assert store.list_history("alice")[0]["last_played_at"] != retained_time


def test_replay_and_delete_return_whole_audio_or_missing(tmp_path):
    store = make_store(tmp_path)
    key = save(store)
    history_id = store.list_history("alice")[0]["id"]
    barrier = threading.Barrier(2)
    def read():
        barrier.wait()
        return store.get("alice", key)
    def delete():
        barrier.wait()
        return store.delete("alice", history_id)
    with ThreadPoolExecutor(max_workers=2) as pool:
        playback = pool.submit(read)
        removal = pool.submit(delete)
        result = playback.result(timeout=5)
        assert result is None or result[0] == b"12345678"
        assert removal.result(timeout=5)
    assert store.get("alice", key) is None


def test_failed_delete_is_hidden_until_startup_completes_it(tmp_path):
    store = make_store(tmp_path)
    key = save(store)
    history_id = store.list_history("alice")[0]["id"]
    with patch("pathlib.Path.unlink", side_effect=OSError("injected deletion failure")):
        with pytest.raises(OSError):
            store.delete("alice", history_id)
    assert store.get("alice", key) is None
    assert store.list_history("alice") == []
    restarted = make_store(tmp_path)
    restarted.reconcile()
    assert not store.file_path("alice", key).exists()


def test_oversized_audio_does_not_evict_existing_records(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    key = save(store)
    monkeypatch.setattr("app.services.private_tts_storage.settings.MAX_AUDIO_BYTES", 8)
    with pytest.raises(StorageFullError):
        save(store, 1, audio=b"x" * 9)
    assert store.get("alice", key)[0] == b"12345678"


def test_failed_rename_never_publishes_audio(tmp_path):
    store = make_store(tmp_path)
    with patch("pathlib.Path.replace", side_effect=OSError("injected rename failure")):
        with pytest.raises(OSError):
            save(store)
    assert store.list_history("alice") == []
    assert not list(store.root.rglob("*.mp3*"))


@pytest.mark.parametrize("scope", ["user", "global"])
def test_regeneration_replaces_one_quota_entry_and_preserves_history(tmp_path, scope):
    store = make_store(tmp_path)
    key = save(store)
    original_id = store.list_history("alice")[0]["id"]
    store.file_path("alice", key).unlink()
    with pytest.raises(AudioUnavailable):
        store.get("alice", key)
    # A replacement fits exactly one entry; do not count it as a second asset
    # or evict its retained history while reducing to the low watermark.
    setattr(store, f"{scope}_max_entries", 1)
    save(store, audio=b"replacement")
    history = store.list_history("alice")
    assert len(history) == 1
    assert history[0]["id"] == original_id
    assert store.get("alice", key)[0] == b"replacement"


def test_regeneration_disk_pressure_does_not_evict_its_unavailable_record(tmp_path):
    store = make_store(tmp_path, min_free_bytes=64)
    key = save(store)
    store.file_path("alice", key).unlink()
    with pytest.raises(AudioUnavailable):
        store.get("alice", key)
    retained = store.list_history("alice")
    with patch("app.services.private_tts_storage.shutil.disk_usage") as usage:
        usage.return_value.free = 65
        with pytest.raises(StorageFullError):
            save(store)
    assert store.list_history("alice") == retained
    with pytest.raises(AudioUnavailable):
        store.get("alice", key)
