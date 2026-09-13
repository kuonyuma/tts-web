import hmac
from typing import Annotated

from fastapi import Header, HTTPException

from app.config import settings
from app.validation import normalize_client_id


async def require_client_id(x_client_id: Annotated[str, Header(alias="X-Client-ID")]) -> str:
    try:
        return normalize_client_id(x_client_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


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
