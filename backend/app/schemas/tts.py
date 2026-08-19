from pydantic import BaseModel, Field, field_validator


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
        description="TTS engine identifier: 'edge' (free) or 'gemini' (BYOK/high quality).",
        examples=["edge", "gemini"]
    )
    voice: str | None = Field(
        default=None,
        description="Voice model identifier (optional, defaults to engine's default voice).",
        examples=["ja-JP-NanamiNeural", "zh-CN-XiaoxiaoNeural", "Kore"]
    )

    @field_validator("text")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Text cannot be empty or only whitespace.")
        return trimmed


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


class TestKeyRequest(BaseModel):
    api_key: str = Field(..., min_length=1, description="Gemini API Key to test.")


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
