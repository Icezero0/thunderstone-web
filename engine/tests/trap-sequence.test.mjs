import assert from 'node:assert/strict';
import test from 'node:test';
import {applyCommand, legalCommands} from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {Transition} from '../dist/turn/transaction.js';
import {queueSteps} from '../dist/turn/workflow.js';
import {fixture} from './support/catalog.mjs';

function activate(state, f, instance = state.pending_choice.instance_id) {
  const command = {type: 'ResolveTrap', instance_id: instance, player_id: 'alice', expected_version: state.game_version};
  const result = applyCommand(state, command, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(state, command, f.catalog, f.rules), result);
  return result;
}

test('two Dragon Tongues resolve each printed line and dispose each trap before the next is revealed', () => {
  const f = fixture([], ['TS-0476', 'TS-0476']);
  const defeated = f.add('TS-0476', 'player:alice:discard');
  const first = f.add('TS-0692', 'dungeon:main'), second = f.add('TS-0692', 'dungeon:main'); f.add('TS-0477', 'dungeon:main');
  const trophies = [f.add('TS-0476', 'player:bob:draw'), f.add('TS-0476', 'player:bob:draw')];
  const tx = new Transition(f.state, f.catalog, f.rules);
  queueSteps(tx, [{op: 'refill_hall', hall_zone: 'hall:main', defeated_instance_id: defeated}]);
  assert.equal(tx.state.pending_choice.kind, 'trap_activation');
  assert.deepEqual(tx.state.zones['hall:main'], [...f.hall, first]);
  assert.deepEqual(tx.state.zones['dungeon:main'].slice(0, 1), [second]);
  assert.equal(tx.state.zones.destroyed.length, 0, 'nothing runs before the click');
  const next = activate(tx.state, f);
  assert.equal(next.state.pending_choice.instance_id, second);
  assert.ok(next.state.zones['hall:main'].includes(second));
  const final = activate(JSON.parse(JSON.stringify(next.state)), f);
  assert.equal(final.state.pending_choice, null);
  const events = [...tx.events, ...next.events, ...final.events];
  assert.equal(events.some(event => event.kind === 'effect_order_requested'), false);
  for (const id of [defeated, first, second, ...trophies]) assert.ok(final.state.zones.destroyed.includes(id), id);
  assert.equal(events.filter(event => event.kind === 'card_destroyed' && event.instance_id === defeated).length, 1);
  const firstDone = events.findIndex(event => event.kind === 'trap_removed' && event.instance_id === first);
  const secondReveal = events.findIndex(event => event.kind === 'trap_revealed' && event.instance_id === second);
  assert.ok(firstDone >= 0 && secondReveal > firstDone);
  assert.equal(final.state.zones['hall:main'].length, 3);
});

test('a choice inside a multi-line trap suspends refill until both its lines finish', () => {
  const f = fixture(['TS-0001', 'TS-0002'], ['TS-0476', 'TS-0476']);
  const traps = [f.add('TS-0692', 'dungeon:main'), f.add('TS-0692', 'dungeon:main')]; f.add('TS-0477', 'dungeon:main');
  const abilities = [
    {id: 'TS-0692-A02', source_card_id: 'TS-0692', kind: 'triggered', event: 'TRAP_REVEALED', source_zone: 'event_source', conditions: [], actions: [], usage: 'once_per_event', body: {op: 'gain_xp', amount: 1}},
    {id: 'TS-0692-A01', source_card_id: 'TS-0692', kind: 'triggered', event: 'TRAP_REVEALED', source_zone: 'event_source', conditions: [], actions: [], usage: 'once_per_event',
      body: {op: 'select', query: {zone: 'active_hand'}, bind: 'chosen', min: 1, max: 1, then: {op: 'gain_xp', amount: 1}}},
  ];
  const rules = {...f.rules, abilities}, tx = new Transition(f.state, f.catalog, rules);
  f.rules = rules;
  queueSteps(tx, [{op: 'refill_hall', hall_zone: 'hall:main'}]);
  assert.equal(tx.state.pending_choice.kind, 'trap_activation');
  const started = activate(tx.state, f);
  assert.equal(started.state.pending_choice.kind, 'effect_select');
  assert.ok(started.state.zones['hall:main'].includes(traps[0]));
  assert.equal(started.state.players.alice.xp, 0);
  assert.equal(tx.events.filter(event => event.kind === 'trap_revealed').length, 1);
  const resolve = state => applyCommand(state, {type: 'ResolveChoice', player_id: 'alice', expected_version: state.game_version, instance_ids: [f.hand[0]]}, f.catalog, rules);
  const next = resolve(started.state);
  assert.equal(next.state.pending_choice.kind, 'trap_activation');
  assert.equal(next.state.players.alice.xp, 2);
  assert.equal(next.events.filter(event => event.kind === 'trap_revealed').length, 1);
  assert.ok(next.events.findIndex(event => event.kind === 'card_destroyed' && event.instance_id === traps[0]) < next.events.findIndex(event => event.kind === 'trap_revealed' && event.instance_id === traps[1]));
  const final = resolve(activate(next.state, f).state);
  assert.equal(final.state.pending_choice, null); assert.equal(final.state.players.alice.xp, 4);
});

test('only the current actor can activate the pending trap; wrong, premature and stale commands leave state untouched', () => {
  const f = fixture([], ['TS-0476', 'TS-0476']);
  const trap = f.add('TS-0686', 'dungeon:main');
  const tx = new Transition(f.state, f.catalog, f.rules);
  queueSteps(tx, [{op: 'refill_hall', hall_zone: 'hall:main'}]);
  const state = JSON.parse(JSON.stringify(tx.state)), original = structuredClone(state);
  assert.deepEqual(legalCommands(state, f.catalog, f.rules), [{type: 'ResolveTrap', player_id: 'alice', instance_ids: [trap]}]);
  for (const override of [{player_id: 'bob'}, {instance_id: f.hall[0]}, {type: 'FinishTurn'}, {expected_version: 0}])
    assert.throws(() => applyCommand(state, {type: 'ResolveTrap', player_id: 'alice', instance_id: trap, ...override}, f.catalog, f.rules));
  assert.deepEqual(state, original);
  const result = activate(state, f);
  assert.ok(result.state.zones.destroyed.includes(trap));
  assert.throws(() => activate(result.state, f, trap));
});

test('a trap can wait in rank 4 in the second dungeon without disturbing the first dungeon', () => {
  const f = fixture([], ['TS-0476', 'TS-0476', 'TS-0476']);
  f.add('TS-0571', 'hall:b'); f.add('TS-0476', 'hall:b'); f.add('TS-0476', 'hall:b');
  const trap = f.add('TS-0686', 'dungeon:b'), next = f.add('TS-0477', 'dungeon:b');
  const tx = new Transition(f.state, f.catalog, f.rules);
  queueSteps(tx, [{op: 'refill_hall', hall_zone: 'hall:b'}]);
  assert.equal(tx.state.zones['hall:b'][3], trap);
  assert.equal(tx.events.find(e => e.kind === 'trap_revealed').rank, 4);
  const result = activate(tx.state, f);
  assert.deepEqual(result.state.zones['hall:main'], f.hall);
  assert.equal(result.state.zones['hall:b'][3], next);
  assert.equal(result.events.find(e => e.kind === 'trap_removed').rank, 4);
});

test('the delayed-trap environment still waits until rank 1, then requires a click', () => {
  const f = fixture([], ['TS-0476', 'TS-0476', 'TS-0476']); f.state.active_settings = ['TS-0188'];
  const trap = f.add('TS-0686', 'dungeon:main');
  const tx = new Transition(f.state, f.catalog, f.rules);
  queueSteps(tx, [{op: 'refill_hall', hall_zone: 'hall:main'}]);
  assert.equal(tx.state.pending_choice, null);
  assert.equal(tx.state.zones['hall:main'][3], trap);
  for (const id of f.hall) tx.move(id, 'hall:main', 'destroyed');
  queueSteps(tx, [{op: 'refill_hall', hall_zone: 'hall:main'}]);
  assert.equal(tx.state.pending_choice.instance_id, trap);
  assert.equal(tx.events.find(e => e.kind === 'trap_revealed').origin, 'hall');
  assert.equal(tx.events.find(e => e.kind === 'trap_revealed').rank, 1);
  assert.ok(activate(tx.state, f).state.zones.destroyed.includes(trap));
});

test('a trap exchanged into a higher occupied rank also waits there for activation', () => {
  const f = fixture([], ['TS-0476', 'TS-0686', 'TS-0476']);
  const tx = new Transition(f.state, f.catalog, f.rules);
  queueSteps(tx, [{op: 'refill_hall', hall_zone: 'hall:main'}]);
  assert.equal(tx.state.pending_choice.instance_id, f.hall[1]);
  assert.equal(tx.events.find(e => e.kind === 'trap_revealed').rank, 2);
  assert.equal(tx.events.find(e => e.kind === 'trap_revealed').origin, 'hall');
  assert.ok(activate(tx.state, f).state.zones.destroyed.includes(f.hall[1]));
});
