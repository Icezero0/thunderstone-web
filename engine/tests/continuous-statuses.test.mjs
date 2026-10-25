import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {continuousCardStatuses} from '../dist/battle/statuses.js';
import {atom} from '../dist/effects/atoms.js';
import {Transition} from '../dist/turn/transaction.js';
import {isBattleSupport} from '../dist/battle/participation.js';
import {fixture, rules, cards} from './support/catalog.mjs';

const input = f => ({cards: f.cards, mechanics: f.rules.mechanics, state: f.state});
const statuses = f => continuousCardStatuses(input(f));
function team(f) {
  f.state.battle_context.battle_team = {
    hero_instance_ids: f.state.zones['player:alice:hand'].filter(id => server.isHero(f.cards[f.state.instances[id].card_id])),
    support_instance_ids: f.state.zones['player:alice:hand'].filter(id => isBattleSupport(f.cards[f.state.instances[id].card_id])),
  };
}
function preview(f, rank = 0) {
  const preparation = server.battlePreparation(f.state, 'alice', f.catalog, f.rules), draft = preparation.draft;
  draft.target_instance_id = rank ? f.hall[rank - 1] : null;
  const result = server.previewBattleTeam(preparation.context, draft);
  assert.deepEqual(browser.previewBattleTeam(preparation.context, draft), result);
  return result;
}

for (const rule of rules.mechanics.filter(rule => rule.op === 'hand_bonus'))
test(`${rule.id}: live hand-dependent bonus matches the actual numerical change`, () => {
  const f = fixture([rule.source_card_id]), id = f.hand[0], p = rule.params;
  f.rules = {...f.rules, mechanics: [rule], abilities: []};
  if (server.tags(cards[rule.source_card_id]).includes('武器')) {
    const hero = f.add('TS-0001'); f.state.battle_context.equipped_weapon_by_hero = {[hero]: [id]};
    f.state.battle_context.card_modifiers = {[hero]: {strength: 100}};
  }
  if (!p.absent) {
    const helper = Object.values(cards).find(card => card.card_type !== '游戏设置牌' && server.matches(card, p.filter ?? {})
      && (p.metric !== 'gold' || server.stat(card, 'gold') > 0));
    assert.ok(helper, rule.id);
    for (let i = 0; i < Math.max(3, p.minimum ?? 0, p.divisor ?? 0); i++) f.add(helper.card_id);
  }
  team(f);
  const result = preview(f), base = server.combatValues({...input(f), mechanics: []}, 0);
  const row = result.continuous_card_statuses[id]?.find(row => row.source_card_id === rule.source_card_id);
  assert.ok(row, rule.id);
  for (const field of ['attack', 'magic_attack', 'light', 'strength']) if (p[field]) {
    const current = field === 'strength' ? result.calculation.hero_strength[id] : result.calculation.components.find(item => item.instance_id === id)?.[field] ?? 0;
    const previous = field === 'strength' ? base.hero_strength[id] : base.components.find(item => item.instance_id === id)?.[field] ?? 0;
    assert.ok(current > previous, rule.id);
    assert.ok(row.description.includes(`+${current - previous}`));
  }
});

for (const rule of rules.mechanics.filter(rule => rule.op === 'rank_bonus'))
test(`${rule.id}: conditional rank bonus has matching status and vanishes when outside its range`, () => {
  const f = fixture([rule.source_card_id], ['TS-0476', 'TS-0476', 'TS-0476']);
  if (server.tags(f.cards[rule.source_card_id]).includes('武器')) {
    const hero = f.add('TS-0001');
    f.state.battle_context.equipped_weapon_by_hero = {[hero]: [f.hand[0]]};
    f.state.battle_context.card_modifiers = {[hero]: {strength: 100}};
  }
  f.rules = {...f.rules, mechanics: [rule], abilities: []}; team(f);
  const rank = Math.max(1, rule.params.minimum ?? 1), result = preview(f, rank), id = f.hand[0];
  const row = result.continuous_card_statuses[id]; assert.ok(row?.length, rule.id);
  const field = rule.params.light ? 'light' : 'attack';
  const amount = rule.params[field] * (rule.params.scale ? rank : 1);
  assert.match(row[0].description, new RegExp(`\\+${amount}(?:$|，)`));
  assert.equal(result.calculation.components.find(item => item.instance_id === id)[field], server.stat(f.cards[rule.source_card_id], field) + amount);
  assert.equal(preview(f).continuous_card_statuses[id], undefined);
});

for (const rule of rules.mechanics.filter(rule => rule.op === 'target_bonus'))
test(`${rule.id}: opponent-dependent bonus disappears when no opponent is selected`, () => {
  const p = rule.params, monster = Object.values(cards).find(card => server.isMonster(card) && server.stat(card, 'health') > 0
    && (!p.tag || server.tags(card).includes(p.tag)));
  const f = fixture([rule.source_card_id], [monster.card_id, monster.card_id, monster.card_id]);
  if (p.same_family) f.add(monster.card_id);
  f.rules = {...f.rules, abilities: [], mechanics: [rule]}; team(f);
  const result = preview(f, Math.max(1, p.minimum_rank ?? 1)), source = f.hand[0];
  assert.ok(result.continuous_card_statuses[source]?.some(row => row.source_card_id === rule.source_card_id));
  assert.equal(preview(f).continuous_card_statuses[source], undefined);
});

for (const sourceCard of ['TS-0336', 'TS-0337', 'TS-0338'])
test(`${sourceCard}: no-magic bonus is visible only while the team has no magic attack`, () => {
  const f = fixture([sourceCard, 'TS-0279']); team(f);
  f.state.battle_context.battle_team.support_instance_ids = [];
  const rule = f.rules.mechanics.find(rule => rule.source_card_id === sourceCard && rule.op === 'no_magic_bonus');
  assert.ok(statuses(f)[f.hand[0]].some(row => row.description === `攻击 +${rule.params.attack}`));
  f.state.battle_context.battle_team.support_instance_ids = [f.hand[1]];
  assert.equal(statuses(f)[f.hand[0]], undefined);
});

test('extra equipment capacity, weapon discounts, excess light and magic doubling have source-labeled states', () => {
  const f = fixture(['TS-0325', 'TS-0370', 'TS-0403', 'TS-0003', 'TS-0003']); team(f);
  const rows = statuses(f);
  assert.ok(rows[f.hand[0]].some(row => row.description === '可装备武器：不限张数'));
  assert.ok(rows[f.hand[1]].some(row => /魔法攻击 \+/.test(row.description)));
  assert.ok(rows[f.hand[2]].some(row => row.description === '本次队伍魔法攻击翻倍'));
  const g = fixture(['TS-0372', 'TS-0237']); team(g);
  g.state.battle_context.card_modifiers = {[g.hand[0]]: {strength: 100}};
  g.state.battle_context.equipped_weapon_by_hero = {[g.hand[0]]: [g.hand[1]]};
  assert.ok(statuses(g)[g.hand[1]].some(row => /装备所需力量/.test(row.description)));
});

test('an activated global light effect carries its public source into browser preview and expires cleanly', () => {
  const f = fixture(['TS-0288', 'TS-0001']); team(f);
  const tx = new Transition(f.state, f.catalog, f.rules);
  atom(tx, {op: 'add_global_rule', kind: 'light', scope: 'all', amount: 1, until: 'owner_next_turn_end'}, {source: f.hand[0]}, 'TS-0288-A01');
  f.state = tx.state;
  const result = preview(f);
  assert.ok(result.continuous_card_statuses[f.hand[1]].some(row => row.source_card_id === 'TS-0288' && row.description.startsWith('队伍光照 +1')));
  f.state.continuous_effects = [];
  assert.equal(statuses(f)[f.hand[1]], undefined);
});

for (const rule of rules.mechanics.filter(rule => rule.op === 'equipment_bonus'))
test(`${rule.id}: equipment condition projects the actual recipient and disappears on unequip`, () => {
  const p = rule.params, sourceCard = cards[rule.source_card_id], sourceIsHero = server.isHero(sourceCard);
  const hero = sourceIsHero ? sourceCard : Object.values(cards).find(card => server.isHero(card) && server.stat(card, 'strength') > 0
    && (!p.level_scale || server.stat(card, 'level') > 0)
    && (!p.hero_tag || p.hero_tag.split('|').some(tag => server.tags(card).includes(tag))));
  const weapon = sourceIsHero ? Object.values(cards).find(card => server.tags(card).includes('武器') && card.wiki_重量 !== ''
    && (!p.weapon_tag || server.tags(card).includes(p.weapon_tag)) && server.stat(card, 'weight') <= (p.weight_max ?? 100)) : sourceCard;
  const monster = Object.values(cards).find(card => server.isMonster(card) && server.stat(card, 'health') > 0 && (!p.target_tags_any || p.target_tags_any.some(tag => server.tags(card).includes(tag))));
  const f = fixture([hero.card_id, weapon.card_id], [monster.card_id, monster.card_id]);
  const [owner, item] = f.hand, source = sourceIsHero ? owner : item;
  f.rules = {...f.rules, abilities: [], mechanics: [rule]}; team(f);
  f.state.battle_context.card_modifiers = {[owner]: {strength: 100}};
  f.state.battle_context.equipped_weapon_by_hero = {[owner]: [item]};
  const rank = Math.max(1, p.minimum_rank ?? 1), result = preview(f, rank);
  const recipient = p.strength ? owner : source, rows = result.continuous_card_statuses[recipient];
  const field = p.strength ? 'strength' : p.magic_attack ? 'magic_attack' : p.light ? 'light' : 'attack';
  const amount = p[field] * (p.level_scale ? server.stat(hero, 'level') : 1);
  assert.ok(rows?.some(row => row.source_card_id === rule.source_card_id && row.description.includes(`${amount >= 0 ? '+' : ''}${amount}`)), rule.id);
  assert.equal(rows[0].kind, amount > 0 ? 'buff' : 'debuff');
  const before = structuredClone(f.state); statuses(f); assert.deepEqual(f.state, before);
  f.state.battle_context.equipped_weapon_by_hero = {};
  assert.equal(statuses(f)[recipient], undefined);
});

test('a selected Sirian aura buffs militia including Elite Militia, and removal immediately clears it', () => {
  const elite = Object.values(cards).find(card => card.name === '精锐民兵' && server.stat(card, 'strength') > 0);
  const f = fixture(['TS-0346', 'TS-0001', elite.card_id]); team(f);
  const [source, militia, veteran] = f.hand;
  for (const id of [militia, veteran]) assert.ok(statuses(f)[id].some(row => row.source_card_id === 'TS-0346' && row.description === '攻击 +1'));
  f.state.battle_context.battle_team.hero_instance_ids = [militia, veteran];
  for (const id of [militia, veteran]) assert.equal(statuses(f)[id], undefined);
  f.state.battle_context.battle_team.hero_instance_ids.push(source);
  f.state.zones['player:alice:hand'].splice(0, 1); f.state.zones.destroyed.push(source);
  for (const id of [militia, veteran]) assert.equal(statuses(f)[id], undefined);
});

test('hand-dependent Phalanx strength and attack share one source record and update with hand changes', () => {
  const f = fixture(['TS-0328', 'TS-0328']); team(f);
  assert.equal(statuses(f)[f.hand[0]][0].description, '力量 +1，攻击 +1');
  f.state.zones['player:alice:hand'].pop();
  assert.equal(statuses(f)[f.hand[0]], undefined);
});

test('Sharulin selected item/spell aura and spell casts update buffs without touching printed data', () => {
  const f = fixture(['TS-0402', 'TS-0003', 'TS-0279']); team(f);
  f.state.battle_context.spell_cast_counts = {[f.hand[2]]: 2};
  for (const id of f.hand.slice(1)) assert.ok(statuses(f)[id].some(row => row.source_card_id === 'TS-0402'));
  const before = structuredClone(f.state), result = preview(f); assert.deepEqual(f.state, before);
  assert.deepEqual(result.continuous_card_statuses, statuses(f));
  f.state.battle_context.battle_team.hero_instance_ids = [];
  for (const id of f.hand.slice(1)) assert.equal(statuses(f)[id], undefined);
});

test('hall strength, light and cross-dungeon health auras show actual affected instances without self health buffs', () => {
  const f = fixture(['TS-0001'], ['TS-0476']); team(f);
  const knight = f.add('TS-0680', 'hall:main:rank0'), sentinel = f.add('TS-0679', 'hall:b:rank0');
  let rows = statuses(f);
  assert.ok(rows[f.hand[0]].some(row => row.source_card_id === 'TS-0680' && row.description === '力量 -1' && row.kind === 'debuff'));
  assert.ok(rows[f.hall[0]].some(row => row.source_card_id === 'TS-0680' && row.description === '生命值 +1'));
  assert.ok(rows[f.hall[0]].some(row => row.source_card_id === 'TS-0679' && row.description === '生命值 +1'));
  assert.equal(rows[knight].filter(row => row.source_card_id === 'TS-0680' && row.description.includes('生命值')).length, 0);
  assert.equal(rows[sentinel].filter(row => row.source_card_id === 'TS-0679' && row.description.includes('生命值')).length, 0);
  f.state.zones['hall:main:rank0'] = []; f.state.zones['dungeon:main'].push(knight);
  rows = statuses(f); assert.equal(rows[f.hand[0]], undefined);
  assert.deepEqual(rows[f.hall[0]].map(row => row.source_card_id), ['TS-0679']);
});

test('target immunity and rank restriction are visible only for the previewed opponent', () => {
  const f = fixture(['TS-0001', 'TS-0279', 'TS-0363'], ['TS-0506', 'TS-0476']); team(f);
  let rows = preview(f, 1).continuous_card_statuses;
  for (const id of f.hand.slice(0, 2)) assert.ok(rows[id].some(row => row.kind === 'debuff' && row.source_card_id === 'TS-0506'));
  assert.ok(rows[f.hand[2]].some(row => row.description === '不能攻击阶层 1'));
  rows = preview(f, 2).continuous_card_statuses;
  for (const id of f.hand) assert.ok(!(rows[id] ?? []).some(row => row.source_card_id === 'TS-0506'));
  assert.ok(!(rows[f.hand[2]] ?? []).some(row => row.description === '不能攻击阶层 1'));
});

test('village price passives and monster gold suppression have statuses without a battle team', () => {
  const f = fixture(['TS-0226', 'TS-0720', 'TS-0476']);
  f.state.chosen_action = 'village'; f.state.subphase = 'VILLAGE_ABILITIES';
  f.state.active_settings = ['TS-0189']; const environment = f.add('TS-0189', 'settings');
  const rows = server.turnOptions(f.state, 'alice', f.catalog, f.rules).card_statuses;
  assert.equal(rows[f.hand[0]][0].description, '英雄购买价格 -1');
  assert.equal(rows[f.hand[1]][0].description, '所有牌购买价格 +3');
  assert.equal(rows[environment][0].description, '怪物卡的金币值视为 0');
  const monsterWithGold = Object.values(cards).find(card => server.isMonster(card) && server.stat(card, 'gold') > 0);
  const trophy = f.add(monsterWithGold.card_id);
  assert.equal(statuses(f)[trophy][0].description, '金币值视为 0');
});

test('activated weight and conversion rules retain source labels after the source leaves hand, including browser projection', () => {
  const f = fixture(['TS-0004', 'TS-0001', 'TS-0002']); team(f);
  const tx = new Transition(f.state, f.catalog, f.rules);
  for (const flag of ['zero_weapon_weight', 'convert_equipped_magic']) atom(tx, {op: 'set_battle_flag', flag, value: true}, {source: f.hand[0]}, 'TS-0004-A01');
  tx.state.battle_context.equipped_weapon_by_hero = {[f.hand[1]]: [f.hand[2]]};
  tx.move(f.hand[0], 'player:alice:hand', 'player:alice:discard');
  f.state = tx.state;
  const result = preview(f), rows = result.continuous_card_statuses[f.hand[2]];
  assert.ok(rows.some(row => row.description === '重量视为 0' && row.source_name === '应急干粮'));
  assert.ok(rows.some(row => row.description === '攻击转化为魔法攻击' && row.source_name === '应急干粮'));
  assert.equal(JSON.stringify(rows).includes(f.hand[0]), false);
});
