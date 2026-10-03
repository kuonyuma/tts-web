from collections.abc import Iterator
from contextlib import contextmanager
import sqlite3

from app.services import history_service as db


@contextmanager
def account_connection(*, write: bool = False) -> Iterator[sqlite3.Connection]:
    db.init_db()
    conn = db.connect_database()
    try:
        conn.execute("pragma foreign_keys=on")
        with conn:
            if write:
                conn.execute("begin immediate")
            yield conn
    finally:
        conn.close()
