from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from app.validation import validate_unicode


def _clean_text(value: str, field_label: str) -> str:
    checked = validate_unicode(value, f"{field_label}包含无效的 Unicode 字符。")
    return checked.strip()


class VocabCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID | None = None
    word: str = Field(..., min_length=1, max_length=100)
    surface: str = Field(default="", max_length=100)
    reading: str = Field(default="", max_length=120)
    pos: str = Field(default="", max_length=60)
    meaning: str = Field(default="", max_length=1000)
    notes: str = Field(default="", max_length=1000)
    context_sentence: str = Field(default="", max_length=1000)
    source_article_id: str | None = Field(default=None, max_length=64)
    source_title: str = Field(default="", max_length=200)
    mastered: bool = False

    @field_validator("word")
    @classmethod
    def valid_word(cls, value: str) -> str:
        cleaned = _clean_text(value, "词条")
        if not cleaned:
            raise ValueError("词条不能为空。")
        return cleaned

    @field_validator("surface", "reading", "pos", "meaning", "notes", "context_sentence", "source_title")
    @classmethod
    def valid_optional_fields(cls, value: str) -> str:
        return _clean_text(value, "生词字段")

    @field_validator("source_article_id")
    @classmethod
    def valid_article_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = _clean_text(value, "文章标识")
        return cleaned or None


class VocabUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    word: str | None = Field(default=None, min_length=1, max_length=100)
    surface: str | None = Field(default=None, max_length=100)
    reading: str | None = Field(default=None, max_length=120)
    pos: str | None = Field(default=None, max_length=60)
    meaning: str | None = Field(default=None, max_length=1000)
    notes: str | None = Field(default=None, max_length=1000)
    context_sentence: str | None = Field(default=None, max_length=1000)
    source_article_id: str | None = Field(default=None, max_length=64)
    source_title: str | None = Field(default=None, max_length=200)
    mastered: bool | None = None
    review_delta: int = Field(default=0, ge=0, le=10)

    @field_validator("word")
    @classmethod
    def valid_word(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = _clean_text(value, "词条")
        if not cleaned:
            raise ValueError("词条不能为空。")
        return cleaned

    @field_validator("surface", "reading", "pos", "meaning", "notes", "context_sentence", "source_title")
    @classmethod
    def valid_optional_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _clean_text(value, "生词字段")

    @field_validator("source_article_id")
    @classmethod
    def valid_article_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = _clean_text(value, "文章标识")
        return cleaned or None


class VocabResponse(BaseModel):
    id: str
    word: str
    surface: str = ""
    reading: str
    pos: str
    meaning: str
    notes: str
    context_sentence: str
    source_article_id: str | None
    source_title: str
    review_count: int
    mastered: bool
    created_at: str
    updated_at: str
