"""Inventory exact-card, classification and name predicates in published effects.

The generated inventory is separate from the manually reviewed audit document.
Without --output, print a read-only JSON summary.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from backend.app.integrations.game_engine.catalog.repository import load_catalog  # noqa: E402

RULE_FILES = ('classic-v1.json', 'simple-reviewed.json', 'action-reviewed.json',
              'battle-reviewed.json', 'event-reviewed.json', 'mechanics.json')
CLASS_FIELDS = {'card_type', 'exclude_card_type', 'subcategory', 'semantic_type'}
IDENTITY_FIELDS = CLASS_FIELDS | {
    'card_id', 'exclude_card_id', 'equipper_card_id', 'hero_card_id',
    'name', 'name_in_var', 'same_name_as_var', 'duplicate_names',
    'setting_active', 'reserve_card_id',
}
FIXED_MILITIA_SUPPLIES = {'TS-0522-A01', 'TS-0601-A01'}


def predicates(value, path='$', fields=CLASS_FIELDS):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in fields:
                yield path + '.' + key, key, child
            yield from predicates(child, path + '.' + key, fields)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from predicates(child, path + f'[{index}]', fields)


def collect(fields=CLASS_FIELDS):
    """Keep the classification-only default used by existing identity tests."""
    cards = load_catalog().cards
    draft_path = ROOT / 'docs/游戏引擎设计参考/thunderstone_card_rules_v0.3.2_engine.json'
    draft = json.loads(draft_path.read_text(encoding='utf-8-sig'))
    lines = {item['id']: item['source_line'] for card in draft['cards'] for item in card['abilities']}
    rows = []
    for filename in RULE_FILES:
        source = json.loads((ROOT / 'cards/effects' / filename).read_text(encoding='utf-8-sig'))
        for ability in source if isinstance(source, list) else source['abilities']:
            card = cards[ability['source_card_id']]
            source_line = ability.get('source_line') or lines.get(ability['id'], '')
            if source_line not in card['effect_text'].splitlines():
                source_line = card['effect_text']
            for path, field, value in predicates(ability, fields=fields):
                rows.append({'ability_id': ability['id'], 'card_id': ability['source_card_id'],
                             'name': card['name'], 'field': field, 'value': value,
                             'path': path, 'file': filename, 'source_line': source_line})
    return cards, rows


def violations(rows):
    """Approved fixed supply operations are not identity predicates."""
    return [row for row in rows if
            (row['field'] == 'subcategory' and row['value'] in ('怪物', '雷霆之石', '宝藏'))
            or (row['field'] in ('card_type', 'exclude_card_type') and row['value'] in ('疾病牌', '村庄牌'))
            or (row['field'] == 'name' and row['value'] == '民兵')
            or (row['value'] == 'TS-0001' and row['field'] in
                ('card_id', 'exclude_card_id', 'equipper_card_id', 'hero_card_id')
                and not (row['field'] == 'card_id' and row['ability_id'] in FIXED_MILITIA_SUPPLIES
                         and row['path'] == '$.body.card_id'))]


def summary(rows):
    counts = {}
    for filename in RULE_FILES:
        data = json.loads((ROOT / 'cards/effects' / filename).read_text(encoding='utf-8-sig'))
        counts[filename] = len(data if isinstance(data, list) else data['abilities'])
    return {'abilities': sum(count for filename, count in counts.items() if filename != 'mechanics.json'),
            'mechanics': counts['mechanics.json'], 'predicate_positions': len(rows),
            'predicates': dict(Counter(f'{row["field"]}={row["value"]}' for row in rows)),
            'legacy_identity_filters': violations(rows)}


def render(cards, rows):
    stats = summary(rows)
    text = ['# Effect identity predicate inventory', '',
            f'Scanned {stats["abilities"]} abilities and {stats["mechanics"]} mechanics.',
            'This is a generated inventory, not a rule interpretation.',
            'Reviewed decisions: docs/game-engine/effect-identity-audit.md.', '',
            '| Card | Ability | Predicate | File and JSON path | Card text |',
            '| --- | --- | --- | --- | --- |']
    def cell(value):
        return str(value).replace('|', '\\|').replace('\n', '<br>')
    for row in sorted(rows, key=lambda row: (row['ability_id'], row['path'])):
        values = (f'{row["card_id"]} {row["name"]}', row['ability_id'],
                  f'{row["field"]}={row["value"]}', f'{row["file"]}: {row["path"]}', row['source_line'])
        text.append('| ' + ' | '.join(cell(value) for value in values) + ' |')
    text += ['', f'Unapproved legacy identity filters: {len(stats["legacy_identity_filters"])}.', '']
    return '\n'.join(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Optional generated inventory destination; omit for read-only summary.')
    parser.add_argument('--check', action='store_true', help='Compare an existing generated inventory without writing it.')
    args = parser.parse_args()
    cards, rows = collect(IDENTITY_FIELDS)
    if args.output:
        content = render(cards, rows)
        if args.check:
            if args.output.read_text(encoding='utf-8-sig') != content:
                raise ValueError(f'stale effect identity inventory: {args.output}')
        else:
            args.output.write_text(content, encoding='utf-8')
    print(json.dumps(summary(rows), ensure_ascii=False))
    return int(bool(violations(rows)))


if __name__ == '__main__':
    raise SystemExit(main())
