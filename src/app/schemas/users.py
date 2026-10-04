from datetime import datetime

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, SecretStr, field_validator
from app.validation import normalize_email, validate_unicode


class RegisterUserRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$", strict=True)
    password: SecretStr = Field(min_length=8, max_length=128, strict=True)
    email: EmailStr | None = None

    _normalize_email = field_validator("email")(normalize_email)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return value.lower()

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: SecretStr) -> SecretStr:
        password = value.get_secret_value()
        if not password.strip():
            raise ValueError("Password cannot be only whitespace")
        validate_unicode(password, "Password must contain valid Unicode characters")
        return value


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    created_at: datetime
    updated_at: datetime
    email: str | None
    email_verified: bool
    role: Literal["user", "admin"]
    is_active: bool
    has_password: bool


class UserAdminUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "admin"] | None = None
    is_active: bool | None = Field(default=None, strict=True)
