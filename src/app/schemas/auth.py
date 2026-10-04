import re

from pydantic import BaseModel, ConfigDict, EmailStr, Field, SecretStr, field_validator

from app.schemas.users import RegisterUserRequest, UserResponse
from app.validation import normalize_email, validate_unicode


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    identity: str = Field(min_length=1, max_length=320, strict=True)
    password: SecretStr = Field(min_length=1, max_length=128, strict=True)

    @field_validator("identity")
    @classmethod
    def normalize_identity(cls, value: str) -> str:
        return value.strip().casefold()

    @field_validator("password")
    @classmethod
    def validate_unicode(cls, value: SecretStr) -> SecretStr:
        validate_unicode(value.get_secret_value(), "Password must contain valid Unicode characters")
        return value


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserResponse


class EmailRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr

    _normalize_email = field_validator("email")(normalize_email)


class EmailChangeRequest(EmailRequest):
    password: SecretStr | None = Field(default=None, min_length=1, max_length=128)

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: SecretStr | None) -> SecretStr | None:
        return LoginRequest.validate_unicode(value) if value is not None else None


class TokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: SecretStr = Field(min_length=16, max_length=256, strict=True)

    @field_validator("token")
    @classmethod
    def validate_token(cls, value: SecretStr) -> SecretStr:
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", value.get_secret_value()):
            raise ValueError("Link token format is invalid")
        return value


class ResetPasswordRequest(TokenRequest):
    password: SecretStr = Field(min_length=8, max_length=128, strict=True)

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: SecretStr) -> SecretStr:
        return RegisterUserRequest.validate_password(value)
