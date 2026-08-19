import io
import base64
import logging
from google import genai
from google.genai.errors import APIError
from pydub import AudioSegment

from app.config import settings
from app.services.engines.base import BaseTTSEngine, VoiceInfo

logger = logging.getLogger(__name__)


class TTSException(Exception):
    """Base exception for TTS service errors."""
    pass


class TTSConfigError(TTSException):
    """Raised when TTS configuration or credentials are missing."""
    pass


class TTSTimeoutError(TTSException):
    """Raised when the TTS API request times out."""
    pass


class TTSUpstreamError(TTSException):
    """Raised when the TTS upstream provider returns an error response."""
    def __init__(self, status_code: int, detail: str):
        super().__init__(f"Upstream TTS error {status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail


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


def pcm_to_mp3(
    pcm_data: bytes,
    sample_rate: int = 24000,
    channels: int = 1,
    sample_width: int = 2
) -> bytes:
    """Converts raw PCM audio data to MP3 format using pydub."""
    segment = AudioSegment(
        data=pcm_data,
        sample_width=sample_width,
        frame_rate=sample_rate,
        channels=channels
    )
    buf = io.BytesIO()
    segment.export(buf, format="mp3", bitrate="128k")
    return buf.getvalue()


class GeminiTTSEngine(BaseTTSEngine):
    """Google Gemini 2.5 Flash TTS Engine (High fidelity, BYOK or server key)."""

    def __init__(self):
        self._server_client: genai.Client | None = None

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
        return "Kore"

    @property
    def server_has_key(self) -> bool:
        return bool(settings.GEMINI_API_KEY)

    def get_voices(self) -> list[VoiceInfo]:
        return SUPPORTED_VOICES

    def _resolve_client(self, api_key: str | None = None) -> genai.Client:
        """
        Resolve genai.Client prioritizing client-provided BYOK key,
        falling back to server-level GEMINI_API_KEY.
        """
        effective_key = api_key.strip() if (api_key and api_key.strip()) else settings.GEMINI_API_KEY

        if not effective_key:
            raise TTSConfigError(
                "Gemini TTS 服务需要 API Key。请在右上角设置中填写您的 Gemini API Key，或切换为 Edge TTS 免费模型。"
            )

        if api_key and api_key.strip():
            # Create a client for the user's custom key
            return genai.Client(api_key=effective_key)

        # Server-level singleton client
        if self._server_client is None:
            self._server_client = genai.Client(api_key=effective_key)
            logger.info("Initialized server singleton genai.Client.")
        return self._server_client

    async def synthesize(
        self,
        text: str,
        voice: str | None = None,
        api_key: str | None = None,
    ) -> bytes:
        client = self._resolve_client(api_key=api_key)
        model = settings.GEMINI_TTS_MODEL or "gemini-2.5-flash-preview-tts"
        selected_voice = voice or self.default_voice

        # Validate voice against supported list
        if not any(v["id"] == selected_voice for v in SUPPORTED_VOICES):
            selected_voice = self.default_voice

        logger.info(
            "Synthesizing speech via Gemini TTS model=%s voice=%s length=%d byok=%s",
            model, selected_voice, len(text), bool(api_key and api_key.strip())
        )

        try:
            interaction = await client.aio.interactions.create(
                model=model,
                input=text,
                response_format={"type": "audio"},
                generation_config={
                    "speech_config": [
                        {"voice": selected_voice}
                    ]
                }
            )

            if not interaction.output_audio or not interaction.output_audio.data:
                logger.error("Gemini TTS did not return audio data in interaction output.")
                raise TTSUpstreamError(502, "Gemini TTS did not return any audio data.")

            # Decode base64 PCM data
            raw_pcm = base64.b64decode(interaction.output_audio.data)

            # Convert PCM to MP3
            mp3_audio = pcm_to_mp3(raw_pcm, sample_rate=24000, channels=1, sample_width=2)
            return mp3_audio

        except APIError as exc:
            status_code = getattr(exc, "code", 502) or 502
            message = getattr(exc, "message", str(exc))
            logger.error("Gemini API error during TTS synthesis: status=%s, message=%s", status_code, message)
            raise TTSUpstreamError(int(status_code), f"Gemini API Error: {message}") from exc
        except TimeoutError as exc:
            logger.error("Gemini TTS request timed out.")
            raise TTSTimeoutError("Gemini TTS request timed out.") from exc
        except TTSException:
            raise
        except Exception as exc:
            logger.exception("Unexpected error during Gemini TTS synthesis: %s", type(exc).__name__)
            raise TTSException("Failed to generate audio via Gemini TTS.") from exc
