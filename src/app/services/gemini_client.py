from contextlib import asynccontextmanager

from google import genai

from app.config import settings
from app.services.errors import TTSConfigError


def create_client(api_key: str | None) -> genai.Client:
    # Only the HTTP dependency may resolve an authorized server credential.
    if not api_key or not api_key.strip():
        raise TTSConfigError("Gemini 服务需要 API Key。请在设置中填写您的 Gemini API Key。")
    client = genai.Client(api_key=api_key.strip(), http_options={
        "timeout": int(settings.TTS_TIMEOUT_SECONDS * 1000),
        "retry_options": {"attempts": 1},
    })
    # google-genai 2.18.1 translates attempts=0 into 1 before Interactions
    # reads it, causing an extra billable attempt. Disable its separate retry
    # configuration explicitly; wire-level regression tests guard this bridge.
    client.aio.interactions.sdk_configuration.retry_config = None
    return client


@asynccontextmanager
async def managed_client(client: genai.Client):
    try:
        yield client
    finally:
        try:
            await client.aio.aclose()
        finally:
            client.close()
