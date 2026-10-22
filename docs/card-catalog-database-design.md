# Card catalog SQLite design

## Scope and ownership

This design migrates all 722 definitions and 47 CSV fields from `cards/cards.csv` into the backend's SQLite database. It also stores the generated `cards/setup_catalog.json` index, whose `cards_csv_sha256` must match the exact CSV bytes. The database becomes the backend's runtime catalog snapshot. The CSV and generated index remain checked-in import inputs; changes are imported explicitly, never silently reapplied on every startup.

The TypeScript game engine remains independent of SQLite and SQLAlchemy. `backend.app.integrations.game_engine.catalog` can load the CSV for command-line use. The backend loads an equivalent catalog snapshot from SQLite and passes it to engine setup and rule validation through the same integration. A card definition is distinct from an in-game card instance; match state and user accounts are outside these catalog tables.

Current input: **722 rows, 47 columns**: 720 fronts, one reference, one shared back. Empty CSV cells mean unknown or not applicable and become SQL `NULL`, not numeric zero. Existing `card_id` values and image paths are preserved.

## Schema

```text
catalog_meta (one row, id = 1)
  cards_csv_sha256, setup_schema_version, setup_index_json,
  card_count, imported_at
         │
         │ describes the same imported revision
         ▼
card_definitions (card_id PK, catalog_order UNIQUE, 47 mapped CSV fields)
         │ 1
         └──────< card_tags (card_id FK, position PK-with-card_id, tag)
```

`card_definitions` contains one row per CSV row, including the reference and back. Its `tags_text` keeps the original `tags` cell exactly for lossless export; `card_tags` is an ordered query index derived from it. The import service updates both in one transaction. `catalog_meta` stores the full setup index as JSON because its group and feature arrays are a versioned, generated rule input, not independently edited records.

The following CSV-to-column mapping covers every source field. `INTEGER?` means nullable integer, `TEXT?` nullable text. The other fields are required. `legacy_edited` is stored as a boolean and exported as `True` or `False`.

| CSV field | SQLite column | Type | CSV field | SQLite column | Type |
| --- | --- | --- | --- | --- | --- |
| `card_id` | `card_id` | TEXT PK | `source_card_id` | `source_card_id` | TEXT UNIQUE |
| `catalog_order` | `catalog_order` | INTEGER UNIQUE | `slot_kind` | `slot_kind` | TEXT |
| `tts_card_id` | `tts_card_id` | INTEGER? | `tts_copy_count` | `tts_copy_count` | INTEGER |
| `initial_copy_count` | `initial_copy_count` | INTEGER? | `deck_id` | `deck_id` | TEXT |
| `row` | `source_row` | INTEGER | `column` | `source_column` | INTEGER |
| `card_type` | `card_type` | TEXT? | `subcategory` | `subcategory` | TEXT? |
| `hero_series_status` | `hero_series_status` | TEXT? | `hero_series_size` | `hero_series_size` | INTEGER? |
| `name` | `name` | TEXT? | `waist_text` | `waist_text` | TEXT? |
| `tags` | `tags_text` | TEXT? | `effect_text` | `effect_text` | TEXT? |
| `other_text` | `other_text` | TEXT? | `review_status` | `review_status` | TEXT |
| `review_reasons` | `review_reasons` | TEXT? | `legacy_edited` | `legacy_edited` | BOOLEAN |
| `image_path` | `image_path` | TEXT | `english_image_path` | `english_image_path` | TEXT |
| `clean_image_path` | `clean_image_path` | TEXT | `wiki_英文卡名` | `english_name` | TEXT? |
| `wiki_卡表扩展` | `wiki_expansion` | TEXT? | `wiki_购买价格` | `purchase_cost` | INTEGER? |
| `wiki_金币值` | `gold_value` | INTEGER? | `wiki_光照` | `light_value` | INTEGER? |
| `wiki_重量` | `weight_value` | INTEGER? | `wiki_英雄等级` | `hero_level` | INTEGER? |
| `wiki_力量` | `strength_value` | INTEGER? | `wiki_生命值` | `health_value` | INTEGER? |
| `wiki_经验值` | `printed_xp` | INTEGER? | `wiki_胜利点` | `victory_points` | INTEGER? |
| `正文_基础攻击` | `base_attack` | INTEGER? | `正文_基础魔法攻击` | `base_magic_attack` | INTEGER? |
| `wiki_印刷符号` | `printed_symbols` | TEXT? | `wiki_匹配状态` | `wiki_match_status` | TEXT |
| `wiki_数据备注` | `wiki_data_note` | TEXT? | `wiki_来源链接` | `wiki_source_url` | TEXT? |
| `upgrade_xp_cost` | `upgrade_xp_cost` | INTEGER? | `defeat_xp_reward` | `defeat_xp_reward` | INTEGER? |
| `wiki_review_status` | `wiki_review_status` | TEXT | `wiki_review_note` | `wiki_review_note` | TEXT? |
| `review_note` | `review_note` | TEXT? | — | — | — |

`card_tags` has primary key `(card_id, position)` and an index on `(tag, card_id)`. It retains tag order, so a card with `战士|盗贼` has positions 0 and 1. `card_definitions` has indexes on `(card_type, subcategory)` and `catalog_order`. SQLite foreign keys are enabled for backend sessions and import connections. No table duplicates a card definition for each TTS copy; `initial_copy_count` stays a property of the definition.

## Import and runtime flow

1. Alembic creates the three catalog tables alongside the existing `users` table.
2. An explicit import command reads the UTF-8 BOM CSV and setup index, checks their SHA-256 link, exact 47-column header, unique IDs and order, numeric/boolean conversions, and the tag projection.
3. In one SQLite transaction it writes all definitions, ordered tags and `catalog_meta`. A repeat import of the same hash is a no-op. A different hash requires `--replace` so a modified database is not overwritten by accident. Failure rolls back the entire import.
4. The backend loads the database snapshot for panel options, validation and setup. The engine receives the card rows and setup index through an explicit input parameter; it never opens the backend database.
5. The importer verifies a complete round trip: 722 database rows, exact CSV-shaped values for all 47 fields, and the same setup index/hash. Tests additionally compare deterministic setup output using CSV and SQLite snapshots.

The database lives at `data/thunderstone.db` by default and is ignored by Git because it also contains local accounts and eventually matches. A fresh deployment runs migrations and this explicit import. Card images remain in `cards/assets/` and are referenced by `image_path`; they are not stored as BLOBs.

The implemented import command, run from the repository root with the project venv, is:

```powershell
.\.venv\Scripts\python.exe backend\scripts\import_cards_to_sqlite.py
```

It applies Alembic migrations before importing. After editing the CSV, rebuild `cards/setup_catalog.json`, then use `backend\scripts\import_cards_to_sqlite.py --replace` to replace the catalog revision. The command reports `imported`, `unchanged` or `replaced` and the imported card count and hash.

## Revision and rollback policy

`catalog_meta.cards_csv_sha256` identifies the imported immutable catalog revision and is included in engine setup state as `catalog_version`. A new CSV revision requires rebuilding `setup_catalog.json` before import. Existing match states retain their original catalog version; future persistent matches must either keep the matching historical catalog snapshot or reject replay against a different revision. The current import replaces only the live catalog, so long-lived match persistence will need catalog revision retention before it is enabled.

Before `--replace`, back up the SQLite file if local accounts or other runtime data matter. The command changes only catalog tables, preserving users. The original CSV/index and card images remain available to reconstruct the catalog. A failed transaction leaves the prior catalog revision intact.
