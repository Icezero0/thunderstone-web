"""Split finished TTS deck sheets into individually named 504x704 PNG cards."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from PIL import Image


SHEET_RE = re.compile(r"^deck_(\d{2})_(\d+)x(\d+)\.png$")
EXPECTED_CARD_SIZE = (504, 704)


def split_decks(assets_dir: Path, output_dir: Path, *, verify: bool = False) -> int:
    sheets = sorted(assets_dir.glob("deck_*.png"))
    if not sheets:
        raise ValueError(f"No deck sheets found in {assets_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for sheet_path in sheets:
        match = SHEET_RE.fullmatch(sheet_path.name)
        if not match:
            raise ValueError(f"Unexpected sheet filename: {sheet_path.name}")
        deck_id, columns_text, rows_text = match.groups()
        columns, rows = int(columns_text), int(rows_text)
        with Image.open(sheet_path) as sheet:
            expected_size = (
                columns * EXPECTED_CARD_SIZE[0],
                rows * EXPECTED_CARD_SIZE[1],
            )
            if sheet.size != expected_size:
                raise ValueError(
                    f"{sheet_path.name}: {sheet.size}, expected {expected_size}"
                )
            for row in range(rows):
                for column in range(columns):
                    name = (
                        f"deck_{deck_id}_{columns}x{rows}"
                        f"_r{row + 1:02d}_c{column + 1:02d}.png"
                    )
                    target = output_dir / name
                    left = column * EXPECTED_CARD_SIZE[0]
                    top = row * EXPECTED_CARD_SIZE[1]
                    bounds = (
                        left,
                        top,
                        left + EXPECTED_CARD_SIZE[0],
                        top + EXPECTED_CARD_SIZE[1],
                    )
                    if verify:
                        if not target.is_file():
                            raise ValueError(f"Missing generated card: {target}")
                        with Image.open(target) as card:
                            if card.size != EXPECTED_CARD_SIZE:
                                raise ValueError(f"Wrong card size: {target}: {card.size}")
                            if card.convert("RGBA").tobytes() != sheet.crop(bounds).convert(
                                "RGBA"
                            ).tobytes():
                                raise ValueError(f"Card pixels differ from sheet: {target}")
                    else:
                        sheet.crop(bounds).save(target, format="PNG")
                    count += 1

    if len(list(output_dir.glob("deck_*.png"))) != count:
        raise ValueError("Output contains unexpected or stale deck PNG files")
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-dir", type=Path, default=Path("game/assets"))
    parser.add_argument("--output-dir", type=Path, default=Path("generated/cards"))
    parser.add_argument(
        "--verify", action="store_true", help="Compare every generated card with its sheet"
    )
    args = parser.parse_args()
    count = split_decks(args.assets_dir, args.output_dir, verify=args.verify)
    print(f"{'Verified' if args.verify else 'Created'} {count} cards from TTS sheets")


if __name__ == "__main__":
    main()
