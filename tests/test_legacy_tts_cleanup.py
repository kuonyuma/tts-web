import runpy
import sqlite3
from pathlib import Path

import pytest


def cleanup_function():
    return runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "clear_legacy_tts.py"))["cleanup"]


def test_cleanup_dry_run_and_apply_preserve_every_other_table(tmp_path):
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / ("a" * 16 + ".mp3")).write_bytes(b"legacy")
    (audio / ("a" * 16 + ".timeline.json")).write_text("{}")
    private = tmp_path / "private_audio"
    private.mkdir()
    (private / "keep.mp3").write_bytes(b"private")
    tables = ["history", "explanations", "copilot_usage", "tts_audio_assets", "tts_history_v2"]
    with sqlite3.connect(tmp_path / "history.db") as conn:
        for table in tables:
            conn.execute(f"create table {table} (value text)")
            conn.execute(f"insert into {table} values ('keep')")
    cleanup = cleanup_function()
    assert cleanup(tmp_path) == {"history_rows": 1, "audio_files": 2, "applied": False}
    assert len(list(audio.iterdir())) == 2
    cleanup(tmp_path, apply=True)
    assert not audio.exists()
    assert (private / "keep.mp3").read_bytes() == b"private"
    with sqlite3.connect(tmp_path / "history.db") as conn:
        for table in tables:
            assert conn.execute(f"select count(*) from {table}").fetchone()[0] == (0 if table == "history" else 1)
    assert cleanup(tmp_path, apply=True)["history_rows"] == 0


def test_cleanup_refuses_unknown_files_before_deleting_anything(tmp_path):
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / "keep.txt").write_text("other data")
    with pytest.raises(ValueError, match="Unexpected"):
        cleanup_function()(tmp_path, apply=True)
    assert (audio / "keep.txt").exists()

