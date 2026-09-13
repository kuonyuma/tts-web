from pydantic import BaseModel, Field, field_validator, model_validator
from app.validation import validate_text
from app.services.engines import get_engine


class TTSRequest(BaseModel):
    text: str = Field(
        ...,
        min_length=1,
        max_length=1000,
        description="The text to be converted to speech.",
        examples=["今日はいい天気ですね。Hello world!"]
    )
    engine: str = Field(
        default="edge",
        max_length=16,
        description="TTS engine identifier: 'edge' (free) or 'gemini' (BYOK/high quality).",
        examples=["edge", "gemini"]
    )
    voice: str | None = Field(
        default=None,
        max_length=64,
        description="Voice model identifier (optional, defaults to engine's default voice).",
        examples=["ja-JP-NanamiNeural", "zh-CN-XiaoxiaoNeural", "Kore"]
    )

    @field_validator("text")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        return validate_text(value)

    @field_validator("engine")
    @classmethod
    def validate_engine(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in ("edge", "gemini"):
            raise ValueError("Unknown TTS engine")
        return value

    @model_validator(mode="after")
    def validate_voice(self):
        engine = get_engine(self.engine)
        if self.voice is not None:
            self.voice = self.voice.strip()
            if not any(v["id"] == self.voice for v in engine.get_voices()):
                raise ValueError("Voice is not supported by the selected engine")
        return self


class ErrorResponse(BaseModel):
    detail: str


class VoiceInfoResponse(BaseModel):
    id: str
    name: str
    gender: str
    description: str


class EngineInfoResponse(BaseModel):
    id: str
    name: str
    description: str
    is_free: bool
    default_voice: str
    server_has_key: bool | None = None
    voices: list[VoiceInfoResponse]
    max_text_length: int = 1000
    min_text_length: int = 1
    request_timeout_seconds: float = 30


class TestKeyRequest(BaseModel):
    api_key: str = Field(..., min_length=1, max_length=256, description="Gemini API Key to test.")

    @field_validator("api_key")
    @classmethod
    def validate_key(cls, value: str) -> str:
        if not value.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Invalid API key format")
        return value.strip()


class TestKeyResponse(BaseModel):
    valid: bool
    message: str


class HistoryItem(BaseModel):
    id: int
    text: str
    voice: str
    model: str
    engine: str = "edge"
    cache_key: str
    created_at: str
    last_played_at: str


class SentenceCueResponse(BaseModel):
    index: int
    text: str
    start_ms: int
    end_ms: int


class TTSFlowResponse(BaseModel):
    version: int = 1
    cache_key: str
    audio_url: str
    media_type: str = "audio/mpeg"
    engine: str
    voice: str
    cached: bool
    timeline_available: bool
    sentences: list[SentenceCueResponse]

