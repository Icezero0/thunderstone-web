"""Build a reviewable card catalog from localization text boxes and deck metadata."""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path


CARD_RE = re.compile(r"^deck_(\d{2})_(\d+)x(\d+)_r(\d{2})_c(\d{2})\.png$")
CARD_COLUMNS = [
    "card_id",
    "slot_kind",
    "tts_card_id",
    "tts_copy_count",
    "deck_id",
    "row",
    "column",
    "card_type",
    "subcategory",
    "name",
    "waist_text",
    "effect_text",
    "other_text",
    "review_status",
    "review_reasons",
    "legacy_edited",
    "image_path",
    "english_image_path",
    "clean_image_path",
]
BOX_COLUMNS = [
    "card_id",
    "box_index",
    "role",
    "x",
    "y",
    "w",
    "h",
    "text",
    "font_family",
    "font_size",
    "bold",
    "italic",
    "color",
    "stroke_color",
    "stroke_width",
    "align",
]
REVIEW_COLUMNS = [
    "card_id",
    "card_type",
    "subcategory",
    "name",
    "waist_text",
    "effect_text",
    "other_text",
    "review_reasons",
    "image_path",
]


def read_catalog(path: Path) -> dict[str, dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    catalog = {row["deck_id"]: row for row in rows}
    if len(catalog) != len(rows):
        raise ValueError("Duplicate deck_id in deck catalog")
    return catalog


def is_waist_label(box: dict) -> bool:
    text = box["text"].strip()
    return (
        330 <= box["y"] <= 455
        and box["h"] <= 65
        and len(text) <= 30
        and "\n" not in text
        and not any(mark in text for mark in "：。！？")
    )


def extract_fields(
    texts: list[dict], *, reference: bool = False
) -> tuple[dict[str, str], list[str]]:
    """Use position to select title, waist label and body; retain everything else."""
    indexed = sorted(enumerate(texts), key=lambda item: (item[1]["y"], item[1]["x"]))
    names = [(index, box) for index, box in indexed if box["y"] < 180]
    waist_candidates = [
        (index, box) for index, box in indexed if index not in {i for i, _ in names} and is_waist_label(box)
    ] if not reference else []
    waist = waist_candidates[0] if waist_candidates else None
    waist_y = waist[1]["y"] if waist else None
    roles = {index: "name" for index, _ in names}
    if waist:
        roles[waist[0]] = "waist"
    for index, box in indexed:
        if index not in roles:
            label_like = (
                waist_y is not None
                and box["y"] <= waist_y + 40
                and len(box["text"].strip()) <= 8
                and "\n" not in box["text"]
                and not any(mark in box["text"] for mark in "：。！？+-0123456789")
            )
            roles[index] = "other" if label_like else "effect"

    def joined(role: str) -> str:
        return "\n".join(
            box["text"].strip()
            for index, box in indexed
            if roles[index] == role and box["text"].strip()
        )

    reasons = []
    if not names:
        reasons.append("missing_name")
    if len(names) > 1:
        reasons.append("multiple_name_boxes")
    if not waist and not reference:
        reasons.append("missing_waist_text")
    if len(waist_candidates) > 1 and waist_candidates[1][1]["y"] - waist[1]["y"] < 20:
        reasons.append("ambiguous_waist_text")
    if any(role == "other" for role in roles.values()):
        reasons.append("unassigned_text")

    return {
        "name": joined("name"),
        "waist_text": joined("waist"),
        "effect_text": joined("effect"),
        "other_text": joined("other"),
        "roles": roles,
    }, reasons


def write_csv(path: Path, columns: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def read_tts_counts(path: Path) -> Counter:
    save = json.loads(path.read_text(encoding="utf-8-sig"))
    counts: Counter = Counter()

    def walk(value: object) -> None:
        if isinstance(value, dict):
            if value.get("Name") == "Card" and isinstance(value.get("CardID"), int):
                counts[value["CardID"]] += 1
            for child in value.values():
                if isinstance(child, (dict, list)):
                    walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(save["ObjectStates"])
    return counts


def build(
    source_dir: Path,
    generated_dir: Path,
    catalog_path: Path,
    overrides_path: Path,
    text_overrides_path: Path,
    tts_path: Path,
    output_dir: Path,
) -> Counter:
    work = json.loads(
        (source_dir / ".card_localizer_work" / "work_state.json").read_text(
            encoding="utf-8-sig"
        )
    )
    legacy = json.loads(
        (source_dir / ".card_localizer_state.json").read_text(encoding="utf-8-sig")
    )
    entries = work["images"]
    source_names = {path.name for path in source_dir.glob("deck_*.png")}
    if source_names != set(entries):
        raise ValueError("Source card names and work_state image keys differ")
    generated_names = {path.name for path in generated_dir.glob("deck_*.png")}
    if generated_names != source_names:
        raise ValueError("Generated cards and source card names differ; run split_decks.py")

    catalog = read_catalog(catalog_path)
    tts_counts = read_tts_counts(tts_path)
    with overrides_path.open(encoding="utf-8-sig", newline="") as handle:
        override_rows = list(csv.DictReader(handle))
    overrides = {row["card_id"]: row for row in override_rows}
    if len(overrides) != len(override_rows) or not set(overrides) <= {
        name.removesuffix(".png") for name in source_names
    }:
        raise ValueError("Invalid card overrides")
    with text_overrides_path.open(encoding="utf-8-sig", newline="") as handle:
        text_override_rows = list(csv.DictReader(handle))
    text_overrides = {row["card_id"]: row for row in text_override_rows}
    if len(text_overrides) != len(text_override_rows) or not set(text_overrides) <= {
        name.removesuffix(".png") for name in source_names
    }:
        raise ValueError("Invalid card text overrides")
    cards = []
    boxes = []
    review = []
    stats: Counter = Counter()

    for filename in sorted(entries):
        match = CARD_RE.fullmatch(filename)
        if not match:
            raise ValueError(f"Unexpected card filename: {filename}")
        deck_id, columns_text, rows_text, row_text, column_text = match.groups()
        columns, rows = int(columns_text), int(rows_text)
        row, column = int(row_text), int(column_text)
        if not 1 <= row <= rows or not 1 <= column <= columns:
            raise ValueError(f"Card position outside sheet: {filename}")
        if deck_id not in catalog:
            raise ValueError(f"Missing deck classification: {deck_id}")

        card_id = filename.removesuffix(".png")
        source = source_dir / filename
        is_back = row == rows and column == columns
        is_blank = source.stat().st_size <= 2048
        if is_back and is_blank:
            raise ValueError(f"Final sheet slot is unexpectedly blank: {filename}")
        slot_kind = "back" if is_back else "blank" if is_blank else "front"
        override = overrides.get(card_id)
        if override and override["slot_kind"]:
            slot_kind = override["slot_kind"]
        if slot_kind not in {"front", "back", "blank", "reference"}:
            raise ValueError(f"Invalid slot_kind for {card_id}: {slot_kind}")
        state = entries[filename]
        texts = state.get("texts", [])
        fields, reasons = extract_fields(texts, reference=slot_kind == "reference") if texts else (
            {"name": "", "waist_text": "", "effect_text": "", "other_text": "", "roles": {}},
            [],
        )
        if slot_kind == "front" and not texts:
            reasons.append("missing_localization_text")
        if slot_kind in {"back", "blank"}:
            reasons = []
        elif not fields["name"] and "missing_name" not in reasons:
            reasons.append("missing_name")

        numeric_tts_id = int(deck_id) * 100 + (row - 1) * columns + column - 1
        copy_count = tts_counts[numeric_tts_id]
        if slot_kind == "front" and not copy_count:
            reasons.append("not_in_tts_save")

        text_override = text_overrides.get(card_id)
        reviewed = False
        if text_override:
            for field in ("name", "waist_text", "effect_text", "other_text"):
                if text_override[field]:
                    fields[field] = text_override[field]
            reviewed = text_override["reviewed"].strip().lower() in {"true", "1", "yes"}
            if reviewed and (not fields["name"] or (slot_kind == "front" and not fields["waist_text"])):
                raise ValueError(f"Reviewed card lacks name or waist text: {card_id}")
            if reviewed:
                reasons = []

        card_type = catalog[deck_id]["card_type"]
        subcategory = catalog[deck_id]["subcategory"]
        waist_text = fields["waist_text"]
        if waist_text.startswith("随机") and "・" in waist_text:
            card_type, subcategory = "随机生成卡", waist_text.split("・", 1)[1]
        elif card_type == "村庄卡" and "英雄" in waist_text:
            card_type, subcategory = "英雄卡", "英雄"
        elif waist_text == "环境":
            card_type, subcategory = "地下城卡", "环境"
        elif "守护者" in waist_text and deck_id == "20":
            card_type, subcategory = "地下城卡", "守护者"
        if override:
            card_type = override["card_type"] or card_type
            subcategory = override["subcategory"] or subcategory

        relative_source = f"black_edges/{filename}"
        clean_path = "black_edges/" + state["image_path"].replace("\\", "/")
        relative_image = f"generated/cards/{filename}"
        tts_card_id = numeric_tts_id if slot_kind in {"front", "reference"} or copy_count else ""
        legacy_edited = bool(legacy["images"].get(filename, {}).get("edited", False))
        card = {
            "card_id": card_id,
            "slot_kind": slot_kind,
            "tts_card_id": tts_card_id,
            "tts_copy_count": copy_count,
            "deck_id": deck_id,
            "row": row,
            "column": column,
            "card_type": card_type if slot_kind in {"front", "reference"} else "",
            "subcategory": subcategory if slot_kind in {"front", "reference"} else "",
            "name": fields["name"] if slot_kind in {"front", "reference"} else "",
            "waist_text": waist_text if slot_kind == "front" else "",
            "effect_text": fields["effect_text"] if slot_kind in {"front", "reference"} else "",
            "other_text": fields["other_text"] if slot_kind in {"front", "reference"} else "",
            "review_status": (
                "not_applicable" if slot_kind in {"back", "blank"} else "reviewed" if reviewed else "needs_review" if reasons else "extracted"
            ),
            "review_reasons": "|".join(reasons),
            "legacy_edited": legacy_edited,
            "image_path": relative_image,
            "english_image_path": relative_source,
            "clean_image_path": clean_path,
        }
        cards.append(card)
        stats[slot_kind] += 1
        if card["review_status"] == "needs_review":
            review.append(card)
            for reason in reasons:
                stats[reason] += 1

        for index, box in enumerate(texts):
            boxes.append(
                {
                    "card_id": card_id,
                    "box_index": index,
                    "role": fields["roles"].get(index, "other"),
                    **{key: box.get(key, "") for key in BOX_COLUMNS[3:]},
                }
            )

    output_dir.mkdir(parents=True, exist_ok=True)
    write_csv(output_dir / "cards.csv", CARD_COLUMNS, cards)
    write_csv(output_dir / "text_boxes.csv", BOX_COLUMNS, boxes)
    write_csv(output_dir / "review_queue.csv", REVIEW_COLUMNS, review)
    stats["cards"] = len(cards)
    stats["text_boxes"] = len(boxes)
    stats["needs_review"] = len(review)
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path("black_edges"))
    parser.add_argument("--generated-dir", type=Path, default=Path("generated/cards"))
    parser.add_argument("--catalog", type=Path, default=Path("data/deck_catalog.csv"))
    parser.add_argument("--overrides", type=Path, default=Path("data/card_overrides.csv"))
    parser.add_argument(
        "--text-overrides", type=Path, default=Path("data/card_text_overrides.csv")
    )
    parser.add_argument("--tts-save", type=Path, default=Path("game/TDS_CN.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data"))
    args = parser.parse_args()
    stats = build(
        args.source_dir,
        args.generated_dir,
        args.catalog,
        args.overrides,
        args.text_overrides,
        args.tts_save,
        args.output_dir,
    )
    print("Built card data:")
    for key, value in sorted(stats.items()):
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
