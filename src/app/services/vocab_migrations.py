import sqlite3


def migrate_vocab(conn: sqlite3.Connection) -> None:
    """Create account-scoped vocabulary items table in the startup transaction."""
    conn.execute("""
        create table if not exists vocab_items (
            id text primary key,
            user_id integer not null references users(id) on delete cascade,
            word text not null,
            surface text not null default '',
            reading text not null default '',
            pos text not null default '',
            meaning text not null default '',
            notes text not null default '',
            context_sentence text not null default '',
            source_article_id text,
            source_title text not null default '',
            review_count integer not null default 0,
            mastered integer not null default 0 check(mastered in (0, 1)),
            created_at text not null,
            updated_at text not null
        )
    """)
    columns = {row[1] for row in conn.execute("pragma table_info(vocab_items)")}
    if "surface" not in columns:
        conn.execute("alter table vocab_items add column surface text not null default ''")
    conn.execute(
        "create index if not exists idx_vocab_owner on vocab_items(user_id, created_at desc)"
    )
    conn.execute(
        "create unique index if not exists idx_vocab_owner_word on vocab_items(user_id, lower(word))"
    )
