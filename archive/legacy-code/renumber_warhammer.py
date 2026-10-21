"""One-time, journaled card-ID migration after the Warhammer tag correction.

Run without arguments for a plan, then with --apply to write it. This historical
migration deliberately retains the old ID in its precondition; it is not loaded
by the engine. A changed baseline or a second execution is rejected.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "archive/legacy-code"))
from card_order import ordered_cards  # noqa: E402

BASELINE = "420081fa64b130e729f29712cd48463a657d62fcdf96307d697ac0b9058ba224"
STEM = "warhammer-renumber-2026-10-20"
AUDIT = ROOT / "archive/card-audit"
TOKEN = re.compile(r"(?<![A-Za-z0-9])TS(?P<separator>[-_])(?P<number>[0-9]{4})(?![0-9])")
TEXT_SUFFIXES = {".py", ".js", ".ts", ".json", ".csv", ".md", ".html", ".css", ".txt", ".toml", ".yaml", ".yml"}
SKIP_DIRS = {".git", ".venv", ".uv-cache", "__pycache__", ".pytest_cache", "game_TTS", "assets"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def remap(text: str, mapping: dict[str, str]) -> str:
    def replace(match):
        old = "TS-" + match["number"]
        return mapping.get(old, old).replace("-", match["separator"], 1)
    return TOKEN.sub(replace, text)


def atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + ".renumber-tmp")
    if temporary.exists():
        raise ValueError(f"unexpected migration temporary file: {temporary}")
    temporary.write_bytes(data)
    temporary.replace(path)


def explicit_mechanics(source: str) -> str:
    """Remove arithmetic card-ID construction before changing a permutation."""
    rules = runpy.run_path(str(ROOT / "scripts/build_mechanics.py"))["RULES"]
    start, end = source.index("RULES:"), source.index("def build()")
    lines = ["RULES: list[tuple[str, str, dict]] = [",
             "    # Explicit IDs keep source identity independent of numeric ranges."]
    lines.extend("    " + repr(tuple(rule)) + "," for rule in rules)
    return source[:start] + "\n".join([*lines, "]", "", ""]) + "\n" + source[end:]


def text_paths():
    for directory, children, filenames in os.walk(ROOT):
        children[:] = [name for name in children if name not in SKIP_DIRS
                       and name != "instance" and not name.startswith(".warhammer-")]
        for name in filenames:
            path = Path(directory) / name
            if path.suffix.lower() in TEXT_SUFFIXES and path != Path(__file__).resolve() and not name.startswith(STEM):
                yield path


def make_plan():
    csv_path = ROOT / "data/cards.csv"
    raw = csv_path.read_bytes()
    if digest(raw) != BASELINE:
        raise ValueError("catalog baseline changed or this migration was already applied")
    cards = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"), newline="")))
    hammer = next(row for row in cards if row["source_card_id"] == "deck_19_10x3_r03_c07")
    if hammer["card_id"] != "TS-0215" or hammer["tags"] != "武器|钝器":
        raise ValueError("unexpected Warhammer identity or tags")
    ordered = ordered_cards(cards)
    mapping = {row["card_id"]: f"TS-{index:04d}" if row["slot_kind"] == "front" else row["card_id"]
               for index, row in enumerate(ordered, 1)}
    if len(set(mapping.values())) != len(cards):
        raise ValueError("ID mapping is not one-to-one")
    journal = []
    images = []
    changed = {old: new for old, new in mapping.items() if old != new}
    if set(changed) != set(changed.values()):
        raise ValueError("changed card IDs do not form a closed permutation")
    for position, row in enumerate(ordered, 1):
        old, new = row["card_id"], mapping[row["card_id"]]
        image_path = ROOT / row["image_path"]
        if not image_path.is_file() or image_path.stem != old:
            raise ValueError(f"missing or mismatched source image: {image_path}")
        new_image = image_path.with_name(new + image_path.suffix)
        images.append({"old_path": image_path.relative_to(ROOT).as_posix(),
                       "new_path": new_image.relative_to(ROOT).as_posix(),
                       "sha256": digest(image_path.read_bytes())})
        journal.append({"old_card_id": old, "new_card_id": new,
                        "source_card_id": row["source_card_id"], "name": row["name"],
                        "old_catalog_order": row["catalog_order"], "new_catalog_order": str(position),
                        "image_sha256": images[-1]["sha256"]})
    changes = {}
    for path in text_paths():
        if path == csv_path:
            continue
        before = path.read_bytes()
        bom = before.startswith(b"\xef\xbb\xbf")
        text = before.decode("utf-8-sig")
        if path == ROOT / "scripts/build_mechanics.py":
            text = explicit_mechanics(text)
        elif path == ROOT / "engine/rules/hall.py":
            old = 'frozenset(f"TS-{number:04d}" for number in range(592, 597))'
            if text.count(old) != 1:
                raise ValueError("unexpected Treefolk ID range")
            explicit = "frozenset({" + ", ".join(repr(f"TS-{n:04d}") for n in range(592, 597)) + "})"
            text = text.replace(old, explicit)
        after = remap(text, mapping).encode("utf-8-sig" if bom else "utf-8")
        if after != before:
            changes[path] = (before, after)
    result_rows = []
    for index, row in enumerate(ordered, 1):
        result_rows.append({**row, "card_id": mapping[row["card_id"]],
                            "catalog_order": str(index), "image_path": remap(row["image_path"], mapping)})
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=list(cards[0]), lineterminator="\r\n" if b"\r\n" in raw else "\n")
    writer.writeheader()
    writer.writerows(result_rows)
    changes[csv_path] = (raw, output.getvalue().encode("utf-8-sig"))
    return mapping, journal, images, changes


def apply(mapping, journal, images, changes):
    AUDIT.mkdir(parents=True, exist_ok=True)
    backup = AUDIT / (STEM + "-before.zip")
    manifest = AUDIT / (STEM + "-manifest.json")
    mapping_path = AUDIT / (STEM + ".csv")
    stage = AUDIT / ".warhammer-card-stage"
    if any(path.exists() for path in (backup, manifest, mapping_path, stage)):
        raise ValueError("migration outputs already exist; refusing to overwrite history")
    with zipfile.ZipFile(backup, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, (before, _) in changes.items():
            archive.writestr(path.relative_to(ROOT).as_posix(), before)
    with mapping_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=list(journal[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(journal)
    metadata = {"before_catalog_sha256": BASELINE, "after_catalog_sha256": digest(changes[ROOT / "data/cards.csv"][1]),
                "card_count": len(mapping), "renumbered_count": sum(a != b for a, b in mapping.items()),
                "mapping_file": mapping_path.relative_to(ROOT).as_posix(), "images": images,
                "text_files": [{"path": path.relative_to(ROOT).as_posix(), "before_sha256": digest(before),
                                "planned_after_sha256": digest(after)} for path, (before, after) in changes.items()]}
    manifest.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Move files in two passes to avoid overwriting another card in a cycle.
    stage.mkdir()
    if not stage.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("staging directory leaves workspace")
    moved = [item for item in images if item["old_path"] != item["new_path"]]
    for item in moved:
        (ROOT / item["old_path"]).rename(stage / Path(item["old_path"]).name)
    for item in moved:
        destination = ROOT / item["new_path"]
        if destination.exists():
            raise ValueError(f"destination image was not staged: {destination}")
        (stage / Path(item["old_path"]).name).rename(destination)
    stage.rmdir()
    for path, (_, after) in changes.items():
        atomic_write(path, after)
    for item in images:
        if digest((ROOT / item["new_path"]).read_bytes()) != item["sha256"]:
            raise ValueError(f"image identity mismatch: {item['new_path']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    plan = make_plan()
    mapping, journal, _, changes = plan
    print(json.dumps({"cards": len(mapping), "changed_ids": sum(a != b for a, b in mapping.items()),
                      "text_files": len(changes), "warhammer_new_id": mapping["TS-0215"],
                      "apply": args.apply}, ensure_ascii=False))
    if args.apply:
        apply(*plan)


if __name__ == "__main__":
    main()
