"""Errors returned by the setup domain."""

from typing import Any


class SetupError(ValueError):
    """A frozen request cannot produce a complete initial state."""

    def __init__(self, message: str, issues: list[dict[str, str]] | None = None):
        super().__init__(message)
        self.issues = issues or []


class SetupChoiceRequired(SetupError):
    """The same request and seed can be resubmitted with a choice."""

    def __init__(self, choice: dict[str, Any]):
        super().__init__("setup requires a scenario allocation choice")
        self.choice = choice
