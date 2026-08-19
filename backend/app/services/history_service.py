import sqlite3
import logging
from pathlib import Path
from contextlib import contextmanager

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).resolve().parent.parent / "cache" / "history.db"


_initialized = False


def init_db() -> None:
    """Create the history table if it doesn't exist and run migrations."""
    global _initialized
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("pragma journal_mode=wal")
        cursor = conn.execute("select name from sqlite_master where type='table' and name='history'")
        table_exists = cursor.fetchone() is not None

        if not table_exists:
            conn.execute("""
                create table history (
                    id             integer primary key autoincrement,
                    client_id      text    not null default 'default',
                    text           text    not null,
                    voice          text    not null,
                    model          text    not null,
                    engine         text    not null default 'edge',
                    cache_key      text    not null,
                    created_at     text    not null default (datetime('now', 'localtime')),
                    last_played_at text    not null default (datetime('now', 'localtime')),
                    unique(client_id, cache_key)
                )
            """)
            conn.execute("create index if not exists idx_history_client on history(client_id, last_played_at desc)")
            conn.commit()
        else:
            cursor = conn.execute("pragma table_info(history)")
            columns = [row["name"] for row in cursor.fetchall()]
            if "client_id" not in columns:
                # Migrate to new schema with client_id and compound unique(client_id, cache_key)
                conn.execute("""
                    create table history_migration (
                        id             integer primary key autoincrement,
                        client_id      text    not null default 'default',
                        text           text    not null,
                        voice          text    not null,
                        model          text    not null,
                        engine         text    not null default 'edge',
                        cache_key      text    not null,
                        created_at     text    not null default (datetime('now', 'localtime')),
                        last_played_at text    not null default (datetime('now', 'localtime')),
                        unique(client_id, cache_key)
                    )
                """)
                engine_col = "engine" if "engine" in columns else "'edge' as engine"
                conn.execute(f"""
                    insert into history_migration (id, client_id, text, voice, model, engine, cache_key, created_at, last_played_at)
                    select id, 'default' as client_id, text, voice, model, {engine_col}, cache_key, created_at, last_played_at from history
                """)
                conn.execute("drop table history")
                conn.execute("alter table history_migration rename to history")
                conn.execute("create index if not exists idx_history_client on history(client_id, last_played_at desc)")
                conn.commit()
            else:
                if "engine" not in columns:
                    conn.execute("alter table history add column engine text not null default 'gemini'")
                conn.execute("create index if not exists idx_history_client on history(client_id, last_played_at desc)")
                conn.commit()
        _initialized = True
    finally:
        conn.close()
    logger.info("History database initialized at %s", DB_PATH)


@contextmanager
def _get_conn():
    """Context manager for SQLite connections with Row factory."""
    if not _initialized:
        init_db()
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def add_or_touch(client_id: str, text: str, voice: str, model: str, engine: str, cache_key: str) -> None:
    """Insert a new history record for a client, or update last_played_at if it already exists."""
    cid = client_id.strip() if client_id and client_id.strip() else "default"
    with _get_conn() as conn:
        cursor = conn.execute(
            "update history set last_played_at = datetime('now', 'localtime') where client_id = ? and cache_key = ?",
            (cid, cache_key)
        )
        if cursor.rowcount == 0:
            conn.execute(
                "insert into history (client_id, text, voice, model, engine, cache_key) values (?, ?, ?, ?, ?, ?)",
                (cid, text, voice, model, engine, cache_key)
            )
        conn.commit()


def touch(client_id: str, cache_key: str) -> None:
    """Update last_played_at for an existing client history record."""
    cid = client_id.strip() if client_id and client_id.strip() else "default"
    with _get_conn() as conn:
        conn.execute(
            "update history set last_played_at = datetime('now', 'localtime') where client_id = ? and cache_key = ?",
            (cid, cache_key)
        )
        conn.commit()


def list_history(client_id: str, limit: int = 50) -> list[dict]:
    """Return history records for a client ordered by last_played_at descending."""
    cid = client_id.strip() if client_id and client_id.strip() else "default"
    with _get_conn() as conn:
        rows = conn.execute(
            "select id, text, voice, model, engine, cache_key, created_at, last_played_at "
            "from history where client_id = ? order by last_played_at desc limit ?",
            (cid, limit)
        ).fetchall()
        return [dict(row) for row in rows]


def delete_history(client_id: str, history_id: int) -> bool:
    """Delete a client's history record. Returns True if deleted, False otherwise."""
    cid = client_id.strip() if client_id and client_id.strip() else "default"
    with _get_conn() as conn:
        cursor = conn.execute(
            "delete from history where id = ? and client_id = ?",
            (history_id, cid)
        )
        conn.commit()
        return cursor.rowcount > 0


def clear_all_history(client_id: str) -> int:
    """Delete all history records for a client. Returns count of deleted records."""
    cid = client_id.strip() if client_id and client_id.strip() else "default"
    with _get_conn() as conn:
        cursor = conn.execute("delete from history where client_id = ?", (cid,))
        conn.commit()
        return cursor.rowcount
