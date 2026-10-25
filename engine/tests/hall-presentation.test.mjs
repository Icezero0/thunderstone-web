import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {Transition} from '../dist/turn/transaction.js';
import {queueSteps} from '../dist/turn/workflow.js';
import {settleOnStone, swapHall, relocate} from '../dist/turn/hall.js';
import {fixture} from './support/catalog.mjs';

test('effect movements publish their original public coordinates for sequential presentation', () => {
  const f = fixture([], ['TS-0476', 'TS-0477', 'TS-0478']);
  const tx = new Transition(f.state, f.catalog, f.rules);
  swapHall(tx, f.hall[0], f.hall[1]);
  relocate(tx, f.hall[0], 'rank3');
  tx.destroyCard(f.hall[1]);
  const swap = tx.events.find(event => event.kind === 'hall_cards_swapped');
  assert.deepEqual([swap.first_rank, swap.second_rank], [1, 2]);
  const moved = tx.events.find(event => event.kind === 'hall_card_repositioned');
  assert.deepEqual([moved.from_rank, moved.rank], [2, 3]);
  const destroyed = tx.events.find(event => event.kind === 'card_destroyed');
  assert.equal(destroyed.hall_zone, 'hall:main'); assert.equal(destroyed.rank, 1);
});

test('banishing ritual stone departure identifies the correct dungeon without exposing its order', () => {
  for (const acquired of [false, true]) {
    const f = fixture([], ['TS-0707', 'TS-0476']); f.state.active_settings = ['TS-0199'];
    const tx = new Transition(f.state, f.catalog, f.rules);
    settleOnStone(tx, f.hall[0], acquired);
    const event = tx.events.find(event => event.kind === (acquired ? 'thunderstone_acquired' : 'thunderstone_returned_to_deck'));
    assert.equal(event.hall_zone, 'hall:main'); assert.equal(event.rank, 1);
    assert.equal(tx.location(f.hall[0]), acquired ? 'player:alice:discard' : 'dungeon:main');
    assert.equal('order' in event, false);
  }
});

function battle(f, won) {
  // Isolate public departure/capacity metadata from individual monster abilities.
  f.rules = {...f.rules, abilities: [], mechanics: []};
  f.state.battle_context.modifiers = {attack: won ? 999 : 0};
  const prep = server.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  const submitted = server.applyCommand(f.state, server.buildSubmitBattleTeamCommand(prep.context, prep.draft), f.catalog, f.rules);
  const command = {type: 'DeclareBattleTarget', player_id: 'alice', expected_version: submitted.state.game_version,
    target_instance_id: f.hall[0]};
  const result = server.applyCommand(submitted.state, command, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(submitted.state, command, f.catalog, f.rules), result);
  return result;
}

for (const won of [false, true]) test(`departing an extra-rank monster publishes the reduced capacity before refill: won ${won}`, () => {
  const f = fixture([], ['TS-0571', 'TS-0476', 'TS-0476', 'TS-0476']);
  f.add('TS-0477', 'dungeon:main');
  const result = battle(f, won);
  const event = result.events.find(event => event.kind === (won ? 'monster_defeated' : 'monster_returned_to_deck'));
  assert.equal(event.hall_zone, 'hall:main'); assert.equal(event.rank, 1); assert.equal(event.hall_rank_count, 3);
  assert.equal(result.events.some(event => event.kind === 'hall_card_entered'), false);
  assert.equal(result.state.zones['hall:main'].length, 3);
  assert.equal(result.state.zones['dungeon:main'].length, won ? 1 : 2);
  if (!won) assert.equal(result.state.zones['dungeon:main'].at(-1), f.hall[0]);
});

test('a remaining extra-rank monster or a four-rank environment preserves its capacity', () => {
  for (const environment of [false, true]) {
    const f = fixture([], ['TS-0571', environment ? 'TS-0476' : 'TS-0572', 'TS-0476', 'TS-0476', 'TS-0476']);
    if (environment) f.state.active_settings = ['TS-0188'];
    const result = battle(f, true);
    assert.equal(result.events.find(event => event.kind === 'monster_defeated').hall_rank_count, 4);
    assert.equal(result.state.zones['hall:main'].length, 4);
  }
});

test('revealing an extra-rank monster opens its slot before drawing the next card', () => {
  const f = fixture([], ['TS-0476', 'TS-0476']);
  f.add('TS-0571', 'dungeon:main'); f.add('TS-0477', 'dungeon:main');
  const tx = new Transition(f.state, f.catalog, f.rules);
  queueSteps(tx, [{op: 'refill_hall', hall_zone: 'hall:main'}]);
  assert.deepEqual(tx.events.filter(event => event.kind === 'hall_card_entered').map(event => [event.rank, event.hall_rank_count]), [[3, 4], [4, 4]]);
});

test('public slot counts retain empty extra ranks and independent dungeon capacities for every viewer', () => {
  const f = fixture([], ['TS-0571']); f.add('TS-0476', 'hall:b'); f.state.zones['dungeon:b'] = [];
  const original = structuredClone(f.state);
  for (const viewer of ['alice', 'bob']) {
    const result = server.turnOptions(f.state, viewer, f.catalog, f.rules);
    assert.deepEqual(result.hall_rank_counts, {'hall:main': 4, 'hall:b': 3});
    assert.deepEqual(browser.turnOptions(f.state, viewer, f.catalog, f.rules), result);
  }
  assert.deepEqual(f.state, original);
});
