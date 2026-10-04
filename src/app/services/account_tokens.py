import secrets
import sqlite3
import time

from app.services.auth_service import AuthError, digest
from app.services.database import connection as account_connection
from app.services.timestamps import utc_timestamp
from app.services.passwords import hash_password, verify_password
from app.services.user_service import User, user_from_row
from app.config import settings


def issue_email_token(email: str, purpose: str) -> str | None:
    """Unknown and ineligible addresses are indistinguishable to the caller."""
    now = time.time()
    with account_connection(write=True) as conn:
        conn.execute("delete from auth_tokens where expires_at <= ?", (now,))
        row = conn.execute("select * from users where email=? and is_active=1", (email,)).fetchone()
        if not row or (purpose == "verify" and row["email_verified"]) or (purpose == "reset" and not row["email_verified"]):
            return None
        last = conn.execute("select created_at from auth_tokens where user_id=? and purpose=? order by created_at desc limit 1", (row["id"], purpose)).fetchone()
        if last and last["created_at"] > now - 60:
            return None
        token = secrets.token_urlsafe(32)
        lifetime = settings.AUTH_VERIFY_TOKEN_SECONDS if purpose == "verify" else settings.AUTH_RESET_TOKEN_SECONDS
        conn.execute("delete from auth_tokens where user_id=? and purpose=?", (row["id"], purpose))
        conn.execute(
            "insert into auth_tokens (token_hash, user_id, purpose, email, expires_at, created_at) values (?, ?, ?, ?, ?, ?)",
            (digest(token), row["id"], purpose, row["email"], now + lifetime, now),
        )
        return token


def consume_token(conn: sqlite3.Connection, token: str, purpose: str) -> sqlite3.Row:
    row = conn.execute(
        "select t.*, u.email_verified from auth_tokens t join users u on u.id=t.user_id "
        "where t.token_hash=? and t.purpose=? and t.expires_at>? and u.is_active=1 and t.email=u.email",
        (digest(token), purpose, time.time()),
    ).fetchone()
    if not row or (purpose == "reset" and not row["email_verified"]):
        raise AuthError(400, "链接无效或已过期，请重新申请。")
    conn.execute("delete from auth_tokens where token_hash=?", (digest(token),))
    return row


def verify_email(token: str) -> None:
    with account_connection(write=True) as conn:
        row = consume_token(conn, token, "verify")
        conn.execute("update users set email_verified=1, updated_at=? where id=?", (utc_timestamp(), row["user_id"]))


def reset_password(token: str, password: str) -> None:
    # Check before the expensive hash, then atomically recheck and consume.
    with account_connection() as conn:
        row = conn.execute("select 1 from auth_tokens where token_hash=? and purpose='reset' and expires_at>?", (digest(token), time.time())).fetchone()
        if not row:
            raise AuthError(400, "链接无效或已过期，请重新申请。")
    password_hash = hash_password(password)
    with account_connection(write=True) as conn:
        row = consume_token(conn, token, "reset")
        conn.execute("update users set password_hash=?, updated_at=? where id=?", (password_hash, utc_timestamp(), row["user_id"]))
        conn.execute("delete from auth_tokens where user_id=?", (row["user_id"],))
        conn.execute("delete from auth_sessions where user_id=?", (row["user_id"],))


def change_email(user: User, email: str, password: str | None) -> User:
    if not user.has_password:
        raise AuthError(403, "第三方账号请先通过已验证邮箱设置本地密码；没有邮箱时请在 GitHub 验证邮箱后重新登录。")
    if not verify_password(user.password_hash, password or ""):
        raise AuthError(401, "当前密码错误。")
    with account_connection(write=True) as conn:
        row = conn.execute("select * from users where id=? and is_active=1", (user.id,)).fetchone()
        if not row or row["password_hash"] != user.password_hash:
            raise AuthError(401, "登录已失效，请重新登录。")
        if row["email"] == email:
            return user_from_row(row)
        try:
            conn.execute("update users set email=?, email_verified=0, updated_at=? where id=?", (email, utc_timestamp(), user.id))
        except sqlite3.IntegrityError:
            raise AuthError(409, "邮箱已被使用。") from None
        conn.execute("delete from auth_tokens where user_id=?", (user.id,))
        return user_from_row(conn.execute("select * from users where id=?", (user.id,)).fetchone())
