import base64
import hashlib
import logging
import secrets
import sqlite3
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.schemas.auth import EmailRequest
from app.services.auth_service import AuthContext, AuthError, digest
from app.services.auth_storage import account_connection
from app.services.history_service import utc_timestamp
from app.services.user_service import User, user_from_row


logger = logging.getLogger(__name__)
OAUTH_COOKIE = "tts_oauth_browser"


@dataclass(frozen=True)
class GithubIdentity:
    subject: str
    email: str | None


def require_github() -> None:
    if not settings.GITHUB_CLIENT_ID or not settings.GITHUB_CLIENT_SECRET:
        raise AuthError(503, "GitHub 登录尚未配置，请联系管理员。")


def callback_url() -> str:
    return settings.PUBLIC_BASE_URL + "/api/auth/oauth/github/callback"


def start_github(context: AuthContext | None = None) -> tuple[str, str]:
    require_github()
    state, browser, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    with account_connection(write=True) as conn:
        conn.execute("delete from oauth_states where expires_at <= ?", (time.time(),))
        conn.execute(
            "insert into oauth_states (state_hash, browser_hash, verifier, user_id, session_hash, expires_at) values (?, ?, ?, ?, ?, ?)",
            (digest(state), digest(browser), verifier, context.user.id if context else None,
             context.sid_hash if context else None, time.time() + 600),
        )
    url = "https://github.com/login/oauth/authorize?" + urlencode({
        "client_id": settings.GITHUB_CLIENT_ID, "redirect_uri": callback_url(),
        "scope": "read:user user:email", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
    })
    return url, browser


def consume_state(state: str, browser: str | None) -> dict:
    if not browser or len(browser) > 128:
        raise AuthError(400, "第三方登录请求无效，请重新发起登录。")
    with account_connection(write=True) as conn:
        row = conn.execute(
            "select * from oauth_states where state_hash=? and browser_hash=? and expires_at>?",
            (digest(state), digest(browser), time.time()),
        ).fetchone()
        if not row:
            raise AuthError(400, "第三方登录请求无效或已过期，请重新发起登录。")
        conn.execute("delete from oauth_states where state_hash=?", (digest(state),))
        return dict(row)


async def github_identity(code: str, verifier: str) -> GithubIdentity:
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            result = await client.post("https://github.com/login/oauth/access_token", data={
                "client_id": settings.GITHUB_CLIENT_ID, "client_secret": settings.GITHUB_CLIENT_SECRET,
                "code": code, "redirect_uri": callback_url(), "code_verifier": verifier,
            }, headers={"Accept": "application/json"})
            result.raise_for_status()
            data = result.json()
            token = data.get("access_token")
            if not isinstance(token, str) or not 1 <= len(token) <= 4096 or not token.isascii() or any(c.isspace() for c in token):
                raise ValueError("Invalid provider token")
            headers = {
                "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2026-03-10",
            }
            profile = await client.get("https://api.github.com/user", headers=headers)
            profile.raise_for_status()
            subject = profile.json().get("id")
            if type(subject) is not int or subject <= 0:
                raise ValueError("Invalid provider subject")
            emails_response = await client.get("https://api.github.com/user/emails", headers=headers)
            emails_response.raise_for_status()
            emails = emails_response.json()
            if not isinstance(emails, list):
                raise ValueError("Invalid provider email list")
            verified = [item for item in emails if isinstance(item, dict) and item.get("verified") is True]
            verified.sort(key=lambda item: item.get("primary") is not True)
            email = EmailRequest(email=verified[0]["email"]).email if verified else None
            return GithubIdentity(str(subject), email)
    except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError) as exc:
        logger.warning("oauth_provider_failed provider=github type=%s", type(exc).__name__)
        raise AuthError(502, "GitHub 登录暂时不可用，请稍后重试。") from None


def resolve_account(identity: GithubIdentity, state: dict) -> tuple[User, bool]:
    with account_connection(write=True) as conn:
        existing = conn.execute("select user_id from oauth_accounts where provider='github' and subject=?", (identity.subject,)).fetchone()
        linked = state["user_id"] is not None
        if linked:
            user_id = state["user_id"]
            live = conn.execute("select 1 from auth_sessions where sid_hash=? and user_id=? and expires_at>?", (state["session_hash"], user_id, time.time())).fetchone()
            if not live:
                raise AuthError(401, "关联时的登录已失效，请重新登录。")
            if existing and existing["user_id"] != user_id:
                raise AuthError(409, "该 GitHub 身份已关联其他账号。")
        elif existing:
            user_id = existing["user_id"]
        else:
            if identity.email and conn.execute("select 1 from users where email=?", (identity.email,)).fetchone():
                raise AuthError(409, "该邮箱已有账号，请先登录后关联 GitHub。")
            now = utc_timestamp()
            cursor = conn.execute(
                "insert into users (username, password_hash, email, email_verified, created_at, updated_at) values (?, '!oauth-only', ?, ?, ?, ?)",
                ("gh_" + secrets.token_hex(12), identity.email, int(identity.email is not None), now, now),
            )
            user_id = cursor.lastrowid
        row = conn.execute("select * from users where id=? and is_active=1", (user_id,)).fetchone()
        if not row:
            raise AuthError(401, "账号不可用，请联系管理员。")
        if not linked and existing and not row["email"] and identity.email:
            if conn.execute("select 1 from users where email=? and id<>?", (identity.email, user_id)).fetchone():
                raise AuthError(409, "GitHub 邮箱已有其他账号，请使用不同的已验证邮箱。")
            conn.execute("update users set email=?, email_verified=1, updated_at=? where id=?",
                         (identity.email, utc_timestamp(), user_id))
            row = conn.execute("select * from users where id=?", (user_id,)).fetchone()
        if not existing:
            try:
                conn.execute("insert into oauth_accounts (provider, subject, user_id) values ('github', ?, ?)", (identity.subject, user_id))
            except sqlite3.IntegrityError:
                raise AuthError(409, "当前账号已关联另一个 GitHub 身份。") from None
        if linked and identity.email and identity.email == row["email"]:
            conn.execute("update users set email_verified=1, updated_at=? where id=?", (utc_timestamp(), user_id))
            row = conn.execute("select * from users where id=?", (user_id,)).fetchone()
        return user_from_row(row), linked
