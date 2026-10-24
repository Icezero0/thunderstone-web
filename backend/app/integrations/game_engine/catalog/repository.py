"""Read the immutable card definitions and generated setup index."""

import csv
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from backend.app.core.paths import PROJECT_ROOT


@dataclass(frozen=True)
class CatalogSnapshot:
    cards: dict[str, dict[str, str]]
    setup_index: dict


def load_catalog(root: Path = PROJECT_ROOT) -> CatalogSnapshot:
    csv_path = root / "cards" / "cards.csv"
    with csv_path.open(encoding="utf-8-sig", newline="") as handle:
        cards = {card["card_id"]: card for card in csv.DictReader(handle)}
    setup = json.loads((root / "cards" / "setup_catalog.json").read_text(encoding="utf-8"))
    current_hash = hashlib.sha256(csv_path.read_bytes()).hexdigest()
    if setup["cards_csv_sha256"] != current_hash:
        raise ValueError("setup_catalog.json is stale; run backend/scripts/catalog/build_setup_catalog.py")
    return CatalogSnapshot(cards, setup)
