"""Offline, opt-in phase-two cleanup. Defaults to a read-only inventory."""

import argparse
import json
import re
import sqlite3
from pathlib import Path


LEGACY_FILE = re.compile(r"[0-9a-f]{16}\.(?:mp3|timeline\.json)(?:\.tmp_[0-9a-f]+)?\Z")


def cleanup(cache_root: Path, *, apply: bool = False) -> dict:
    root = cache_root.resolve(strict=True)
    audio = root / "audio"
    database = root / "history.db"
    # Never accept linked directories/files, nested trees, or unrelated files.
    for path in (audio, database):
        if path.is_symlink() or path.is_junction():
            raise ValueError(f"Unexpected linked path: {path.name}")
    candidates = list(audio.iterdir()) if audio.exists() else []
    for path in candidates:
        if (not path.is_file() or path.is_symlink() or path.is_junction()
                or not LEGACY_FILE.fullmatch(path.name) or path.resolve().parent != audio):
            raise ValueError(f"Unexpected legacy audio entry: {path.name}")
    rows = 0
    if database.exists():
        mode = "rw" if apply else "ro"
        conn = sqlite3.connect(f"{database.as_uri()}?mode={mode}", uri=True)
        try:
            with conn:
                if apply:
                    conn.execute("begin exclusive")
                exists = conn.execute("select 1 from sqlite_master where type='table' and name='history'").fetchone()
                if exists:
                    rows = conn.execute("select count(*) from history").fetchone()[0]
                    if apply:
                        conn.execute("delete from history")
        finally:
            conn.close()
    if apply:
        # Deletion is repeatable after interruption; no recursive deletion.
        for path in candidates:
            path.unlink()
        if audio.exists():
            audio.rmdir()
    return {"history_rows": rows, "audio_files": len(candidates), "applied": apply}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-root", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--proxy-verified", action="store_true", help="Operator attests proxy acceptance passed")
    parser.add_argument("--service-stopped", action="store_true", help="Operator attests app workers are stopped")
    args = parser.parse_args()
    if args.apply and not (args.proxy_verified and args.service_stopped):
        parser.error("--apply requires --proxy-verified and --service-stopped")
    print(json.dumps(cleanup(args.cache_root, apply=args.apply)))


if __name__ == "__main__":
    main()
