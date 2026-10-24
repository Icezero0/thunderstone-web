import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture} from './support/catalog.mjs';

const villageZone = 'village_supply:TS-0081';
const ids = (f, zone) => (f.state.zones[zone] ?? []).map(id => f.state.instances[id].card_id);
const upgrades = f => server.legalCommands(f.state, f.catalog, f.rules).find(item => item.type === 'UpgradeHero')?.options ?? [];
function apply(f, value) {
  const command = {player_id: f.state.active_player_id, expected_version: f.state.game_version, ...value};
  const before = structuredClone(f.state), result = server.applyCommand(f.state, command, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(f.state, command, f.catalog, f.rules), result);
  assert.deepEqual(f.state, before); f.state = result.state; return result;
}
function stage(f, name) {f.state.subphase = f.state.timing_window = name; f.state.chosen_action = 'village'; f.state.battle_context = null;}
function villageSupply(f, low = 5, high = 3) {
  f.state.zones[villageZone] = [];
  for (let n = 0; n < low; n++) f.add('TS-0301', villageZone);
  for (let n = 0; n < high; n++) f.add('TS-0300', villageZone);
}
function ordinarySupplies(f) {
  for (const cardId of ['TS-0354', 'TS-0355', 'TS-0356', 'TS-0314']) {
    const group = f.catalog.setup_index.groups.find(group => group.members.includes(cardId));
    f.add(cardId, `hero_supply:${group.randomizer_id}`);
  }
  f.add('TS-0213', 'village_supply:TS-0213'); f.add('TS-0261', 'village_supply:TS-0261');
}

test('only the current village-thief top is purchasable: five cutpurses followed by three robbers', () => {
  const f = fixture(); stage(f, 'VILLAGE_BUY'); villageSupply(f);
  f.state.players.alice.temporary_gold = 100; f.state.players.alice.purchases_remaining = 8;
  assert.throws(() => server.applyCommand(f.state, {type: 'BuyCard', player_id: 'alice', expected_version: 1,
    card_id: 'TS-0300'}, f.catalog, f.rules), /not purchasable/);
  for (const expected of [...Array(5).fill('TS-0301'), ...Array(3).fill('TS-0300')]) {
    const options = server.legalCommands(f.state, f.catalog, f.rules).find(item => item.type === 'BuyCard').options;
    assert.deepEqual(options.filter(option => ['TS-0301', 'TS-0300'].includes(option.card_id)).map(option => option.card_id), [expected]);
    apply(f, {type: 'BuyCard', card_id: expected});
    assert.equal(f.state.instances[f.state.zones['player:alice:discard'].at(-1)].card_id, expected);
  }
  assert.equal(f.state.zones[villageZone].length, 0);
});

test('militia and veteran militia can pay their own XP cost for any supplied level-1 hero, including the village cutpurse', () => {
  for (const [sourceCard, cost] of [['TS-0001', 3], ['TS-0261', 2]]) for (const targetCard of ['TS-0354', 'TS-0314', 'TS-0301']) {
    const f = fixture([sourceCard]); stage(f, 'VILLAGE_UPGRADE'); villageSupply(f); ordinarySupplies(f);
    f.state.players.alice.xp = cost - 1; assert.deepEqual(upgrades(f), []);
    f.state.players.alice.xp = cost;
    const options = upgrades(f);
    assert.deepEqual(options.map(option => option.target_card_id).sort(), ['TS-0301', 'TS-0314', 'TS-0354']);
    assert.ok(options.every(option => option.xp_cost === cost && option.source_instance_id === f.hand[0]));
    const result = apply(f, {type: 'UpgradeHero', source_instance_id: f.hand[0], target_card_id: targetCard});
    assert.equal(f.state.players.alice.xp, 0); assert.ok(f.state.zones.destroyed.includes(f.hand[0]));
    const gained = f.state.zones['player:alice:discard'].at(-1);
    assert.equal(f.state.instances[gained].card_id, targetCard);
    assert.equal(f.state.instances[gained].flags.upgraded_on_turn, 1);
    assert.equal(result.events.find(event => event.kind === 'hero_upgraded').xp_cost, cost);
  }
});

test('upgrades exclude unsupplied heroes and sold-out cutpurses, even when their catalog group exists', () => {
  for (const source of ['TS-0001', 'TS-0261']) {
    const f = fixture([source]); stage(f, 'VILLAGE_UPGRADE'); f.state.players.alice.xp = 10;
    villageSupply(f, 0, 3);
    f.add('TS-0261', 'village_supply:TS-0261');
    assert.deepEqual(upgrades(f), []);
    assert.throws(() => server.applyCommand(f.state, {type: 'UpgradeHero', player_id: 'alice', expected_version: 1,
      source_instance_id: f.hand[0], target_card_id: 'TS-0301'}, f.catalog, f.rules), /invalid hero upgrade/);
  }
});

test('the cutpurse upgrades only to its own robber, paying four XP and taking the lower card without consuming the top', () => {
  const f = fixture(['TS-0301']); stage(f, 'VILLAGE_UPGRADE'); villageSupply(f); ordinarySupplies(f);
  f.state.players.alice.xp = 3; assert.deepEqual(upgrades(f), []);
  f.state.players.alice.xp = 4;
  assert.deepEqual(upgrades(f), [{source_instance_id: f.hand[0], target_card_id: 'TS-0300', xp_cost: 4}]);
  apply(f, {type: 'UpgradeHero', source_instance_id: f.hand[0], target_card_id: 'TS-0300'});
  assert.equal(f.state.players.alice.xp, 0);
  assert.deepEqual(ids(f, villageZone), [...Array(5).fill('TS-0301'), ...Array(2).fill('TS-0300')]);
  assert.deepEqual(ids(f, 'player:alice:discard'), ['TS-0300']);
  const exhausted = fixture(['TS-0301']); stage(exhausted, 'VILLAGE_UPGRADE'); exhausted.state.players.alice.xp = 10;
  villageSupply(exhausted, 5, 0); assert.deepEqual(upgrades(exhausted), []);
});

test('ordinary heroes still advance exactly one level within their own indexed series', () => {
  const f = fixture(['TS-0354']); stage(f, 'VILLAGE_UPGRADE'); villageSupply(f); ordinarySupplies(f);
  f.state.players.alice.xp = 10;
  assert.deepEqual(upgrades(f).map(option => option.target_card_id), ['TS-0355']);
});

test('DSL upgrades use the same militia targets and XP, return the hero to hand and prevent upgrading it twice in one turn', () => {
  for (const [sourceCard, cost] of [['TS-0001', 3], ['TS-0261', 2]]) {
    const f = fixture([sourceCard, 'TS-0437']); villageSupply(f); f.state.players.alice.xp = cost + 4;
    apply(f, {type: 'ActivateAbility', source_instance_id: f.hand[1], ability_id: 'TS-0437-A02'});
    assert.equal(f.state.pending_choice.kind, 'effect_upgrade');
    assert.ok(f.state.pending_choice.options.some(option => option.source_instance_id === f.hand[0] && option.target_card_id === 'TS-0301'));
    apply(f, {type: 'ResolveEffectUpgrade', source_instance_id: f.hand[0], target_card_id: 'TS-0301'});
    assert.equal(f.state.players.alice.xp, 4);
    const gained = f.state.zones['player:alice:hand'].find(id => f.state.instances[id].card_id === 'TS-0301');
    assert.ok(gained); stage(f, 'VILLAGE_UPGRADE');
    assert.equal(upgrades(f).some(option => option.source_instance_id === gained), false);
    f.state.turn_number++;
    assert.ok(upgrades(f).some(option => option.source_instance_id === gained && option.target_card_id === 'TS-0300'));
  }
});

test('return-to-village destruction restores the cutpurse above remaining robbers in the same pile, including an empty supply', () => {
  for (const remaining of [0, 3]) {
    const f = fixture(['TS-0301']); stage(f, 'REST'); f.state.chosen_action = 'rest'; f.state.active_settings = ['TS-0196'];
    villageSupply(f, 0, remaining);
    apply(f, {type: 'RestDestroy', instance_id: f.hand[0]});
    assert.deepEqual(ids(f, villageZone), ['TS-0301', ...Array(remaining).fill('TS-0300')]);
    assert.equal(f.state.instances[f.hand[0]].owner_player_id, null);
    assert.deepEqual(Object.keys(f.state.zones).filter(zone => zone.startsWith('village_supply:')), [villageZone]);
  }
});

test('Stormhold replenishment also creates one village-thief pile with level order and the village multiplier', () => {
  for (const multiplier of [1, 2]) {
    const f = fixture(); stage(f, 'VILLAGE_UPGRADE'); f.state.active_settings = ['TS-0197'];
    const group = f.catalog.setup_index.groups.find(group => group.randomizer_id === 'TS-0081');
    f.catalog = {...f.catalog, setup_index: {...f.catalog.setup_index, groups: [group]}};
    f.state.selected_groups = {village: ['exhausted'], hero: [], monster: []};
    f.state.frozen_config = {instance_multipliers: {village: multiplier, hero: 1, monster: 1}};
    f.state.zones['village_supply:exhausted'] = [];
    const result = apply(f, {type: 'FinishUpgrading'});
    assert.deepEqual(ids(f, villageZone), [...Array(5 * multiplier).fill('TS-0301'), ...Array(3 * multiplier).fill('TS-0300')]);
    assert.equal(result.events.find(event => event.kind === 'empty_supply_replenished').zone, villageZone);
    assert.deepEqual(Object.keys(f.state.zones).filter(zone => zone.startsWith('village_supply:')), [villageZone]);
  }
});
