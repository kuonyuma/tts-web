import logging
from datetime import datetime

from app.config import settings
from app.services import database
from app.services.errors import StorageFullError
from app.services.timestamps import absolute_history_row, utc_timestamp
from app.validation import normalize_client_id

logger = logging.getLogger(__name__)


def add_or_touch(client_id: str, text: str, voice: str, model: str, engine: str, cache_key: str) -> None:
    """Insert a new history record for a client, or update last_played_at if it already exists."""
    cid = normalize_client_id(client_id)

    def _do_write():
        with database.connection(foreign_keys=False) as conn:
            conn.execute("begin immediate")
            now = utc_timestamp()
            cursor = conn.execute(
                "update history set last_played_at = ? where client_id = ? and cache_key = ?",
                (now, cid, cache_key)
            )
            if cursor.rowcount == 0:
                count = conn.execute("select count(*) from history").fetchone()[0]
                if count >= int(settings.HISTORY_MAX_RECORDS * 0.85):
                    logger.warning("历史记录条数已达警戒水位 (%d/%d 条)", count, settings.HISTORY_MAX_RECORDS)
                if count >= settings.HISTORY_MAX_RECORDS:
                    raise StorageFullError("History record quota reached")
                conn.execute(
                    "insert into history (client_id, text, voice, model, engine, cache_key, created_at, last_played_at) "
                    "values (?, ?, ?, ?, ?, ?, ?, ?)",
                    (cid, text, voice, model, engine, cache_key, now, now)
                )

    database.run_with_retry(_do_write)


def touch(client_id: str, cache_key: str) -> None:
    """Update last_played_at for an existing client history record."""
    cid = normalize_client_id(client_id)
    with database.connection(foreign_keys=False) as conn:
        conn.execute(
            "update history set last_played_at = ? where client_id = ? and cache_key = ?",
            (utc_timestamp(), cid, cache_key)
        )


def list_history(client_id: str, limit: int = 50) -> list[dict]:
    """Return history records for a client ordered by last_played_at descending."""
    cid = normalize_client_id(client_id)
    with database.connection(foreign_keys=False) as conn:
        rows = conn.execute(
            "select id, text, voice, model, engine, cache_key, created_at, last_played_at "
            "from history where client_id = ? "
            "order by strftime('%Y-%m-%d %H:%M:%f', last_played_at) desc, id desc limit ?",
            (cid, limit),
        ).fetchall()
        return [absolute_history_row(row) for row in rows]


def delete_history(client_id: str, history_id: int) -> bool:
    """Delete a client's history record. Returns True if deleted, False otherwise."""
    cid = normalize_client_id(client_id)
    with database.connection(foreign_keys=False) as conn:
        cursor = conn.execute(
            "delete from history where id = ? and client_id = ?",
            (history_id, cid)
        )
        return cursor.rowcount > 0


def clear_all_history(client_id: str) -> int:
    """Delete all history records for a client. Returns count of deleted records."""
    cid = normalize_client_id(client_id)
    with database.connection(foreign_keys=False) as conn:
        cursor = conn.execute("delete from history where client_id = ?", (cid,))
        return cursor.rowcount
