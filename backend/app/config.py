import os
import math
from pathlib import Path
from dotenv import load_dotenv

# Search for .env in current directory or backend directory
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    load_dotenv()

def positive_number(name: str, default: str, cast=int):
    value = cast(os.getenv(name, default))
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return value


class Settings:
    # Supports GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, TTS_API_KEY
    GEMINI_API_KEY: str = (
        os.getenv("GOOGLE_GENERATIVE_AI_API_KEY")
        or os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_API_KEY")
        or os.getenv("TTS_API_KEY", "")
    )
    GEMINI_TTS_MODEL: str = os.getenv("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
    GEMINI_TEXT_MODEL: str = os.getenv("GEMINI_TEXT_MODEL", "gemini-3.8-flash")
    GEMINI_TTS_VOICE: str = os.getenv("GEMINI_TTS_VOICE", "Kore")
    SERVER_KEY_ACCESS_TOKEN: str = os.getenv("SERVER_KEY_ACCESS_TOKEN", "")
    CORS_ORIGINS: list[str] = [v.strip() for v in os.getenv("CORS_ORIGINS", "").split(",") if v.strip()]
    MAX_TEXT_LENGTH: int = positive_number("MAX_TEXT_LENGTH", "1000")
    MIN_TEXT_LENGTH: int = positive_number("MIN_TEXT_LENGTH", "1")
    TTS_TIMEOUT_SECONDS: float = positive_number("TTS_TIMEOUT_SECONDS", "30", float)
    QUEUE_TIMEOUT_SECONDS: float = positive_number("QUEUE_TIMEOUT_SECONDS", "5", float)
    EDGE_TTS_MAX_CONCURRENCY: int = positive_number("EDGE_TTS_MAX_CONCURRENCY", "3")
    GEMINI_MAX_CONCURRENCY: int = positive_number("GEMINI_MAX_CONCURRENCY", "3")
    MAX_PENDING_REQUESTS: int = positive_number("MAX_PENDING_REQUESTS", "16")
    MAX_REQUEST_BODY_BYTES: int = positive_number("MAX_REQUEST_BODY_BYTES", "16384")
    REQUEST_BODY_TIMEOUT_SECONDS: float = positive_number("REQUEST_BODY_TIMEOUT_SECONDS", "10", float)
    REQUESTS_PER_MINUTE: int = positive_number("REQUESTS_PER_MINUTE", "120")
    GLOBAL_REQUESTS_PER_MINUTE: int = positive_number("GLOBAL_REQUESTS_PER_MINUTE", "600")
    CACHE_MAX_BYTES: int = positive_number("CACHE_MAX_BYTES", "536870912")
    CACHE_MAX_ENTRIES: int = positive_number("CACHE_MAX_ENTRIES", "1000")
    CACHE_TTL_SECONDS: int = positive_number("CACHE_TTL_SECONDS", "604800")
    CACHE_MIN_FREE_BYTES: int = positive_number("CACHE_MIN_FREE_BYTES", "67108864")
    MAX_AUDIO_BYTES: int = positive_number("MAX_AUDIO_BYTES", "16777216")
    MEMORY_CACHE_MAX_BYTES: int = positive_number("MEMORY_CACHE_MAX_BYTES", "33554432")
    DB_BUSY_TIMEOUT_SECONDS: float = positive_number("DB_BUSY_TIMEOUT_SECONDS", "0.5", float)
    DB_MAX_BYTES: int = positive_number("DB_MAX_BYTES", "134217728")
    HISTORY_MAX_RECORDS: int = positive_number("HISTORY_MAX_RECORDS", "10000")
    EXPLANATION_MAX_RECORDS: int = positive_number("EXPLANATION_MAX_RECORDS", "1000")

    def __init__(self):
        if self.MIN_TEXT_LENGTH > self.MAX_TEXT_LENGTH or self.MAX_TEXT_LENGTH > 1000:
            raise ValueError("Text limits must satisfy 1 <= MIN_TEXT_LENGTH <= MAX_TEXT_LENGTH <= 1000")
        if self.SERVER_KEY_ACCESS_TOKEN and len(self.SERVER_KEY_ACCESS_TOKEN) < 32:
            raise ValueError("SERVER_KEY_ACCESS_TOKEN must contain at least 32 characters")

settings = Settings()
