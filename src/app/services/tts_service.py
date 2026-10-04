from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.schemas.tts import TTSRequest
from app.services.errors import AudioUnavailable, TTSFlowUnsupportedError, TTSAudioTooLargeError, TTSConfigError
from app.services.runtime import cache_lock, request_deadline
from app.services.tts_storage import AudioAsset, SynthesisSpec, TTSResult, TTSStorage, get_tts_storage
from app.services.engines import get_engine


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
                    timed = await engine.synthesize_with_timeline(
                        text=spec.text, voice=spec.voice, api_key=api_key,
                    )
                    asset = AudioAsset(timed.audio_bytes, spec.engine, spec.voice, [
                        {"index": i, "text": cue.text, "start_ms": cue.start_ms, "end_ms": cue.end_ms}
                        for i, cue in enumerate(timed.sentences)
                    ])
                else:
                    audio = await engine.synthesize(text=spec.text, voice=spec.voice, api_key=api_key)
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
