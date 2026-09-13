import asyncio
import base64
import logging

from app.config import settings
from app.services.engines.base import BaseTTSEngine, VoiceInfo
from app.services.errors import TTSException, TTSConfigError, TTSTimeoutError, TTSUpstreamError, provider_error
from app.services.gemini_client import create_client, managed_client
from app.services.runtime import request_deadline, upstream_slot

logger = logging.getLogger(__name__)


SUPPORTED_VOICES: list[VoiceInfo] = [
    {
        "id": "Kore",
        "name": "Kore (女性・標準推奨)",
        "gender": "female",
        "description": "落ち着きと明瞭さのある標準的な女性の声。ニュース・日常会話に最適。",
    },
    {
        "id": "Aoede",
        "name": "Aoede (女性・柔らか)",
        "gender": "female",
        "description": "清涼感のある柔らかな女性の声。穏やかな対話や朗読向け。",
    },
    {
        "id": "Leda",
        "name": "Leda (女性・若々しい)",
        "gender": "female",
        "description": "若々しく快活な女性の声。アニメ風対白や明るいトーン向け。",
    },
    {
        "id": "Zephyr",
        "name": "Zephyr (女性・明るい)",
        "gender": "female",
        "description": "明るく親しみやすい女性の声。ガイドやナレーション向け。",
    },
    {
        "id": "Puck",
        "name": "Puck (男性・活発)",
        "gender": "male",
        "description": "明るくテンポの良い若々しい男性の声。日常会話に最適。",
    },
    {
        "id": "Charon",
        "name": "Charon (男性・低音)",
        "gender": "male",
        "description": "低音で落ち着いた説得力のある男性の声。ニュース・解説向け。",
    },
    {
        "id": "Fenrir",
        "name": "Fenrir (男性・力強い)",
        "gender": "male",
        "description": "張りのある力強い男性の声。感情豊かな台詞向け。",
    },
    {
        "id": "Orus",
        "name": "Orus (男性・重厚)",
        "gender": "male",
        "description": "重厚で風格のある男性の声。格式高い朗読向け。",
    },
]


async def pcm_to_mp3(
    pcm_data: bytes,
    sample_rate: int = 24000,
    channels: int = 1,
    sample_width: int = 2
) -> bytes:
    """Run the existing ffmpeg conversion without blocking the event loop."""
    if sample_width != 2:
        raise ValueError("Only 16-bit PCM is supported")
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "s16le",
        "-ar", str(sample_rate), "-ac", str(channels), "-i", "pipe:0",
        "-f", "mp3", "-b:a", "128k", "pipe:1",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        async with request_deadline():
            output, _ = await process.communicate(pcm_data)
        if process.returncode or not 0 < len(output) <= settings.MAX_AUDIO_BYTES:
            raise TTSUpstreamError(502, "Audio conversion failed")
        return output
    finally:
        if process.returncode is None:
            process.kill()
            await process.communicate()


class GeminiTTSEngine(BaseTTSEngine):
    """Google Gemini 2.5 Flash TTS Engine (High fidelity, BYOK or server key)."""

    @property
    def engine_id(self) -> str:
        return "gemini"

    @property
    def name(self) -> str:
        return "Gemini TTS (高品質・BYOK)"

    @property
    def description(self) -> str:
        return "Google Gemini 2.5 Flash 语音合成。多语言支持，具备高拟真表现力，支持自带 API Key (BYOK)。"

    @property
    def is_free(self) -> bool:
        return False

    @property
    def default_voice(self) -> str:
        voice = settings.GEMINI_TTS_VOICE
        if not any(item["id"] == voice for item in SUPPORTED_VOICES):
            raise TTSConfigError("GEMINI_TTS_VOICE 不在支持的音色列表中。")
        return voice

    @property
    def server_has_key(self) -> bool:
        # Public browsers must provide BYOK; server-key access needs a trusted proxy.
        return False

    def get_voices(self) -> list[VoiceInfo]:
        return SUPPORTED_VOICES

    async def synthesize(
        self, text: str, voice: str | None = None, api_key: str | None = None,
    ) -> bytes:
        selected_voice = voice or self.default_voice
        if not any(v["id"] == selected_voice for v in SUPPORTED_VOICES):
            raise TTSConfigError("不支持的 Gemini 音色。")
        try:
            async with request_deadline(), upstream_slot("gemini"):
                async with managed_client(create_client(api_key)) as client:
                    interaction = await client.aio.interactions.create(
                        model=settings.GEMINI_TTS_MODEL,
                        input=text,
                        response_format={"type": "audio"},
                        generation_config={"speech_config": [{"voice": selected_voice}]},
                    )
                    audio = interaction.output_audio
                    if not audio or not audio.data or len(audio.data) > settings.MAX_AUDIO_BYTES * 4:
                        raise TTSUpstreamError(502, "Invalid audio response")
                    mime_parts = (audio.mime_type or "audio/l16").lower().split(";")
                    parameters = dict(part.strip().split("=", 1) for part in mime_parts[1:] if "=" in part)
                    sample_rate = int(getattr(audio, "sample_rate", None) or parameters.get("rate", 24000))
                    channels = getattr(audio, "channels", None) or 1
                    if mime_parts[0].strip() not in {"audio/l16", "audio/pcm"} or not 8000 <= sample_rate <= 48000 or channels not in (1, 2):
                        raise TTSUpstreamError(502, "Unsupported audio format")
                    raw_pcm = base64.b64decode(audio.data, validate=True)
                    if not raw_pcm or len(raw_pcm) % (2 * channels):
                        raise TTSUpstreamError(502, "Invalid PCM response")
                    return await pcm_to_mp3(raw_pcm, sample_rate=sample_rate, channels=channels)
        except TTSException:
            raise
        except Exception as exc:
            raise provider_error(exc, "gemini") from None
