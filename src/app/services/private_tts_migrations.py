"""Private TTS storage schema and migrations."""

import sqlite3


def migrate_private_tts(conn: sqlite3.Connection) -> None:
    """Migrate or initialize private TTS storage tables."""
    conn.execute("""
        create table if not exists tts_audio_assets (
            owner_id text not null, cache_key text not null,
            byte_size integer not null, sha256 text not null,
            engine text not null, voice text not null, model text not null,
            timeline_json text not null default '[]',
            status text not null default 'ready',
            last_access_ns integer not null,
            primary key (owner_id, cache_key)
        )
    """)
    conn.execute("""
        create table if not exists tts_history_v2 (
            id integer primary key autoincrement,
            owner_id text not null, cache_key text not null,
            text text not null, voice text not null, model text not null,
            engine text not null,
            created_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')),
            last_played_at text not null default (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')),
            unique(owner_id, cache_key),
            foreign key (owner_id, cache_key)
                references tts_audio_assets(owner_id, cache_key) on delete cascade
        )
    """)
    conn.execute("create index if not exists idx_tts_assets_lru on tts_audio_assets(last_access_ns)")
    conn.execute("create index if not exists idx_tts_assets_owner_lru on tts_audio_assets(owner_id, last_access_ns)")
    conn.execute("create index if not exists idx_tts_history_owner on tts_history_v2(owner_id, last_played_at desc)")
