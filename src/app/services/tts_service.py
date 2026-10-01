import io
import wave
import logging

from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.schemas.tts import TTSRequest
from app.services.errors import AudioUnavailable, TTSFlowUnsupportedError, TTSAudioTooLargeError
from app.services.runtime import cache_lock, request_deadline
from app.services.tts_storage import AudioAsset, SynthesisSpec, TTSResult, TTSStorage, get_tts_storage
from app.services.engines import (
    get_engine,
    DEFAULT_ENGINE_ID,
    TTSException,
    TTSConfigError,
    TTSTimeoutError,
    TTSUpstreamError,
)
from app.services.engines.base import SentenceCue, TimedSynthesisResult

logger = logging.getLogger(__name__)


class TTSService:
    """Single business entry for generation, replay and playback history."""

    def __init__(self, storage: TTSStorage) -> None:
        self.storage = storage

    async def generate(
        self, owner: str, request: TTSRequest, api_key: str | None, *, flow: bool = False,
    ) -> TTSResult:
        engine = get_engine(request.engine)
        if flow and not engine.supports_sentence_timeline:
            raise TTSFlowUnsupportedError("当前引擎暂不支持句子时间轴，请使用 Edge TTS 或原 /api/tts 接口。")
        spec = SynthesisSpec(
            request.text, engine.engine_id, request.voice or engine.default_voice,
            settings.GEMINI_TTS_MODEL if engine.engine_id == "gemini" else engine.engine_id,
            engine.supports_sentence_timeline,
        )
        plan = self.storage.prepare(owner, spec, flow=flow)
        async with request_deadline(), cache_lock(self.storage.lock_key(owner, plan.key)):
            try:
                asset = await run_in_threadpool(self.storage.get, owner, plan)
            except AudioUnavailable:
                # Only explicit generation may replace unavailable retained audio.
                asset = None
            if asset is not None:
                await run_in_threadpool(self.storage.record_hit, owner, plan)
                return TTSResult(plan.key, asset, True, self.storage.cache_control)
            if spec.engine == "gemini" and not api_key:
                raise TTSConfigError("Gemini TTS 服务需要 API Key。")
            try:
                if plan.with_timeline:
                    timed = await synthesize_with_timeline(
                        text=spec.text, voice=spec.voice, engine=spec.engine, api_key=api_key,
                    )
                    asset = AudioAsset(timed.audio_bytes, spec.engine, spec.voice, [
                        {"index": i, "text": cue.text, "start_ms": cue.start_ms, "end_ms": cue.end_ms}
                        for i, cue in enumerate(timed.sentences)
                    ])
                else:
                    audio = await synthesize(text=spec.text, voice=spec.voice, engine=spec.engine, api_key=api_key)
                    asset = AudioAsset(audio, spec.engine, spec.voice)
            except TTSAudioTooLargeError:
                raise self.storage.audio_limit_error() from None
            await run_in_threadpool(self.storage.save, owner, plan, asset)
            return TTSResult(plan.key, asset, False, self.storage.cache_control)

    async def replay(self, owner: str, key: str, *, flow: bool = False) -> TTSResult:
        async with request_deadline(), cache_lock(self.storage.lock_key(owner, key)):
            asset = await run_in_threadpool(self.storage.replay, owner, key, flow=flow)
        return TTSResult(key, asset, True, self.storage.cache_control)

    async def list_history(self, owner: str, limit: int = 50) -> list[dict]:
        return await run_in_threadpool(self.storage.list_history, owner, limit)

    async def delete_history(self, owner: str, history_id: int) -> bool:
        return await run_in_threadpool(self.storage.delete_history, owner, history_id)

    async def clear_history(self, owner: str) -> int:
        return await run_in_threadpool(self.storage.clear_history, owner)


def get_tts_service() -> TTSService:
    return TTSService(get_tts_storage())


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


async def synthesize_with_timeline(
    text: str,
    voice: str | None = None,
    engine: str = DEFAULT_ENGINE_ID,
    api_key: str | None = None,
) -> TimedSynthesisResult:
    """
    Synthesizes speech and returns both audio bytes and sentence timestamps.

    :param text: Japanese input text
    :param voice: Voice identifier
    :param engine: Engine identifier ('edge', 'gemini')
    :param api_key: Custom API Key for BYOK engines
    :return: TimedSynthesisResult containing MP3 audio bytes and list of SentenceCue
    """
    tts_engine = get_engine(engine)
    if not tts_engine.supports_sentence_timeline:
        raise TTSConfigError(f"当前语音引擎 '{engine}' 暂不支持句子同步。")
    return await tts_engine.synthesize_with_timeline(text, voice=voice, api_key=api_key)


__all__ = [
    "TTSService",
    "get_tts_service",
    "synthesize",
    "synthesize_with_timeline",
    "pcm_to_wav",
    "SentenceCue",
    "TimedSynthesisResult",
    "TTSException",
    "TTSConfigError",
    "TTSTimeoutError",
    "TTSUpstreamError",
]

