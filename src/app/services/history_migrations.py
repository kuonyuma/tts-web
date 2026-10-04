"""Playback history schema and supported historical upgrades."""

import sqlite3


def _create_history(conn: sqlite3.Connection, table: str) -> None:
    conn.execute(f"""
        create table {table} (
            id integer primary key autoincrement,
            client_id text not null default 'default',
            text text not null,
            voice text not null,
            model text not null,
            engine text not null default 'edge',
            cache_key text not null,
            created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')),
            last_played_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')),
            unique(client_id, cache_key)
        )
    """)


def migrate_history(conn: sqlite3.Connection) -> None:
    """Participate in the caller's existing startup transaction."""
    columns = {row["name"] for row in conn.execute("pragma table_info(history)")}
    if not columns:
        _create_history(conn, "history")
    elif "client_id" not in columns:
        _create_history(conn, "history_migration")
        engine_col = "engine" if "engine" in columns else "'edge' as engine"
        conn.execute(f"""
            insert into history_migration (id, client_id, text, voice, model, engine, cache_key, created_at, last_played_at)
            select id, 'default' as client_id, text, voice, model, {engine_col}, cache_key, created_at, last_played_at from history
        """)
        conn.execute("drop table history")
        conn.execute("alter table history_migration rename to history")
    elif "engine" not in columns:
        conn.execute("alter table history add column engine text not null default 'gemini'")
    conn.execute("create index if not exists idx_history_client on history(client_id, last_played_at desc)")
