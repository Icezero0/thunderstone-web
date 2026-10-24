import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture} from './support/catalog.mjs';

function village(hand = [], phase = 'VILLAGE_BUY') {
  const f = fixture(hand); Object.assign(f.state, {subphase: phase, timing_window: phase, chosen_action: 'village', battle_context: null});
  f.state.players.alice.temporary_gold = 100; return f;
}
function apply(f, command) {
  const input = {player_id: 'alice', expected_version: f.state.game_version, ...command}, before = structuredClone(f.state);
  const result = server.applyCommand(f.state, input, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(f.state, input, f.catalog, f.rules), result);
  assert.deepEqual(f.state, before); f.state = result.state; return result;
}
function listen(f, event, op) {
  f.state.registered_triggers.push({event, ability_id: 'TS-0231-A01', source_instance_id: f.hand[0], once: true,
    conditions: [], bindings: {}, body: {op: 'choose_value', kind: 'number', min: 0, max: 1, bind: 'bonus',
      then: {op, amount: {value: 'bonus'}}}});
}

test('a normal purchase automatically skips exhausted purchasing and unavailable upgrading, but waits for manual turn end', () => {
  const f = village(); const result = apply(f, {type: 'BuyCard', card_id: 'TS-0002'});
  assert.equal(f.state.subphase, 'ACTION_END'); assert.equal(f.state.turn_number, 1); assert.equal(f.state.active_player_id, 'alice');
  assert.deepEqual(result.legal_commands, [{type: 'FinishTurn'}]);
  assert.ok(result.events.some(event => event.kind === 'village_upgrade_started'));
  assert.equal(result.events.some(event => ['turn_hand_discarded', 'cards_drawn', 'turn_passed'].includes(event.kind)), false);
});

test('an extra purchase retains the buying phase until the last opportunity is used', () => {
  const f = village(); f.state.players.alice.purchases_remaining = 2;
  const first = apply(f, {type: 'BuyCard', card_id: 'TS-0002'});
  assert.equal(f.state.subphase, 'VILLAGE_BUY'); assert.ok(first.legal_commands.some(command => command.type === 'BuyCard'));
  apply(f, {type: 'BuyCard', card_id: 'TS-0003'}); assert.equal(f.state.subphase, 'ACTION_END');
});

test('a restricted extra militia purchase is retained and consumed without offering unrelated cards', () => {
  const f = village(); f.state.players.alice.extra_basic_purchases = 1;
  const result = apply(f, {type: 'BuyCard', card_id: 'TS-0002'});
  assert.equal(f.state.subphase, 'VILLAGE_BUY');
  assert.deepEqual(result.legal_commands.find(command => command.type === 'BuyCard').card_ids, ['TS-0001']);
  apply(f, {type: 'BuyCard', card_id: 'TS-0001'}); assert.equal(f.state.subphase, 'ACTION_END');
});

test('the hall restriction to one purchase overrides spare purchase counters before automatic advancement', () => {
  const f = village(); f.add('TS-0528', 'hall:main'); f.state.players.alice.purchases_remaining = 3;
  apply(f, {type: 'BuyCard', card_id: 'TS-0002'});
  assert.equal(f.state.players.alice.purchases_remaining, 2); assert.equal(f.state.subphase, 'ACTION_END');
});

test('a remaining purchase with no affordable target does not leave an empty buying phase', () => {
  const f = village(); f.state.players.alice.purchases_remaining = 2; f.state.players.alice.temporary_gold = 0;
  // A valid free purchase exhausts the only affordable top.
  f.catalog = {...f.catalog, cards: {...f.cards, 'TS-0002': {...f.cards['TS-0002'], wiki_购买价格: '0'}}};
  f.state.supply_rules.basic_card_ids = []; f.add('TS-0002', 'village_supply:free');
  apply(f, {type: 'BuyCard', card_id: 'TS-0002'}); assert.equal(f.state.subphase, 'ACTION_END');
});

for (const bonus of [0, 1]) test(`purchase-trigger choices settle before deciding whether to keep buying: bonus ${bonus}`, () => {
  const f = village(['TS-0231']); listen(f, 'CARD_PURCHASED', 'grant_buy');
  apply(f, {type: 'BuyCard', card_id: 'TS-0002'});
  assert.equal(f.state.subphase, 'VILLAGE_BUY'); assert.equal(f.state.pending_choice.kind, 'effect_value');
  assert.equal(f.state.players.alice.purchases_remaining, 0);
  const result = apply(f, {type: 'ResolveValueChoice', value: bonus});
  assert.equal(f.state.subphase, bonus ? 'VILLAGE_BUY' : 'ACTION_END');
  assert.equal(result.legal_commands.some(command => command.type === 'BuyCard'), !!bonus);
});

test('XP gained by the purchased card is available when deciding whether an upgrade stage is needed', () => {
  const f = village(['TS-0001']); f.state.players.alice.xp = 1;
  f.add('TS-0228', 'village_supply:purchased'); f.add('TS-0354', 'hero_supply:target');
  const result = apply(f, {type: 'BuyCard', card_id: 'TS-0228'});
  assert.equal(f.state.players.alice.xp, 3); assert.equal(f.state.subphase, 'VILLAGE_UPGRADE');
  assert.ok(result.legal_commands.find(command => command.type === 'UpgradeHero').options.some(option => option.target_card_id === 'TS-0354'));
});

for (const [xp, stocked, expected] of [[2, true, 'ACTION_END'], [3, false, 'ACTION_END'], [3, true, 'VILLAGE_UPGRADE']])
  test(`entering upgrading checks XP and stocked targets: XP ${xp}, stock ${stocked}`, () => {
    const f = village(['TS-0001']); f.state.players.alice.xp = xp;
    if (stocked) f.add('TS-0354', 'hero_supply:target');
    apply(f, {type: 'FinishBuying'}); assert.equal(f.state.subphase, expected);
  });

test('each completed upgrade recalculates eligibility and stops at manual turn end only after no further hero can upgrade', () => {
  const f = village(['TS-0001', 'TS-0001'], 'VILLAGE_UPGRADE'); f.state.players.alice.xp = 6;
  f.add('TS-0354', 'hero_supply:target'); f.add('TS-0354', 'hero_supply:target');
  apply(f, {type: 'UpgradeHero', source_instance_id: f.hand[0], target_card_id: 'TS-0354'});
  assert.equal(f.state.subphase, 'VILLAGE_UPGRADE'); assert.equal(f.state.players.alice.xp, 3);
  const result = apply(f, {type: 'UpgradeHero', source_instance_id: f.hand[1], target_card_id: 'TS-0354'});
  assert.equal(f.state.subphase, 'ACTION_END'); assert.deepEqual(result.legal_commands, [{type: 'FinishTurn'}]);
  assert.equal(f.state.turn_number, 1);
});

for (const bonus of [0, 3]) test(`upgrade triggers settle before recalculating further upgrades: XP bonus ${bonus}`, () => {
  const f = village(['TS-0231', 'TS-0001', 'TS-0001'], 'VILLAGE_UPGRADE'); f.state.players.alice.xp = 3;
  f.add('TS-0354', 'hero_supply:target'); f.add('TS-0354', 'hero_supply:target'); listen(f, 'HERO_UPGRADED', 'gain_xp');
  f.state.registered_triggers[0].body.max = 3;
  apply(f, {type: 'UpgradeHero', source_instance_id: f.hand[1], target_card_id: 'TS-0354'});
  assert.equal(f.state.subphase, 'VILLAGE_UPGRADE'); assert.equal(f.state.pending_choice.kind, 'effect_value');
  apply(f, {type: 'ResolveValueChoice', value: bonus}); assert.equal(f.state.players.alice.xp, bonus);
  assert.equal(f.state.subphase, bonus ? 'VILLAGE_UPGRADE' : 'ACTION_END');
});
