import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture} from './support/catalog.mjs';

function village(hand = ['TS-0001', 'TS-0002', 'TS-0003', 'TS-0004']) {
  const f = fixture(hand); Object.assign(f.state, {chosen_action: 'village', battle_context: null,
    subphase: 'VILLAGE_ABILITIES', timing_window: 'VILLAGE_ABILITIES'}); return f;
}
function options(f, player = 'alice') {
  const before = structuredClone(f.state), result = server.turnOptions(f.state, player, f.catalog, f.rules);
  assert.deepEqual(browser.turnOptions(f.state, player, f.catalog, f.rules), result);
  assert.deepEqual(f.state, before, 'preview cannot consume an adjustment, mutate RNG or advance a phase');
  assert.deepEqual(result.legal_commands, server.legalCommands(f.state, f.catalog, f.rules)); return result;
}
function produce(f) {
  return server.applyCommand(f.state, {type: 'FinishAbilities', player_id: 'alice', expected_version: f.state.game_version}, f.catalog, f.rules);
}

test('turn start previews immediate village income before an action is chosen, identically in Node and browser', () => {
  const f = village(); f.state.subphase = f.state.timing_window = 'TURN_START'; f.state.chosen_action = null;
  assert.equal(options(f).gold_income_preview, 5); assert.equal(options(f, 'bob').gold_income_preview, null);
  assert.equal(f.state.players.alice.temporary_gold, 0); assert.equal(f.state.subphase, 'TURN_START');
});

test('gold already earned by abilities is not counted again; pending adjustments are included exactly once', () => {
  const f = village(); Object.assign(f.state.players.alice, {temporary_gold: 7, turn_gold_adjustment: -2});
  assert.equal(options(f).gold_income_preview, 3); assert.equal(options(f).gold_income_preview, 3);
  const result = produce(f);
  assert.equal(result.state.players.alice.temporary_gold, 10); assert.equal(result.state.players.alice.turn_gold_adjustment, undefined);
  assert.equal(server.turnOptions(result.state, 'alice', f.catalog, f.rules).gold_income_preview, null);
});

test('hand changes immediately alter the production forecast without changing current gold', () => {
  const f = village(['TS-0003']); assert.equal(options(f).gold_income_preview, 2);
  const id = f.state.zones['player:alice:hand'].pop(); f.state.zones['player:alice:discard'].push(id);
  assert.equal(options(f).gold_income_preview, 0);
  f.add('TS-0002'); assert.equal(options(f).gold_income_preview, 1);
  assert.equal(produce(f).state.players.alice.temporary_gold, 1);
});

test('the active environment can suppress monster gold in both preview and actual production', () => {
  const f = village(['TS-0476', 'TS-0003']); assert.equal(options(f).gold_income_preview, 3);
  f.state.active_settings = ['TS-0189'];
  assert.equal(options(f).gold_income_preview, 2); assert.equal(produce(f).state.players.alice.temporary_gold, 2);
});

test('negative income is bounded by the same zero-gold floor as actual production', () => {
  const f = village([]); Object.assign(f.state.players.alice, {temporary_gold: 4, turn_gold_adjustment: -10});
  assert.equal(options(f).gold_income_preview, -4); assert.equal(produce(f).state.players.alice.temporary_gold, 0);
});

test('the owner keeps a forecast while another player responds without executing that response', () => {
  const f = village(); f.state.pending_choice = {kind: 'effect_select', player_id: 'bob', candidate_instance_ids: [], min_count: 0, max_count: 0};
  f.state.resolution_frames = [{}];
  assert.equal(options(f).gold_income_preview, 5); assert.equal(options(f, 'bob').gold_income_preview, null);
  assert.equal(f.state.pending_choice.player_id, 'bob');
});

for (const phase of ['VILLAGE_BUY', 'VILLAGE_UPGRADE', 'ACTION_END', 'REST', 'DUNGEON_PREPARE'])
  test(`production forecasts are absent in ${phase}`, () => {
    const f = village(); f.state.subphase = f.state.timing_window = phase;
    if (phase === 'DUNGEON_PREPARE') {f.state.chosen_action = 'dungeon'; f.state.battle_context = {equipped_weapon_by_hero: {}};}
    assert.equal(options(f).gold_income_preview, null);
  });
