import assert from 'node:assert/strict';
import test from 'node:test';
import {applyCommand, legalCommands} from '../dist/index.js';
import {Transition} from '../dist/turn/transaction.js';
import {fixture} from './support/catalog.mjs';
import {queueSteps} from '../dist/turn/workflow.js';

const resolve = (f, state, player, recipient) => applyCommand(state, {type: 'ResolveDiseaseReplacement', player_id: player,
  expected_version: state.game_version, source_instance_id: null, recipient_id: recipient}, f.catalog, f.rules);

for (const zone of ['battle_target', 'hall']) test(`disease origin follows the actual ${zone} source through queued DSL gains`, () => {
  const f = fixture([], ['TS-0476', 'TS-0477']), source = f.hall[zone === 'hall' ? 1 : 0];
  f.state.battle_context.target_instance_id = f.hall[0]; f.state.battle_context.target_rank = 1;
  const rules = {...f.rules, abilities: [{id: 'origin-test', source_card_id: f.state.instances[source].card_id,
    kind: 'triggered', source_zone: zone, event: 'BATTLE_BEFORE_OUTCOME', usage: 'once_per_event',
    actions: [], conditions: [], body: {op: 'gain_disease', count: 2}}]};
  const tx = new Transition(f.state, f.catalog, rules);
  queueSteps(tx, [{op: 'event', event: 'BATTLE_BEFORE_OUTCOME'}]);
  const starts = tx.events.filter(event => event.kind === 'disease_gain_started'); assert.equal(starts.length, 2);
  for (const event of starts) {
    assert.equal(event.source_card_id, f.state.instances[source].card_id);
    assert.equal(event.source_hall_zone, 'hall:main'); assert.equal(event.source_rank, zone === 'hall' ? 2 : 1);
    assert.equal(event.source_instance_id, undefined, 'public disease origin must not expose a tracking ID');
  }
});

test('rank-zero disease origins are public; hand and hidden-deck sources have no hall origin', () => {
  const f = fixture(['TS-0476'], ['TS-0679']);
  const guardian = f.hall[0];
  f.state.zones['hall:main:rank0'] = f.state.zones['hall:main'].splice(0);
  const tx = new Transition(f.state, f.catalog, f.rules);
  tx.takeDisease('discard', 'alice', guardian);
  let start = tx.events.find(event => event.kind === 'disease_gain_started');
  assert.equal(start.source_rank, 0); assert.equal(start.source_hall_zone, 'hall:main:rank0');
  tx.takeDisease('discard', 'alice', f.hand[0]);
  start = tx.events.filter(event => event.kind === 'disease_gain_started').at(-1);
  assert.equal(start.source_hall_zone, undefined); assert.equal(start.source_card_id, undefined);
});

test('redirection asks even when only one recipient is available and can be skipped', () => {
  const f = fixture(['TS-0423']), tx = new Transition(f.state, f.catalog, f.rules), disease = tx.takeDisease();
  assert.equal(tx.state.pending_choice.stage, 'recipient'); assert.deepEqual(tx.state.pending_choice.options, ['bob']);
  assert.equal(legalCommands(tx.state, f.catalog, f.rules)[0].may_decline, true);
  assert.ok(tx.state.zones['pending:disease'].includes(disease));
  const result = resolve(f, tx.state, 'alice', null);
  assert.equal(result.state.pending_choice, null); assert.ok(result.state.zones['player:alice:discard'].includes(disease));
  const started = tx.events.find(event => event.kind === 'disease_gain_started'), completed = result.events.find(event => event.kind === 'disease_gain_completed');
  assert.equal(started.card_id, 'TS-0714'); assert.equal(completed.gain_id, started.gain_id);
  assert.equal(completed.player_id, 'alice'); assert.equal(result.events.some(event => event.kind === 'disease_redirected'), false);
});

test('declining redirection preserves an explicitly requested hand destination', () => {
  const f = fixture(['TS-0423']), tx = new Transition(f.state, f.catalog, f.rules), disease = tx.takeDisease('hand');
  const result = resolve(f, tx.state, 'alice', null);
  assert.ok(result.state.zones['player:alice:hand'].includes(disease));
});

test('plague breaker still destroys automatically and its public disease card survives instance deletion', () => {
  const f = fixture(['TS-0239']), tx = new Transition(f.state, f.catalog, f.rules), disease = tx.takeDisease();
  assert.equal(tx.state.pending_choice, null); assert.equal(tx.state.instances[disease], undefined);
  const started = tx.events.find(event => event.kind === 'disease_gain_started'), destroyed = tx.events.find(event => event.kind === 'disease_gain_destroyed');
  assert.equal(destroyed.card_id, 'TS-0714'); assert.equal(destroyed.gain_id, started.gain_id);
  assert.equal(tx.events.some(event => event.kind === 'disease_gain_completed'), false);
});

test('several plague breakers still remove one disease automatically without an ordering choice', () => {
  const f = fixture(['TS-0239', 'TS-0239']), tx = new Transition(f.state, f.catalog, f.rules), disease = tx.takeDisease();
  assert.equal(tx.state.pending_choice, null); assert.equal(tx.state.instances[disease], undefined);
  assert.equal(tx.events.filter(event => event.kind === 'disease_gain_destroyed').length, 1);
});

test('skipping an optional replacement never bypasses plague breaker', () => {
  const f = fixture(['TS-0239', 'TS-0423']), tx = new Transition(f.state, f.catalog, f.rules), disease = tx.takeDisease();
  assert.equal(tx.state.pending_choice.stage, 'source');
  const result = resolve(f, tx.state, 'alice', null);
  assert.equal(result.state.instances[disease], undefined); assert.equal(result.state.pending_choice, null);
});

test('redirected disease keeps one public gain identity and each source replaces at most once', () => {
  const f = fixture(['TS-0423']); f.add('TS-0423', 'player:bob:hand');
  const tx = new Transition(f.state, f.catalog, f.rules), disease = tx.takeDisease();
  const first = resolve(f, tx.state, 'alice', 'bob');
  assert.equal(first.state.pending_choice.player_id, 'bob'); assert.equal(first.state.pending_choice.stage, 'recipient');
  const final = resolve(f, JSON.parse(JSON.stringify(first.state)), 'bob', 'alice');
  assert.equal(final.state.pending_choice, null); assert.ok(final.state.zones['player:alice:discard'].includes(disease));
  const events = [...tx.events, ...first.events, ...final.events], started = events.filter(event => event.kind === 'disease_gain_started');
  assert.equal(started.length, 1);
  assert.equal(new Set(events.filter(event => event.kind === 'disease_redirected').map(event => event.gain_id)).size, 1);
  assert.equal(events.filter(event => event.kind === 'disease_replacement_applied').length, 2);
});
