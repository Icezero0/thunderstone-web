"""Public user request and response models."""

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from backend.app.core.validators import (normalize_email,
                                         normalize_optional_non_empty_str,
                                         normalize_required_str)


def _password(value: str) -> str:
    value = normalize_required_str(value, field_name="Password")
    if not 8 <= len(value.encode("utf-8")) <= 72:
        raise ValueError("Password must be 8 to 72 UTF-8 bytes")
    return value


class UserCreate(BaseModel):
    email: EmailStr
    username: str | None = Field(default=None, max_length=64)
    password: str

    @field_validator("email", mode="before")
    @classmethod
    def validate_email(cls, value: str) -> str:
        return normalize_email(value)

    @field_validator("username", mode="before")
    @classmethod
    def validate_username(cls, value: str | None) -> str | None:
        return normalize_optional_non_empty_str(value, field_name="Username")

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        return _password(value)


class UserPatch(BaseModel):
    username: str | None = Field(default=None, max_length=64)
    password: str | None = None

    @field_validator("username", mode="before")
    @classmethod
    def validate_username(cls, value: str | None) -> str | None:
        return normalize_optional_non_empty_str(value, field_name="Username")

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str | None) -> str | None:
        return _password(value) if value is not None else None


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    username: str | None
