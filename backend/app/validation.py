import re

from app.config import settings

CACHE_KEY_PATTERN = r"^[0-9a-f]{16}$"
CLIENT_ID_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"


def normalize_client_id(value: str | None) -> str:
    value = value.strip() if value else ""
    if not re.fullmatch(CLIENT_ID_PATTERN, value) or value == "default":
        raise ValueError("X-Client-ID must be a non-empty client identifier (not 'default')")
    return value


def validate_text(value: str) -> str:
    trimmed = value.strip()
    if not settings.MIN_TEXT_LENGTH <= len(trimmed) <= settings.MAX_TEXT_LENGTH:
        raise ValueError(f"Text length must be {settings.MIN_TEXT_LENGTH}..{settings.MAX_TEXT_LENGTH}")
    try:
        trimmed.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("Text must contain valid Unicode characters") from None
    return trimmed
