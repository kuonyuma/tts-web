from typing import Literal
from pydantic import BaseModel, Field, field_validator


ExplainLang = Literal["zh", "ja", "en"]

ThinkingLevel = Literal["low", "medium", "high"]


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ExplainRequest(BaseModel):
    text: str = Field(
        ...,
        min_length=1,
        max_length=1000,
        description="The sentence to be explained by the LLM.",
        examples=["People who exercise regularly are more likely to live longer."],
    )
    lang: ExplainLang = Field(
        default="zh",
        description="Output language of the explanation: 'zh', 'ja' or 'en'.",
        examples=["zh"],
    )
    thinking_level: ThinkingLevel = Field(
        default="medium",
        description="Model thinking effort: 'low', 'medium' or 'high'.",
        examples=["medium"],
    )

    @field_validator("text")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Text cannot be empty or only whitespace.")
        return trimmed


class ExplainResponse(BaseModel):
    explain_key: str
    explanation: str
    lang: str
    cached: bool
    messages: list[ChatMessage] = []


class ChatRequest(BaseModel):
    explain_key: str = Field(..., min_length=1, description="Explanation session key returned by /api/explain.")
    thinking_level: ThinkingLevel = Field(
        default="medium",
        description="Model thinking effort for the follow-up answer.",
        examples=["medium"],
    )
    message: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description="Follow-up question about the explained sentence.",
    )

    @field_validator("message")
    @classmethod
    def validate_non_empty(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Message cannot be empty or only whitespace.")
        return trimmed


class ChatResponse(BaseModel):
    explain_key: str
    answer: str
