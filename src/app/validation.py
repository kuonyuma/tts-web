import re

from app.config import settings

CACHE_KEY_PATTERN = r"^[0-9a-f]{16}$"
PRIVATE_CACHE_KEY_PATTERN = r"[0-9a-f]{64}\Z"
REPLAY_KEY_PATTERN = r"^(?:[0-9a-f]{16}|[0-9a-f]{64})$"
CLIENT_ID_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"


def normalize_client_id(value: str | None) -> str:
    value = value.strip() if value else ""
    if not re.fullmatch(CLIENT_ID_PATTERN, value) or value == "default":
        raise ValueError("X-Client-ID must be a non-empty client identifier (not 'default')")
    return value


def validate_unicode(value: str, detail: str = "Text must contain valid Unicode characters") -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError(detail) from None
    return value


def normalize_email(value: str | None) -> str | None:
    return value.casefold() if value else None


def validate_text(value: str) -> str:
    trimmed = value.strip()
    if not settings.MIN_TEXT_LENGTH <= len(trimmed) <= settings.MAX_TEXT_LENGTH:
        raise ValueError(f"Text length must be {settings.MIN_TEXT_LENGTH}..{settings.MAX_TEXT_LENGTH}")
    return validate_unicode(trimmed)
