from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from app.validation import validate_unicode


class ArticleText(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="未命名文章", max_length=200)
    content: str = Field(default="", max_length=500_000)

    @field_validator("title", "content")
    @classmethod
    def valid_unicode(cls, value: str) -> str:
        return validate_unicode(value, "文章包含无效的 Unicode 字符。")


class ArticleCreate(ArticleText):
    id: UUID


class ArticleUpdate(ArticleText):
    revision: int = Field(ge=1)


class ArticleSummary(BaseModel):
    id: str
    title: str
    character_count: int
    created_at: str
    updated_at: str
    revision: int


class ArticleResponse(ArticleSummary):
    content: str
