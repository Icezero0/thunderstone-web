"""Stable project paths, independent of the process working directory."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CARDS_ROOT = PROJECT_ROOT / "cards"
DATA_ROOT = PROJECT_ROOT / "data"
