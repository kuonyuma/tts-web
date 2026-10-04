import hashlib
import hmac
import logging
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import jwt
from fastapi import Request

from app.config import settings
from app.services.database import connection as account_connection
from app.services.timestamps import utc_timestamp
from app.services.passwords import verify_password
from app.services.user_service import User, user_from_row


SESSION_COOKIE = "tts_session"
CSRF_COOKIE = "tts_csrf"
JWT_ISSUER = "tts-web"
JWT_AUDIENCE = "tts-web-api"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
logger = logging.getLogger(__name__)


class AuthError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


@dataclass(frozen=True)
class AuthContext:
    user: User
    sid_hash: str
    cookie_authenticated: bool


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def signing_key() -> str:
    if settings.AUTH_JWT_SECRET:
        return settings.AUTH_JWT_SECRET
    if settings.APP_ENV == "production":
        raise AuthError(503, "账号认证尚未配置，请联系管理员。")
    # Stable across restarts, and never committed to the repository.
    with account_connection(write=True) as conn:
        row = conn.execute("select value from app_secrets where name='jwt'").fetchone()
        if row:
            return row["value"]
        value = secrets.token_urlsafe(48)
        conn.execute("insert into app_secrets (name, value) values ('jwt', ?)", (value,))
        return value


def _development_loopback_origin(request: Request, origin: str) -> bool:
    """Allow local same-origin development, never an arbitrary request Host."""
    if settings.APP_ENV not in {"development", "test"}:
        return False
    try:
        configured = urlsplit(settings.PUBLIC_BASE_URL)
        supplied = urlsplit(origin)
        target = urlsplit(str(request.url))
        loopback_hosts = {"localhost", "127.0.0.1", "::1"}
        default_port = 443 if supplied.scheme == "https" else 80
        supplied_port = supplied.port if supplied.port is not None else default_port
        target_port = target.port if target.port is not None else default_port
        return (
            configured.hostname in loopback_hosts and supplied.hostname in loopback_hosts
            and supplied.scheme == configured.scheme == target.scheme
            and supplied.hostname == target.hostname
            and supplied_port == target_port
            and supplied.username is None and supplied.password is None
            and not (supplied.path or supplied.query or supplied.fragment)
        )
    except ValueError:
        return False


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin != settings.PUBLIC_BASE_URL and not _development_loopback_origin(request, origin):
        raise AuthError(403, "请求来源无效。")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise AuthError(403, "请求来源无效。")


def rate_limit(request: Request) -> None:
    from app.api.limits import _resolve_client_ip

    now = time.time()
    key = digest(f"auth:{_resolve_client_ip(request.scope)}:{request.url.path}:{int(now // 60)}")
    with account_connection(write=True) as conn:
        conn.execute("delete from auth_rate_limits where expires_at <= ?", (now,))
        row = conn.execute("select attempts from auth_rate_limits where key_hash=?", (key,)).fetchone()
        if row and row["attempts"] >= settings.AUTH_ATTEMPTS_PER_MINUTE:
            raise AuthError(429, "账号请求过于频繁，请稍后重试。")
        conn.execute(
            "insert into auth_rate_limits (key_hash, attempts, expires_at) values (?, 1, ?) "
            "on conflict(key_hash) do update set attempts=attempts+1", (key, now + 120),
        )


def create_session(user_id: int, *, expected_password_hash: str | None = None) -> tuple[User, str, str]:
    key = signing_key()
    now = int(time.time())
    expires = now + settings.AUTH_SESSION_SECONDS
    sid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    with account_connection(write=True) as conn:
        row = conn.execute("select * from users where id=?", (user_id,)).fetchone()
        if not row or not row["is_active"] or (expected_password_hash is not None and row["password_hash"] != expected_password_hash):
            raise AuthError(401, "账号或密码错误。")
        user = user_from_row(row)
        conn.execute("delete from auth_sessions where expires_at <= ?", (now,))
        conn.execute(
            "insert into auth_sessions (sid_hash, user_id, csrf_hash, expires_at, created_at) values (?, ?, ?, ?, ?)",
            (digest(sid), user.id, digest(csrf), expires, utc_timestamp()),
        )
    token = jwt.encode({
        "sub": str(user.id), "jti": sid, "iat": now, "nbf": now, "exp": expires,
        "iss": JWT_ISSUER, "aud": JWT_AUDIENCE, "type": "access",
    }, key, algorithm="HS256")
    return user, token, csrf


def login(identity: str, password: str) -> tuple[User, str, str]:
    with account_connection() as conn:
        row = conn.execute("select * from users where username=? or email=?", (identity, identity)).fetchone()
    valid = verify_password(row["password_hash"] if row else None, password)
    if not row or not valid or not row["is_active"]:
        reason = "identity_not_found" if not row else "account_inactive" if not row["is_active"] else "password_mismatch"
        logger.warning("account_login_rejected reason=%s", reason)
        raise AuthError(401, "账号或密码错误。")
    return create_session(row["id"], expected_password_hash=row["password_hash"])


def has_credentials(request: Request) -> bool:
    return bool(request.headers.get("authorization") or request.cookies.get(SESSION_COOKIE))


def authenticate(request: Request) -> AuthContext:
    authorization = request.headers.get("authorization")
    cookie_auth = not bool(authorization)
    if authorization:
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            raise AuthError(401, "登录已失效，请重新登录。")
        token = parts[1]
    else:
        token = request.cookies.get(SESSION_COOKIE)
    if not token or len(token) > 4096:
        raise AuthError(401, "需要登录后才能继续。")
    try:
        claims = jwt.decode(
            token, signing_key(), algorithms=["HS256"], issuer=JWT_ISSUER, audience=JWT_AUDIENCE,
            options={"require": ["sub", "jti", "iat", "nbf", "exp", "iss", "aud"], "strict_aud": True},
        )
        if (claims.get("type") != "access" or not isinstance(claims["sub"], str)
                or not claims["sub"].isdigit() or len(claims["sub"]) > 18
                or not isinstance(claims["jti"], str) or len(claims["jti"]) != 43):
            raise ValueError("Invalid access claims")
        user_id = int(claims["sub"])
        sid_hash = digest(claims["jti"])
    except (jwt.PyJWTError, ValueError, TypeError):
        raise AuthError(401, "登录已失效，请重新登录。") from None
    with account_connection() as conn:
        session = conn.execute(
            "select csrf_hash from auth_sessions where sid_hash=? and user_id=? and expires_at>?",
            (sid_hash, user_id, time.time()),
        ).fetchone()
        row = conn.execute("select * from users where id=? and is_active=1", (user_id,)).fetchone()
    if not session or not row:
        raise AuthError(401, "登录已失效，请重新登录。")
    if cookie_auth and request.method not in SAFE_METHODS:
        check_origin(request)
        supplied = request.headers.get("x-csrf-token", "")
        cookie = request.cookies.get(CSRF_COOKIE, "")
        if (not supplied or len(supplied) > 256 or not hmac.compare_digest(supplied.encode(), cookie.encode())
                or not hmac.compare_digest(digest(supplied), session["csrf_hash"])):
            raise AuthError(403, "请求验证失败，请刷新页面后重试。")
    return AuthContext(user_from_row(row), sid_hash, cookie_auth)


def logout(context: AuthContext) -> None:
    with account_connection(write=True) as conn:
        conn.execute("delete from auth_sessions where sid_hash=?", (context.sid_hash,))


def account_owner(user: User) -> str:
    if (settings.ACCOUNT_AUTH_REQUIRED or settings.APP_ENV == "production") and (not user.email or not user.email_verified):
        raise AuthError(403, "请先验证邮箱后再使用此功能。")
    return f"account_{user.id}"


def list_users(limit: int = 100, offset: int = 0) -> list[User]:
    with account_connection() as conn:
        return [user_from_row(row) for row in conn.execute("select * from users order by id limit ? offset ?", (limit, offset))]


def update_user(actor: User, user_id: int, role: str | None, is_active: bool | None) -> User:
    with account_connection(write=True) as conn:
        current_actor = conn.execute("select role, is_active from users where id=?", (actor.id,)).fetchone()
        if not current_actor or current_actor["role"] != "admin" or not current_actor["is_active"]:
            raise AuthError(403, "需要管理员权限。")
        row = conn.execute("select * from users where id=?", (user_id,)).fetchone()
        if not row:
            raise AuthError(404, "用户不存在。")
        next_role = role if role is not None else row["role"]
        next_active = is_active if is_active is not None else bool(row["is_active"])
        if actor.id == user_id and not next_active:
            raise AuthError(409, "不能停用当前管理员账号。")
        if row["role"] == "admin" and row["is_active"] and (next_role != "admin" or not next_active):
            count = conn.execute("select count(*) from users where role='admin' and is_active=1").fetchone()[0]
            if count <= 1:
                raise AuthError(409, "必须保留至少一个可用管理员。")
        conn.execute("update users set role=?, is_active=?, updated_at=? where id=?", (next_role, int(next_active), utc_timestamp(), user_id))
        if not next_active:
            conn.execute("delete from auth_sessions where user_id=?", (user_id,))
        return user_from_row(conn.execute("select * from users where id=?", (user_id,)).fetchone())
