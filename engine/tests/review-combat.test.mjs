import assert from 'node:assert/strict';
import test from 'node:test';
import * as e from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {cards, rules, fixture} from './support/catalog.mjs';

const calculation = f => ({cards: f.cards, mechanics: f.rules.mechanics, state: f.state});
const contribution = (trace, id, field = 'attack') => trace.components.find(row => row.instance_id === id)?.[field] ?? 0;
const command = (f, value) => {
  const result = e.applyCommand(f.state, {player_id: f.state.pending_choice?.player_id ?? 'alice', ...value}, f.catalog, f.rules);
  f.state = result.state; return result;
};

test('R05 halberd reads final strength independently of mechanic order', () => {
  for (const reverse of [false, true]) {
    const reduced = fixture(['TS-0316', 'TS-0255'], ['TS-0680']);
    reduced.state.battle_context.equipped_weapon_by_hero = {[reduced.hand[0]]: [reduced.hand[1]]};
    const raised = fixture(['TS-0315', 'TS-0258', 'TS-0255']);
    raised.state.battle_context.equipped_weapon_by_hero = {[raised.hand[0]]: raised.hand.slice(1)};
    for (const [f, expectedStrength, weapon, expectedAttack] of [[reduced, 7, reduced.hand[1], 2], [raised, 9, raised.hand[2], 6]]) {
      const input = calculation(f); if (reverse) input.mechanics = [...input.mechanics].reverse();
      const trace = e.combatValues(input, 1);
      assert.equal(trace.hero_strength[f.hand[0]], expectedStrength);
      assert.equal(contribution(trace, weapon), expectedAttack);
      assert.deepEqual(browser.combatValues(input, 1), trace);
    }
  }
});

test('Q07 gauntlets each add a slot, while all weapon burdens share hero strength', () => {
  const f = fixture(['TS-0001', 'TS-0258', 'TS-0258', 'TS-0002', 'TS-0002']);
  const [hero, first, second, dagger, extra] = f.hand;
  f.state.battle_context.equipped_weapon_by_hero = {[hero]: [first, second]};
  assert.equal(e.equipmentCapacity(calculation(f), hero), 3);
  assert.equal(e.canEquipWeapon(calculation(f), hero, dagger), true);
  f.state.battle_context.equipped_weapon_by_hero[hero].push(dagger);
  assert.equal(e.canEquipWeapon(calculation(f), hero, extra), false);
  const axe = Object.values(cards).find(card => card.name === '霜巨人战斧' && card.card_type === '村庄牌').card_id;
  const heavy = fixture(['TS-0325', axe, axe]);
  heavy.state.battle_context.equipped_weapon_by_hero = {[heavy.hand[0]]: [heavy.hand[1]]};
  assert.equal(e.canEquipWeapon(calculation(heavy), heavy.hand[0], heavy.hand[2]), false);
  heavy.state.battle_context.zero_weapon_weight = true;
  assert.equal(e.canEquipWeapon(calculation(heavy), heavy.hand[0], heavy.hand[2]), true);
});

test('R06 effective weight applies to comparisons, extrema, scalar values, sums and equipment', () => {
  const f = fixture(['TS-0001', 'TS-0002']);
  const axe = Object.values(cards).find(card => card.name === '霜巨人战斧' && card.card_type === '村庄牌').card_id;
  const weapon = f.add(axe, 'village_supply:axe');
  const query = {zone: 'village_supply_top', tag: '武器', equippable_by_var: 'hero'};
  assert.deepEqual(new e.EffectEvaluation(calculation(f)).query(query, {hero: f.hand[0]}), []);
  f.state.battle_context.zero_weapon_weight = true;
  const evaluation = new e.EffectEvaluation(calculation(f));
  assert.deepEqual(evaluation.query(query, {hero: f.hand[0]}), [weapon]);
  assert.deepEqual(evaluation.query({zone: 'village_supply_top', weight_max: 0}), [weapon]);
  assert.deepEqual(evaluation.query({zone: 'village_supply_top', compare_stat: {field: 'weight', op: 'eq', value: 0}}), [weapon]);
  assert.equal(evaluation.expression({stat: {var: 'weapon', field: 'weight'}}, {weapon}), 0);
  assert.equal(evaluation.expression({sum: {query: {zone: 'active_hand', tag: '武器'}, field: 'weight'}}), 0);
  const second = f.add('TS-0002', 'village_supply:dagger');
  assert.deepEqual(new e.EffectEvaluation(calculation(f)).query({zone: 'village_supply_top', max_by: 'weight'}).sort(), [weapon, second].sort());
});

test('R06 magic aura then phantom blade equips an otherwise overweight village weapon', () => {
  const f = fixture(['TS-0001', 'TS-0281', 'TS-0265']);
  const axe = Object.values(cards).find(card => card.name === '霜巨人战斧' && card.card_type === '村庄牌').card_id;
  const weapon = f.add(axe, `village_supply:${axe}`);
  command(f, {type: 'ActivateAbility', source_instance_id: f.hand[1], ability_id: 'TS-0281-A01'});
  command(f, {type: 'ActivateAbility', source_instance_id: f.hand[2], ability_id: 'TS-0265-A01'});
  if (f.state.pending_choice) command(f, {type: 'ResolveChoice', instance_id: f.hand[0]});
  if (f.state.pending_choice) command(f, {type: 'ResolveChoice', instance_id: weapon});
  assert.ok(f.state.zones['player:alice:hand'].includes(weapon));
  assert.ok(e.combatValues(calculation(f), 1).equipped_pairs.some(([hero, item]) => hero === f.hand[0] && item === weapon));
});

test('R07 Slynn family bonus is confined to ranks two and three', () => {
  for (const [hero, base, bonus] of [['TS-0360', 2, 3], ['TS-0361', 3, 4]]) {
    const f = fixture([hero, 'TS-0480']);
    for (const rank of [1, 2, 3, 4]) assert.equal(contribution(e.combatValues(calculation(f), rank, cards['TS-0481']), f.hand[0]),
      base + ([2, 3].includes(rank) ? bonus : 0));
  }
});

test('R08 Sorrow witch increases hero price only while in the dungeon hall', () => {
  const f = fixture(['TS-0674']), target = cards['TS-0314'], price = e.stat(target, 'cost');
  assert.equal(e.purchasePrice(calculation(f), target), price);
  f.state.zones['player:alice:hand'] = []; f.state.zones['hall:main'].push(f.hand[0]);
  assert.equal(e.purchasePrice(calculation(f), target), price + 2);
});

test('R09 all actual disease-granting monsters have the semantic tag, including variable counts', () => {
  const grantsDisease = node => node && typeof node === 'object'
    && (node.op === 'gain_disease' || Object.values(node).some(grantsDisease));
  const givers = new Set(rules.abilities.filter(ability => e.isMonster(cards[ability.source_card_id])
    && cards[ability.source_card_id].card_type === '地下城牌' && grantsDisease(ability.body)).map(ability => ability.source_card_id));
  assert.ok(givers.has('TS-0589')); assert.ok(givers.has('TS-0590')); assert.ok(givers.has('TS-0676'));
  for (const id of givers) assert.ok(e.tags(cards[id]).includes('给予疾病'), `${id} ${cards[id].name}`);
  for (const [hero, amount] of [['TS-0375', 3], ['TS-0376', 4]]) {
    const f = fixture([hero]);
    for (const target of ['TS-0589', 'TS-0590']) assert.equal(e.combatValues(calculation(f), 1,
      {...cards[target], effect_text: 'English wording deliberately has no Chinese disease phrase.'}).magic_attack, amount);
    assert.equal(e.combatValues(calculation(f), 1, cards['TS-0497']).magic_attack, 0);
  }
});

test('Q08 magehunter uses participating dynamic magic, while an unselected mage remains in hand', () => {
  const f = fixture(['TS-0336', 'TS-0278', 'TS-0002', 'TS-0002', 'TS-0401']);
  const [hero, silver, , , mage] = f.hand;
  f.state.battle_context.battle_team = {hero_instance_ids: [hero], support_instance_ids: [silver]};
  let trace = e.combatValues(calculation(f), 1);
  assert.equal(trace.magic_attack, 1); assert.equal(contribution(trace, hero), 2);
  f.state.battle_context.battle_team.support_instance_ids = [];
  trace = e.combatValues(calculation(f), 1);
  assert.equal(trace.magic_attack, 0); assert.equal(contribution(trace, hero), 3);
  assert.ok(f.state.zones['player:alice:hand'].includes(mage));
});

test('Q06 repeated spells multiply intrinsic and dynamic output once, not executed modifiers', () => {
  const f = fixture(['TS-0278', 'TS-0002', 'TS-0002']);
  f.state.battle_context.spell_cast_counts = {[f.hand[0]]: 2};
  f.state.battle_context.card_modifiers = {[f.hand[0]]: {magic_attack: 3}};
  const trace = e.combatValues(calculation(f), 1);
  assert.equal(trace.magic_attack, 5); // dynamic one per cast, then one already-executed +3.
  assert.deepEqual(browser.combatValues(calculation(f), 1), trace);
});

test('R03 battle damage reductions compose and round after multiplication before darkness', () => {
  const f = fixture(['TS-0316', 'TS-0374']); // 4 physical + 4 magic.
  f.state.battle_context.modifiers = {attack: 3}; // total 11.
  f.state.battle_context.damage_divisor = 4;
  const trace = e.combatValues(calculation(f), 1);
  assert.equal(trace.attack + trace.magic_attack, 2);
  assert.equal(trace.effective_attack, 0); // rank-one darkness is subtracted after the quartering.
});
