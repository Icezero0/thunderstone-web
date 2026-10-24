"""Authenticated setup commands; callers never supply a seed or player list."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class MatchCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(strict=True, ge=1)
    command_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")


class FirstPlayer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["random", "fixed"] = "random"
    user_id: int | None = Field(default=None, strict=True, ge=1)

    @model_validator(mode="after")
    def check_selection(self):
        if (self.mode == "fixed") != (self.user_id is not None):
            raise ValueError("指定先手时必须提供 user_id；随机先手不能提供 user_id")
        return self


class StartMatchCommand(MatchCommand):
    first_player: FirstPlayer = Field(default_factory=FirstPlayer)


CardGroupId = Annotated[str, Field(min_length=1, max_length=64)]


class SetupChoiceCommand(MatchCommand):
    group_a_ids: list[CardGroupId] = Field(min_length=2, max_length=2)
    group_a_feature_ids: list[CardGroupId] = Field(max_length=1000)

    @model_validator(mode="after")
    def distinct_ids(self):
        if len(set(self.group_a_ids)) != len(self.group_a_ids) or len(set(self.group_a_feature_ids)) != len(self.group_a_feature_ids):
            raise ValueError("地下城分配不能包含重复类别")
        return self
