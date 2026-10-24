"""Report reviewed effect predicates still based on card classifications."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from backend.app.integrations.game_engine.catalog.repository import load_catalog  # noqa: E402

RULE_FILES = ('classic-v1.json', 'simple-reviewed.json', 'action-reviewed.json',
              'battle-reviewed.json', 'event-reviewed.json', 'mechanics.json')
CLASS_FIELDS = {'card_type', 'exclude_card_type', 'subcategory', 'semantic_type'}


def predicates(value, path='$'):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in CLASS_FIELDS:
                yield path + '.' + key, key, child
            yield from predicates(child, path + '.' + key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from predicates(child, path + f'[{index}]')


def collect():
    cards = load_catalog().cards
    draft = json.loads((ROOT / 'docs/游戏引擎设计参考/thunderstone_card_rules_v0.3.2_engine.json').read_text(encoding='utf-8'))
    lines = {item['id']: item['source_line'] for card in draft['cards'] for item in card['abilities']}
    rows = []
    for filename in RULE_FILES:
        source = json.loads((ROOT / 'cards/effects' / filename).read_text(encoding='utf-8'))
        for ability in source if isinstance(source, list) else source['abilities']:
            for path, field, value in predicates(ability):
                rows.append({'ability_id': ability['id'], 'card_id': ability['source_card_id'],
                             'name': cards[ability['source_card_id']]['name'], 'field': field,
                             'value': value, 'path': path, 'file': filename,
                             'source_line': lines.get(ability['id'], ability.get('source_line', ''))})
    return cards, rows


def render(cards, rows):
    pending = [row for row in rows if not (row['field'] == 'semantic_type' and row['value'] in ('hero', 'monster'))]
    grouped = defaultdict(list)
    for row in pending:
        grouped[row['field'], row['value']].append(row)
    text = ['# 效果身份判断审计', '',
            '本清单覆盖全部 446 条可执行能力、222 条持续规则，以及共用处理代码。英雄、怪物、疾病、雷霆之石、村庄身份已改为标签；下列其他身份保留现有实现，等待决定。', '',
            '## 已转换的怪物判断', '',
            '- 38 条能力中的 56 个 `subcategory=怪物` 谓词已改为 `tag=怪物`；生成脚本同步更新。',
            '- `semantic_type=monster`、怪物金币归零、同族加成的手牌筛选、最少怪物数量计分，以及怪物战斗目标，均检查怪物标签。',
            '- 怪物下方附着疾病等动作校验同样检查标签；守护者的特殊阶层、战败去向及卡文移动限制另行处理。',
            '- 阶层 0 守护者可以被返回地下城牌堆，不参加普通阶层换位；返回使用所属地下城的真实牌堆，也不触发普通阶层补位。死亡哨卫、黑暗勇士仍须被击败才可从大厅离场，该限制不妨碍将手牌中的对应战利品换入大厅。直接击败守护者正常给予经验，击败末日之心仍触发终局。',
            '- `subcategory=怪物` 作为通用 DSL 的精确分类过滤能力仍可使用，但当前发布效果不再用它表示通用怪物身份。', '',
            '## 已转换的疾病与雷霆之石判断', '',
            '- 26 条能力中的 45 个疾病分类判断改为“疾病”标签；84 条能力中的 160 个排除疾病判断改为 `tags_none=[疾病]`。正向与排除判断可能出现在同一能力中，不可直接相加。',
            '- 疾病攻击惩罚、攻击转魔法时排除疾病、疾病附着校验、移交后的获得替代流程，以及摧毁疾病时回无限供应，均按疾病标签识别。',
            '- 亵渎守卫的雷石返回效果、雷石计数与计分平局优先、大厅雷石终局检测，以及开局跳过雷石，均按“雷霆之石”标签识别。',
            '- 末日之心同时具有“怪物”“雷霆之石”标签，计入两类数量及相关计分（包括恐惧之石的其他雷石加分）；它仍优先执行守护者及末日之心的专属突破／终局流程。',
            '- 乌布里克的头盔／护甲／臂甲已补上“宝藏”标签，CSV、规则来源和 SQLite 同步；宝藏效果的分类过滤暂时保留。', '',
            '## 其他分类筛选汇总', '',
            '“能力数”按能力 ID 去重；同一能力的存在性检查、数量计算和选择器可能重复使用同一谓词，故另列位置数。不同类别的能力数不可直接相加。', '',
            '| 当前判断 | 能力数 | 位置数 | 可供选择的转换方向 |',
            '| --- | ---: | ---: | --- |']
    notes = {
        ('subcategory', '宝藏'): '全部 13 张宝藏均有独立“宝藏”标签；目前仅补齐数据，效果筛选仍保留分类。',
        ('subcategory', '方阵'): '这是英雄系列而非牌种；当前用二级分类匹配，两张方阵英雄尚无“方阵”标签。',
    }
    for key, matching in sorted(grouped.items()):
        text.append(f'| `{key[0]}={key[1]}` | {len({row["ability_id"] for row in matching})} | {len(matching)} | {notes.get(key, "需核对具体语义。")} |')
    text += ['', '## 按卡牌列出的剩余效果', '',
             '| 卡牌 | 能力 | 当前判断 | 出现位置数 | 对应卡文 |',
             '| --- | --- | --- | ---: | --- |']
    by_ability = defaultdict(list)
    for row in pending:
        by_ability[row['card_id'], row['ability_id'], row['field'], row['value']].append(row)
    for (card_id, ability_id, field, value), matching in sorted(by_ability.items()):
        row = matching[0]
        line = row['source_line'].replace('|', '\\|').replace('\n', '<br>')
        text.append(f'| {card_id} {row["name"]} | `{ability_id}` | `{field}={value}` | {len(matching)} | {line} |')
    text += ['', '## 已确认的村庄身份与相关卡文', '',
             '- 村庄身份为全部 92 张村庄槽位的牌，加上火把、匕首、应急干粮，共 95 张可用卡牌定义。民兵及大分类为英雄牌的牌不属于村庄牌；大分类与供应区结构仍各自保留。',
             '- 精锐民兵、村庄强盗、村庄扒手同时具有“英雄”“村庄”标签。各身份独立匹配，不采用英雄优先的互斥分类。',
             '- 下列 10 条能力中的 11 个村庄分类判断已统一使用“村庄”标签。酋长战鼓宣告英雄或村庄均可匹配这些双重身份牌；熊掌斯特朗将它们计入村庄牌；焰怒龙可选择三张基础村庄牌。',
             '- 村庄购买不再临时修改卡牌大分类；商人的“非英雄”限制仍额外排除英雄标签。随机设置牌原有的村庄标签用于选组，不是玩家可用卡牌。', '',
             '| 卡牌 | 已转换的对应卡文 |', '| --- | --- |']
    village_cards = {'TS-0221', 'TS-0299', 'TS-0300', 'TS-0301', 'TS-0338',
                     'TS-0374', 'TS-0460', 'TS-0560', 'TS-0595', 'TS-0699'}
    classified_lines = set()
    for card_id in sorted(village_cards):
        card = cards[card_id]
        for source_line in card['effect_text'].splitlines():
            if any(part in source_line for part in ('村庄牌', '宣告英雄', '非英雄牌')):
                classified_lines.add(source_line)
                text.append(f'| {card_id} {card["name"]} | {source_line.replace("|", "・")} |')
    text += ['',
             '以下其他卡文也提到村庄牌，但当前使用具体标签或供应区域，不依赖“村庄牌”分类谓词：', '',
             '| 卡牌 | 对应卡文 | 当前处理方式 |', '| --- | --- | --- |']
    for card_id, card in sorted(cards.items()):
        for source_line in card['effect_text'].splitlines():
            if '村庄牌' not in source_line or source_line in classified_lines:
                continue
            if card_id in {'TS-0332', 'TS-0340', 'TS-0358', 'TS-0371', 'TS-0380', 'TS-0407', 'TS-0445', 'TS-0579'}:
                handling = '购买接口按武器／物品与光照／村民／法术／食物等条件筛选。'
            elif card_id == 'TS-0359':
                handling = '按武器标签查询手牌和村庄供应区。'
            elif card_id == 'TS-0192':
                handling = '设置时调整村庄和英雄组数。'
            else:
                handling = '按村庄供应区及牌堆条件处理，不判断手牌的村庄身份。'
            text.append(f'| {card_id} {card["name"]} | {source_line.replace("|", "・")} | {handling} |')
    text += ['', '## 共用处理代码中的分类判断', '',
             '这些代码未在本轮统一转换。它们有些判断牌的身份，有些决定供应区或生命周期，后者不宜直接等价为标签。', '',
             '| 位置 | 现有用途 | 待决定内容 |', '| --- | --- | --- |',
             '| `turn/village.py` | 英雄升级目标与所属英雄系列 | 属于升级和供应结构；村庄购买身份已经统一使用标签。 |',
             '| `effects/inventory.py` | 被摧毁的基础／村庄／英雄牌回到对应供应区；按英雄系列匹配和排序 | 供应归属与系列信息应继续显式保留。 |',
             '| `effects/hall_actions.py`、`turn/hall.py` | 陷阱洗回、大厅翻出陷阱／宝藏／守护者时的不同流程 | 是否把这些子类识别改成对应标签；流程本身仍不同，雷石已改用标签。 |',
             '| `catalog/cards.ts`、`effects/combat.py` | 通用过滤器支持 `card_type`、`subcategory`、`exclude_card_type` | 这是 DSL 的可用字段，不是单独的卡牌规则；可保留精确分类查询能力。 |',
             '| `setup/`、设置目录生成器 | 普通怪物随机组与守护者池分开、不同供应和实例倍率、开局跳过非普通怪物 | 属于组局分类，本轮不把守护者混入普通怪物随机组。 |', '',
             '英雄身份本身已使用“英雄”标签。武器、法术、物品、食物、职业、怪物族群等大部分效果也已经按标签处理。', '',
             '## 数据前提', '',
             '下表按原分类统计。末日之心另属于守护者，因此雷石标签的总数为 8，而二级分类为雷霆之石的牌仍为 7 张。', '',
             '| 拟用标签 | 对应牌面数量 | 缺少该标签的数量 |', '| --- | ---: | ---: |']
    for field, value, tag in (('card_type','疾病牌','疾病'), ('card_type','村庄牌','村庄'),
                              ('subcategory','宝藏','宝藏'), ('subcategory','雷霆之石','雷霆之石'), ('subcategory','方阵','方阵')):
        definitions = [card for card in cards.values() if card['slot_kind'] == 'front' and card[field] == value]
        if tag == '村庄':
            definitions += [cards[card_id] for card_id in ('TS-0002', 'TS-0003', 'TS-0004')]
        text.append(f'| {tag} | {len(definitions)} | {sum(tag not in card["tags"].split("|") for card in definitions)} |')
    missing_treasure = [f'{card["card_id"]} {card["name"]}（现有标签：`{card["tags"].replace("|", "・")}`）'
                        for card in cards.values() if card['subcategory'] == '宝藏' and '宝藏' not in card['tags'].split('|')]
    text += ['', ('缺少独立“宝藏”标签的牌：' + '；'.join(missing_treasure) + '。')
             if missing_treasure else '全部宝藏牌均已具有独立“宝藏”标签。']
    text += ['', '复查命令：`.\\.venv\\Scripts\\python.exe -X utf8 backend/scripts/effects/audit_effect_identity.py --output docs/game-engine/effect-identity-audit.md`。', '']
    return '\n'.join(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    cards, rows = collect()
    legacy = [row for row in rows if row['field'] == 'subcategory' and row['value'] == '怪物']
    legacy_other = [row for row in rows if (row['field'], row['value']) in {
        ('card_type', '疾病牌'), ('exclude_card_type', '疾病牌'), ('subcategory', '雷霆之石')}]
    legacy_village = [row for row in rows if (row['field'], row['value']) in {
        ('card_type', '村庄牌'), ('semantic_type', 'village')}]
    content = render(cards, rows)
    if args.output:
        if args.check:
            if args.output.read_text(encoding='utf-8') != content:
                raise ValueError(f'stale effect identity report: {args.output}')
        else:
            args.output.write_text(content, encoding='utf-8')
    print(json.dumps({'legacy_monster_filters': len(legacy), 'legacy_disease_stone_filters': len(legacy_other),
        'legacy_village_filters': len(legacy_village), 'remaining_classification_positions': len(rows) - sum(
        row['field'] == 'semantic_type' and row['value'] in ('hero', 'monster') for row in rows),
        'remaining_kinds': dict(Counter(f'{row["field"]}={row["value"]}' for row in rows
                                      if row['field'] != 'semantic_type' or row['value'] == 'village'))}, ensure_ascii=False))
    return int(bool(legacy or legacy_other or legacy_village))


if __name__ == '__main__':
    raise SystemExit(main())
