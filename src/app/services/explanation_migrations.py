"""Explanation and copilot storage schema and migrations."""

import sqlite3


def migrate_explanations(conn: sqlite3.Connection) -> None:
    """Participate in startup database transaction to set up explanation tables."""
    conn.execute("""
        create table if not exists explanations (
            id integer primary key autoincrement,
            client_id text not null default 'default',
            text text not null,
            lang text not null default 'zh',
            explain_key text not null,
            explanation text not null,
            messages text not null default '[]',
            model_id text not null default 'gemini-legacy',
            provider text not null default 'gemini',
            upstream_model text not null default 'gemini-legacy',
            mode_id text not null default 'medium',
            profile_revision text not null default 'legacy-v1',
            prompt_version text not null default 'legacy-v1',
            created_at text not null default (datetime('now', 'localtime')),
            updated_at text not null default (datetime('now', 'localtime')),
            unique(client_id, explain_key)
        )
    """)
    columns = {row[1] for row in conn.execute("pragma table_info(explanations)")}
    additions = {
        "model_id": "text not null default 'gemini-legacy'",
        "provider": "text not null default 'gemini'",
        "upstream_model": "text not null default 'gemini-legacy'",
        "mode_id": "text not null default 'medium'",
        "profile_revision": "text not null default 'legacy-v1'",
        "prompt_version": "text not null default 'legacy-v1'",
    }
    for name, definition in additions.items():
        if name not in columns:
            conn.execute(f"alter table explanations add column {name} {definition}")
    conn.execute(
        "create index if not exists idx_explanations_client "
        "on explanations(client_id, updated_at desc)"
    )
    conn.execute("""
        create table if not exists copilot_usage_daily (
            usage_day text not null,
            client_id text not null,
            provider text not null,
            model_id text not null,
            mode_id text not null,
            calls integer not null default 0,
            quota_units integer not null default 0,
            prompt_tokens integer not null default 0,
            completion_tokens integer not null default 0,
            reasoning_tokens integer not null default 0,
            total_tokens integer not null default 0,
            primary key (usage_day, client_id, provider, model_id, mode_id)
        )
    """)
    conn.execute("""
        create table if not exists explanation_storage_reservations (
            token text primary key,
            client_id text not null,
            explain_key text not null,
            expires_at real not null,
            created_at text not null default (datetime('now', 'localtime'))
        )
    """)
    conn.execute(
        "create index if not exists idx_explain_res_expires "
        "on explanation_storage_reservations(expires_at)"
    )
