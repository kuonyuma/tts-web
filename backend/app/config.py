import os
from pathlib import Path
from dotenv import load_dotenv

# Search for .env in current directory or backend directory
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    load_dotenv()

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
    MAX_TEXT_LENGTH: int = int(os.getenv("MAX_TEXT_LENGTH", "1000"))
    MIN_TEXT_LENGTH: int = int(os.getenv("MIN_TEXT_LENGTH", "1"))
    TTS_TIMEOUT_SECONDS: float = float(os.getenv("TTS_TIMEOUT_SECONDS", "30.0"))
    EDGE_TTS_MAX_CONCURRENCY: int = int(os.getenv("EDGE_TTS_MAX_CONCURRENCY", "3"))

settings = Settings()
