from datetime import datetime

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, SecretStr, field_validator
from app.validation import normalize_email, validate_unicode


class RegisterUserRequest(BaseModel):
    # 1. 严禁多余字段   
    model_config = ConfigDict(extra="forbid")

    # 2. 基础字段与格式约束
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_]+$", strict=True)
    password: SecretStr = Field(min_length=8, max_length=128, strict=True)
    email: EmailStr | None = None

    # 3. 邮箱标准化
    _normalize_email = field_validator("email")(normalize_email)

    # 5. 密码严格校验
    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return value.lower()

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: SecretStr) -> SecretStr:
        password = value.get_secret_value()
        # 检查密码是否全为空格
        if not password.strip():
            raise ValueError("Password cannot be only whitespace")
        #  检查字符编码是否合法（能否以 UTF-8 正确编码）
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
