"""Compatibility record for validated shared TypeScript mechanic bindings."""
from dataclasses import dataclass

@dataclass(frozen=True)
class Mechanic:
    id: str
    source_card_id: str
    source_line: str
    op: str
    params: dict
