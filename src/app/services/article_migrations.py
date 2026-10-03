import sqlite3


def migrate_articles(conn: sqlite3.Connection) -> None:
    """Add account articles in the existing startup transaction."""
    conn.execute("""
        create table if not exists articles (
            id text primary key,
            user_id integer not null references users(id) on delete cascade,
            title text not null, content text not null,
            created_at text not null, updated_at text not null,
            revision integer not null default 1,
            deleted integer not null default 0 check(deleted in (0, 1))
        )
    """)
    conn.execute("create index if not exists idx_articles_owner on articles(user_id, deleted, created_at desc)")
