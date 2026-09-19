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


def env_flag(name: str, default: str = "false") -> bool:
    value = os.getenv(name, default).strip().lower()
    if value not in {"true", "false", "1", "0", "yes", "no"}:
        raise ValueError(f"{name} must be a boolean")
    return value in {"true", "1", "yes"}


def csv_values(name: str, default: str = "") -> tuple[str, ...]:
    return tuple(value.strip() for value in os.getenv(name, default).split(",") if value.strip())


def secret_value(name: str) -> str:
    value = os.getenv(name, "").strip()
    if value:
        return value
    file_name = os.getenv(f"{name}_FILE", "").strip()
    if not file_name:
        return ""
    secret = Path(file_name).read_text(encoding="utf-8")
    if len(secret) > 4096:
        raise ValueError(f"{name}_FILE is unexpectedly large")
    return secret.strip()


class Settings:
    APP_ENV: str = os.getenv("APP_ENV", "development").strip().lower()
    COPILOT_AUTH_MODE: str = os.getenv("COPILOT_AUTH_MODE", "development").strip().lower()
    AUTH_PROXY_SECRET: str = secret_value("AUTH_PROXY_SECRET")
    REDIS_URL: str = os.getenv("REDIS_URL", "").strip()
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
    DEEPSEEK_API_KEY: str = secret_value("DEEPSEEK_API_KEY")
    ZHIPU_API_KEY: str = secret_value("ZHIPU_API_KEY")
    QWEN_API_KEY: str = secret_value("QWEN_API_KEY")
    DEEPSEEK_TEXT_MODEL: str = os.getenv("DEEPSEEK_TEXT_MODEL", "deepseek-flash")
    GLM_TEXT_MODEL: str = os.getenv("GLM_TEXT_MODEL", "glm-5.3-flash")
    QWEN_TEXT_MODEL: str = os.getenv("QWEN_TEXT_MODEL", "qwen3.7-flash-2026-07-15")
    QWEN_API_REGION: str = os.getenv("QWEN_API_REGION", "cn").strip().lower()
    COPILOT_DEFAULT_MODEL: str = os.getenv("COPILOT_DEFAULT_MODEL", "deepseek-flash").strip()
    COPILOT_ENABLED_MODELS: tuple[str, ...] = csv_values(
        "COPILOT_ENABLED_MODELS", "deepseek-flash,qwen-3.7-flash"
    )
    COPILOT_ENABLE_UNVERIFIED_GLM53: bool = env_flag("COPILOT_ENABLE_UNVERIFIED_GLM53")
    COPILOT_PROMPT_VERSION: str = os.getenv("COPILOT_PROMPT_VERSION", "2026-09-v1").strip()
    LLM_TIMEOUT_SECONDS: float = positive_number("LLM_TIMEOUT_SECONDS", "180", float)
    LLM_QUEUE_TIMEOUT_SECONDS: float = positive_number("LLM_QUEUE_TIMEOUT_SECONDS", "5", float)
    LLM_RESPONSE_MAX_BYTES: int = positive_number("LLM_RESPONSE_MAX_BYTES", "1048576")
    DEEPSEEK_MAX_CONCURRENCY: int = positive_number("DEEPSEEK_MAX_CONCURRENCY", "3")
    ZHIPU_MAX_CONCURRENCY: int = positive_number("ZHIPU_MAX_CONCURRENCY", "3")
    QWEN_MAX_CONCURRENCY: int = positive_number("QWEN_MAX_CONCURRENCY", "3")
    COPILOT_USER_MINUTE_UNITS: int = positive_number("COPILOT_USER_MINUTE_UNITS", "20")
    COPILOT_USER_DAILY_UNITS: int = positive_number("COPILOT_USER_DAILY_UNITS", "200")
    COPILOT_GLOBAL_DAILY_UNITS: int = positive_number("COPILOT_GLOBAL_DAILY_UNITS", "10000")
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
        if self.APP_ENV not in {"development", "test", "production"}:
            raise ValueError("APP_ENV must be development, test or production")
        if self.COPILOT_AUTH_MODE not in {"development", "trusted_proxy"}:
            raise ValueError("COPILOT_AUTH_MODE must be development or trusted_proxy")
        if self.COPILOT_AUTH_MODE == "trusted_proxy" and len(self.AUTH_PROXY_SECRET) < 32:
            raise ValueError("AUTH_PROXY_SECRET must contain at least 32 characters")
        if len(self.AUTH_PROXY_SECRET) > 256:
            raise ValueError("AUTH_PROXY_SECRET must contain at most 256 characters")
        if self.APP_ENV == "production" and self.COPILOT_AUTH_MODE != "trusted_proxy":
            raise ValueError("Production Copilot requires COPILOT_AUTH_MODE=trusted_proxy")
        if self.APP_ENV == "production" and not self.REDIS_URL:
            raise ValueError("Production Copilot requires REDIS_URL for distributed quotas")
        if self.APP_ENV == "production":
            if "*" in self.CORS_ORIGINS:
                raise ValueError("Production CORS_ORIGINS cannot contain '*'")
            if any(not origin.startswith("https://") for origin in self.CORS_ORIGINS):
                raise ValueError("Production CORS origins must use HTTPS")
        if self.MIN_TEXT_LENGTH > self.MAX_TEXT_LENGTH or self.MAX_TEXT_LENGTH > 1000:
            raise ValueError("Text limits must satisfy 1 <= MIN_TEXT_LENGTH <= MAX_TEXT_LENGTH <= 1000")
        if self.SERVER_KEY_ACCESS_TOKEN and len(self.SERVER_KEY_ACCESS_TOKEN) < 32:
            raise ValueError("SERVER_KEY_ACCESS_TOKEN must contain at least 32 characters")
        if self.QWEN_API_REGION not in {"cn", "intl"}:
            raise ValueError("QWEN_API_REGION must be 'cn' or 'intl'")
        if not self.COPILOT_PROMPT_VERSION or len(self.COPILOT_PROMPT_VERSION) > 64:
            raise ValueError("COPILOT_PROMPT_VERSION must contain 1..64 characters")

settings = Settings()
