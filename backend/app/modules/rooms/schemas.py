"""Authenticated room commands and public waiting-room views."""

import json
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator


class RoomCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=64)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class RoomCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(strict=True, ge=1)


class ReadyCommand(RoomCommand):
    ready: StrictBool


class ConfigCommand(RoomCommand):
    config: dict[str, Any]

    @field_validator("config")
    @classmethod
    def limit_config(cls, value):
        if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > 64_000:
            raise ValueError("规则配置过大")
        return value


class PlayerView(BaseModel):
    user_id: int
    display_name: str
    ready: bool


class RoomSummary(BaseModel):
    id: str
    name: str
    host_user_id: int
    host_name: str
    status: str
    version: int
    config_version: int
    player_count: int
    created_at: datetime


class RoomView(RoomSummary):
    players: list[PlayerView]
    config: dict[str, Any]
    all_ready: bool


class RoomList(BaseModel):
    rooms: list[RoomSummary]


class CurrentRoom(BaseModel):
    room: RoomView | None
