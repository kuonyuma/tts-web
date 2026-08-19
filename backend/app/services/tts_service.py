import io
import wave
import logging

from app.services.engines import (
    get_engine,
    DEFAULT_ENGINE_ID,
    TTSException,
    TTSConfigError,
    TTSTimeoutError,
    TTSUpstreamError,
)

logger = logging.getLogger(__name__)


def pcm_to_wav(
    pcm_data: bytes,
    sample_rate: int = 24000,
    channels: int = 1,
    sample_width: int = 2
) -> bytes:
    """
    Encapsulates raw PCM audio data into a standard WAV container.
    Default: 24kHz, 16-bit (2 bytes), mono (1 channel).
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


async def synthesize(
    text: str,
    voice: str | None = None,
    engine: str = DEFAULT_ENGINE_ID,
    api_key: str | None = None,
) -> bytes:
    """
    Synthesizes speech using the requested engine (default: 'edge').

    :param text: Japanese input text
    :param voice: Voice identifier
    :param engine: Engine identifier ('edge', 'gemini')
    :param api_key: Custom API Key for BYOK engines
    :return: Binary MP3 audio bytes
    """
    tts_engine = get_engine(engine)
    return await tts_engine.synthesize(text, voice=voice, api_key=api_key)


__all__ = [
    "synthesize",
    "pcm_to_wav",
    "TTSException",
    "TTSConfigError",
    "TTSTimeoutError",
    "TTSUpstreamError",
]
