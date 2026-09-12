import asyncio
import logging
import edge_tts
from app.config import settings
from app.services.engines.base import BaseTTSEngine, VoiceInfo, SentenceCue, TimedSynthesisResult

logger = logging.getLogger(__name__)

SUPPORTED_VOICES: list[VoiceInfo] = [
    {
        "id": "ja-JP-NanamiNeural",
        "name": "七海 (Nanami - 日本語・女性)",
        "gender": "female",
        "description": "明るく親しみやすい標準的な日本語女性の声。日常会話・朗読向け。",
    },
    {
        "id": "ja-JP-KeitaNeural",
        "name": "圭太 (Keita - 日本語・男性)",
        "gender": "male",
        "description": "落ち着きのある自然な日本語男性の声。ニュース・解説向け。",
    },
    {
        "id": "zh-CN-XiaoxiaoNeural",
        "name": "晓晓 (Xiaoxiao - 中文・女性)",
        "gender": "female",
        "description": "温暖亲切、清晰自然的标准普通话女声。",
    },
    {
        "id": "zh-CN-YunxiNeural",
        "name": "云希 (Yunxi - 中文・男性)",
        "gender": "male",
        "description": "沉稳自然、富有表现力的标准普通话男声。",
    },
    {
        "id": "en-US-AvaNeural",
        "name": "Ava (Ava - English · Female)",
        "gender": "female",
        "description": "Clear and natural American English female voice.",
    },
    {
        "id": "en-US-AndrewNeural",
        "name": "Andrew (Andrew - English · Male)",
        "gender": "male",
        "description": "Warm and confident American English male voice.",
    },
]


class EdgeTTSEngine(BaseTTSEngine):
    """Microsoft Edge TTS engine (Free, fast, multi-lingual, no API key required)."""

    def __init__(self):
        self._semaphore: asyncio.Semaphore | None = None

    def _get_semaphore(self) -> asyncio.Semaphore:
        """Lazy-initialize asyncio Semaphore in the running event loop."""
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(settings.EDGE_TTS_MAX_CONCURRENCY)
            logger.info("Initialized Edge TTS concurrency semaphore (limit=%d)", settings.EDGE_TTS_MAX_CONCURRENCY)
        return self._semaphore

    @property
    def engine_id(self) -> str:
        return "edge"

    @property
    def name(self) -> str:
        return "Edge TTS (無料・高速)"

    @property
    def description(self) -> str:
        return "Microsoft 高品质语音合成。多语言支持，完全免费且无需 API Key。"

    @property
    def is_free(self) -> bool:
        return True

    @property
    def default_voice(self) -> str:
        return "ja-JP-NanamiNeural"

    @property
    def supports_sentence_timeline(self) -> bool:
        return True

    def get_voices(self) -> list[VoiceInfo]:
        return SUPPORTED_VOICES

    async def _synthesize_stream(
        self,
        text: str,
        voice: str | None = None,
    ) -> TimedSynthesisResult:
        selected_voice = voice or self.default_voice
        if not any(v["id"] == selected_voice for v in SUPPORTED_VOICES):
            selected_voice = self.default_voice

        logger.info("Synthesizing speech via Edge TTS voice=%s length=%d", selected_voice, len(text))
        semaphore = self._get_semaphore()
        async with semaphore:
            try:
                communicate = edge_tts.Communicate(
                    text,
                    selected_voice,
                    boundary="SentenceBoundary",
                )
                chunks: list[bytes] = []
                raw_boundaries: list[dict] = []

                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        chunks.append(chunk["data"])
                    elif chunk["type"] == "SentenceBoundary":
                        raw_boundaries.append(chunk)

                if not chunks:
                    raise RuntimeError("Edge TTS returned empty audio stream.")

                audio_bytes = b"".join(chunks)

                # Validate and parse sentence boundaries
                sentences: list[SentenceCue] = []
                last_start_ms = -1
                for item in raw_boundaries:
                    raw_text = item.get("text", "")
                    cue_text = raw_text.strip() if isinstance(raw_text, str) else ""
                    if not cue_text:
                        continue
                    try:
                        offset = int(item["offset"])
                        duration = int(item["duration"])
                    except (KeyError, ValueError, TypeError):
                        continue

                    start_ms = offset // 10_000
                    end_ms = (offset + duration) // 10_000

                    if start_ms < 0 or end_ms < start_ms:
                        continue
                    if start_ms < last_start_ms:
                        continue

                    last_start_ms = start_ms
                    sentences.append(SentenceCue(text=cue_text, start_ms=start_ms, end_ms=end_ms))

                if not sentences:
                    logger.warning("Edge TTS returned no valid SentenceBoundary events for text length=%d", len(text))

                return TimedSynthesisResult(audio_bytes=audio_bytes, sentences=sentences)

            except Exception as exc:
                logger.exception("Edge TTS synthesis failed: %s", type(exc).__name__)
                raise RuntimeError(f"Edge TTS synthesis error: {exc}") from exc

    async def synthesize(
        self,
        text: str,
        voice: str | None = None,
        api_key: str | None = None,
    ) -> bytes:
        result = await self._synthesize_stream(text, voice=voice)
        return result.audio_bytes

    async def synthesize_with_timeline(
        self,
        text: str,
        voice: str | None = None,
        api_key: str | None = None,
    ) -> TimedSynthesisResult:
        return await self._synthesize_stream(text, voice=voice)
