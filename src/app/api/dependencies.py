import hmac
import hashlib
from typing import Annotated

from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.validation import normalize_client_id


async def require_client_id(x_client_id: Annotated[str, Header(alias="X-Client-ID")]) -> str:
    try:
        value = normalize_client_id(x_client_id)
        if value.startswith("account_"):
            raise HTTPException(401, "账号数据需要登录后才能访问。")
        return value
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


async def require_tts_identity(
    x_client_id: Annotated[str | None, Header(alias="X-Client-ID")] = None,
    x_authenticated_user: Annotated[str | None, Header(alias="X-Authenticated-User", max_length=512)] = None,
    x_auth_proxy_secret: Annotated[str | None, Header(alias="X-Auth-Proxy-Secret", max_length=256)] = None,
    request: Request = None,
) -> str:
    # Private mode never falls back to a browser-supplied client identifier,
    # even in development. Tests use the same proxy contract as production.
    return await _resolve_identity(request, x_client_id, x_authenticated_user, x_auth_proxy_secret,
                                   browser_mode=settings.TTS_STORAGE_MODE == "legacy")


async def _resolve_identity(
    request: Request | None, client_id: str | None, user: str | None, secret: str | None,
    *, browser_mode: bool, missing_auth_detail: str = "需要登录后才能访问个人数据。",
) -> str:
    from app.services import auth_service as auth

    if settings.ACCOUNT_AUTH_REQUIRED or (browser_mode and request is not None and auth.has_credentials(request)):
        if request is None:
            raise HTTPException(401, "需要登录后才能继续。")
        context = await run_in_threadpool(auth.authenticate, request)
        return auth.account_owner(context.user)
    if browser_mode:
        return await require_client_id(client_id)
    return trusted_identity(user, secret, missing_auth_detail=missing_auth_detail)


def trusted_identity(
    user: str | None,
    secret: str | None,
    *,
    missing_auth_detail: str = "需要登录后才能访问个人数据。",
) -> str:
    supplied = (secret or "").encode()
    expected = settings.AUTH_PROXY_SECRET.encode()
    if len(expected) < 32 or not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(401, missing_auth_detail)
    identity = (user or "").strip()
    if not identity or any(ord(char) < 32 or ord(char) == 127 for char in identity):
        raise HTTPException(401, "身份信息无效。")
    return hashlib.sha256(f"copilot:{identity}".encode("utf-8")).hexdigest()


async def require_copilot_identity(
    x_client_id: Annotated[str | None, Header(alias="X-Client-ID", max_length=128)] = None,
    x_authenticated_user: Annotated[
        str | None, Header(alias="X-Authenticated-User", max_length=512)
    ] = None,
    x_auth_proxy_secret: Annotated[
        str | None, Header(alias="X-Auth-Proxy-Secret", max_length=256)
    ] = None,
    request: Request = None,
) -> str:
    """Resolve Copilot ownership without trusting a public browser in production.

    The edge proxy must strip both identity headers from incoming traffic and inject
    them only on the private hop to this application.
    """
    return await _resolve_identity(
        request, x_client_id, x_authenticated_user, x_auth_proxy_secret,
        browser_mode=settings.COPILOT_AUTH_MODE == "development",
        missing_auth_detail="需要登录后才能使用 AI 讲解。",
    )


async def gemini_request_key(
    x_gemini_api_key: Annotated[str | None, Header(alias="X-Gemini-Api-Key", max_length=256)] = None,
    x_server_key_token: Annotated[str | None, Header(alias="X-Server-Key-Token", max_length=256)] = None,
) -> str | None:
    if x_gemini_api_key and x_gemini_api_key.strip():
        key = x_gemini_api_key.strip()
        if not key.isascii() or any(c.isspace() for c in key):
            raise HTTPException(422, "API Key 格式无效。")
        return key
    if x_server_key_token:
        expected = settings.SERVER_KEY_ACCESS_TOKEN
        if not expected or not hmac.compare_digest(x_server_key_token.encode(), expected.encode()):
            raise HTTPException(403, "服务端 Key 访问未授权。")
        return settings.GEMINI_API_KEY or None
    # Knowing a client UUID never grants access to a paid server credential.
    return None
