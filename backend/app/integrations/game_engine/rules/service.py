"""Python compatibility entry points for shared classic configuration rules."""
from typing import Mapping
from backend.app.integrations.game_engine.rules.schemas import RulesConfig
from backend.app.integrations.game_engine.shared.client import client


def effective_group_counts(counts: Mapping[str, int], environment_id: str | None) -> dict[str, int]:
    return client.call("effective_group_counts", {"counts": counts, "environment": environment_id})


def effective_copy_count(card: Mapping[str, str], config: RulesConfig) -> int:
    return client.call("effective_copy_count", {"card": card, "config": config})


def validate_rules_config(payload: object, catalog: dict) -> list[dict[str, str]]:
    return client.call("validate_config", {"config": payload, "panel": catalog})
