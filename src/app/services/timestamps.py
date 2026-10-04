"""Absolute timestamps shared by account and playback storage."""

import sqlite3
from datetime import datetime, timezone


def history_timestamp(value: str) -> str:
    """Old naive SQLite dates are server local time, never implicitly UTC."""
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.isoformat()


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def absolute_history_row(row: sqlite3.Row) -> dict:
    result = dict(row)
    for field in ("created_at", "last_played_at"):
        result[field] = history_timestamp(result[field])
    return result
