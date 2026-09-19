from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.validation import validate_text


ExplainLang = Literal["zh", "ja", "en"]
EXPLAIN_KEY_PATTERN = r"^(?:[0-9a-f]{16}|[0-9a-f]{64})$"


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ReasoningModeResponse(BaseModel):
    id: str
    name: str
    description: str
    quota_weight: int


class CopilotModelResponse(BaseModel):
    id: str
    name: str
    default: bool
    modes: list[ReasoningModeResponse]


class CopilotCatalogResponse(BaseModel):
    models: list[CopilotModelResponse]


class ExplainRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)
    lang: ExplainLang = "zh"
    model_id: str | None = Field(default=None, min_length=1, max_length=64)
    mode_id: str | None = Field(default=None, min_length=1, max_length=32)

    @field_validator("text")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        return validate_text(value)


class ExplainResponse(BaseModel):
    explain_key: str
    explanation: str
    lang: str
    model_id: str
    mode_id: str
    upstream_model: str
    cached: bool
    messages: list[ChatMessage] = Field(default_factory=list)


class ChatRequest(BaseModel):
    explain_key: str = Field(..., pattern=EXPLAIN_KEY_PATTERN)
    mode_id: str | None = Field(default=None, min_length=1, max_length=32)
    message: str = Field(..., min_length=1, max_length=500)

    @field_validator("message")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Message cannot be empty or only whitespace.")
        try:
            trimmed.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("Message must contain valid Unicode characters") from None
        return trimmed


class ChatResponse(BaseModel):
    explain_key: str
    answer: str
    model_id: str
    mode_id: str
