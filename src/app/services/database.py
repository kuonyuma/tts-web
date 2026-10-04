"""Shared SQLite configuration and startup migrations."""

import logging
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import TypeVar

from app.config import settings
from app.services.article_migrations import migrate_articles
from app.services.explanation_migrations import migrate_explanations
from app.services.history_migrations import migrate_history
from app.services.user_migrations import migrate_users

DB_PATH = Path(__file__).resolve().parent.parent / "cache" / "history.db"
_initialized = False
_init_lock = threading.Lock()
logger = logging.getLogger(__name__)
T = TypeVar("T")


def connect_database(path: Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH if path is None else path), timeout=settings.DB_BUSY_TIMEOUT_SECONDS)
    try:
        conn.row_factory = sqlite3.Row
        page_size = conn.execute("pragma page_size").fetchone()[0]
        conn.execute(f"pragma max_page_count={max(1, settings.DB_MAX_BYTES // page_size)}")
        if path is None:
            conn.execute("pragma journal_size_limit=1048576")
        return conn
    except BaseException:
        conn.close()
        raise


def init_db() -> None:
    global _initialized
    with _init_lock:
        if _initialized:
            return
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = connect_database()
        try:
            conn.execute("pragma journal_mode=wal")
            conn.execute("begin immediate")
            migrate_users(conn)
            migrate_articles(conn)
            migrate_history(conn)
            migrate_explanations(conn)
            conn.commit()
            _initialized = True
        finally:
            conn.close()
        logger.info("Database initialized at %s", DB_PATH)


@contextmanager
def connection(
    path: Path | None = None, *, write: bool = False,
    foreign_keys: bool = True, initialize: bool = True,
) -> Iterator[sqlite3.Connection]:
    if initialize:
        init_db()
    conn = connect_database() if path is None else connect_database(path)
    try:
        if foreign_keys:
            conn.execute("pragma foreign_keys=on")
        with conn:
            if write:
                conn.execute("begin immediate")
            yield conn
    finally:
        conn.close()


def run_with_retry(operation: Callable[[], T], *, max_retries: int = 2, delay: float = 0.1) -> T:
    for attempt in range(max_retries + 1):
        try:
            return operation()
        except sqlite3.OperationalError as exc:
            message = str(exc).lower()
            if not ("locked" in message or "busy" in message) or attempt == max_retries:
                raise
            time.sleep(delay * (2 ** attempt))
