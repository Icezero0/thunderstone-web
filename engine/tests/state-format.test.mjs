import test from 'node:test';
import assert from 'node:assert/strict';
import {STATE_FORMAT_VERSION, applyCommand, turnOptions, battlePreparation} from '../dist/index.js';
import {fixture} from './support/catalog.mjs';

test('unmarked saves remain readable and acquire the stable format only on a successful command', () => {
  const f = fixture(['TS-0001']);
  delete f.state.state_format_version;
  f.state.subphase = f.state.timing_window = 'TURN_START'; f.state.battle_context = null;
  const before = structuredClone(f.state);
  assert.equal(turnOptions(f.state, 'alice', f.catalog, f.rules).legal_commands[0].type, 'ChooseAction');
  assert.deepEqual(f.state, before);
  const result = applyCommand(f.state, {type: 'ChooseAction', action: 'rest', player_id: 'alice', expected_version: f.state.game_version}, f.catalog, f.rules);
  assert.equal(result.state.state_format_version, STATE_FORMAT_VERSION);
  assert.equal(result.state.subphase, 'REST');
  assert.deepEqual(result.state.zones, before.zones);
  assert.deepEqual(result.state.rng_state, before.rng_state);
  assert.deepEqual(f.state, before);
});

test('unknown saved state formats cannot silently run as a legacy save', () => {
  for (const format of [2, 0, null, '1']) {
    const f = fixture(['TS-0001']); f.state.state_format_version = format;
    const before = structuredClone(f.state);
    assert.throws(() => turnOptions(f.state, 'alice', f.catalog, f.rules), /saved game state format/);
    assert.throws(() => battlePreparation(f.state, 'alice', f.catalog, f.rules), /saved game state format/);
    assert.throws(() => applyCommand(f.state, {type: 'FinishAbilities', player_id: 'alice'}, f.catalog, f.rules), /saved game state format/);
    assert.deepEqual(f.state, before);
  }
});
