import sqlite3


def migrate_users(conn: sqlite3.Connection) -> None:
    """Add users inside the caller's existing startup migration transaction."""
    conn.execute("""
        create table if not exists users (
            id integer primary key autoincrement,
            username text collate nocase not null unique,
            password_hash text not null,
            created_at text not null,
            updated_at text not null
        )
    """)
    columns = {row[1] for row in conn.execute("pragma table_info(users)")}
    additions = {
        "email": "text collate nocase",
        "email_verified": "integer not null default 0 check(email_verified in (0, 1))",
        "role": "text not null default 'user' check(role in ('user', 'admin'))",
        "is_active": "integer not null default 1 check(is_active in (0, 1))",
    }
    for name, definition in additions.items():
        if name not in columns:
            conn.execute(f"alter table users add column {name} {definition}")
    conn.execute("create unique index if not exists idx_users_email on users(email collate nocase)")
    conn.execute("""
        create table if not exists auth_sessions (
            sid_hash text primary key, user_id integer not null,
            csrf_hash text not null, expires_at real not null,
            created_at text not null,
            foreign key(user_id) references users(id) on delete cascade
        )
    """)
    conn.execute("create index if not exists idx_auth_sessions_user on auth_sessions(user_id)")
    conn.execute("create index if not exists idx_auth_sessions_expires on auth_sessions(expires_at)")
    conn.execute("""
        create table if not exists auth_tokens (
            token_hash text primary key, user_id integer not null,
            purpose text not null check(purpose in ('verify', 'reset')),
            email text not null, expires_at real not null, created_at real not null,
            foreign key(user_id) references users(id) on delete cascade
        )
    """)
    conn.execute("create index if not exists idx_auth_tokens_user on auth_tokens(user_id, purpose)")
    conn.execute("create index if not exists idx_auth_tokens_expires on auth_tokens(expires_at)")
    conn.execute("""
        create table if not exists oauth_states (
            state_hash text primary key, browser_hash text not null,
            verifier text not null, user_id integer,
            session_hash text, expires_at real not null
        )
    """)
    conn.execute("create index if not exists idx_oauth_states_expires on oauth_states(expires_at)")
    conn.execute("""
        create table if not exists oauth_accounts (
            provider text not null, subject text not null, user_id integer not null,
            primary key(provider, subject), unique(user_id, provider),
            foreign key(user_id) references users(id) on delete cascade
        )
    """)
    conn.execute("""
        create table if not exists auth_rate_limits (
            key_hash text primary key, attempts integer not null, expires_at real not null
        )
    """)
    conn.execute("create table if not exists app_secrets (name text primary key, value text not null)")
