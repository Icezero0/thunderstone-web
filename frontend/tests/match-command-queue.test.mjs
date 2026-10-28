import test from 'node:test';
import assert from 'node:assert/strict';
import {MatchCommandQueue} from '../.test-dist/match-command-queue.js';
import {viewQuery, viewCursor, mergeMatchView} from '../.test-dist/match-protocol.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const view = version => ({id: 'game', version, history: {epoch: 0, entries: []},
  sync: {reset: false, event_sequence: version * 10, history_loaded: false, history_after: 0}});
function harness({matches = (a, b) => a.version === b.version, recover = async () => view(1)} = {}) {
  const requests = [], shown = [];
  const queue = new MatchCommandQueue({predict: (v, c) => c.type === 'wait' ? null : view(v.version + 1), matches,
    send: (v, command, id) => new Promise((resolve, reject) => requests.push({view: v, command, id, resolve, reject})),
    show: (v, reset) => shown.push({view: v, reset}), changed() {}, recover});
  queue.receive(view(1)); return {queue, requests, shown};
}
test('several clicks predict immediately while HTTP requests remain ordered; ACKs never replay old predictions', async () => {
  const {queue, requests, shown} = harness();
  queue.enqueue({type: 'buy'}); queue.enqueue({type: 'upgrade'});
  assert.equal(queue.blocked, false); assert.equal(queue.pending, 2);
  assert.deepEqual(shown.map(s => s.view.version), [1, 2, 3]); assert.equal(requests.length, 1);
  requests[0].resolve(view(2)); await tick();
  assert.equal(requests.length, 2); assert.equal(requests[1].view.version, 2);
  assert.equal(shown.at(-1).view.version, 3);
  requests[1].resolve(view(3)); await tick();
  assert.equal(queue.pending, 0); assert.equal(queue.baseline.version, 3);
  assert.deepEqual(shown.map(s => s.view.version), [1, 2, 3, 3]); // Same-version confirmation is not a new animation.
});
test('unknown action waits behind predictions, then locks input until the authoritative reply', async () => {
  const {queue, requests, shown} = harness();
  queue.enqueue({type: 'buy'}); queue.enqueue({type: 'wait'});
  assert.equal(queue.blocked, true); assert.equal(queue.enqueue({type: 'buy'}), false);
  assert.equal(shown.at(-1).view.version, 2);
  requests[0].resolve(view(2)); await tick(); requests[1].resolve(view(3)); await tick();
  assert.equal(queue.blocked, false); assert.equal(shown.at(-1).view.version, 3);
});
test('prediction divergence discards dependent commands and resets to the server without submitting them', async () => {
  const {queue, requests, shown} = harness({matches: () => false});
  queue.enqueue({type: 'buy'}); queue.enqueue({type: 'upgrade'});
  requests[0].resolve(view(2)); await tick();
  assert.equal(requests.length, 1); assert.equal(queue.pending, 0);
  assert.deepEqual(shown.at(-1), {view: view(2), reset: true});
});
test('network rejection recovers authority, discards dependents and preserves receipt ID for same-command retry', async () => {
  const {queue, requests, shown} = harness();
  queue.enqueue({type: 'buy'}); queue.enqueue({type: 'upgrade'});
  requests[0].reject(new Error('network')); await tick();
  assert.equal(queue.blocked, false); assert.equal(queue.pending, 0); assert.equal(shown.at(-1).reset, true);
  queue.enqueue({type: 'buy'}); assert.equal(requests[1].id, requests[0].id);
  requests[1].resolve(view(2)); await tick();
});
test('ambiguous failure stays blocked until refresh; a recovered committed result is not resent automatically', async () => {
  const {queue, requests} = harness({recover: async () => null});
  queue.enqueue({type: 'buy'}); requests[0].reject(new Error('offline')); await tick();
  assert.equal(queue.blocked, true); assert.equal(queue.enqueue({type: 'buy'}), false);
  queue.recovered(view(2)); assert.equal(queue.blocked, false); assert.equal(requests.length, 1);
});
test('stale refresh during a pending operation cannot replace the local prediction; dispose ignores late replies', async () => {
  const {queue, requests, shown} = harness(); queue.enqueue({type: 'buy'}); queue.receive(view(1));
  assert.equal(shown.at(-1).view.version, 2); queue.dispose(); requests[0].resolve(view(2)); await tick();
  assert.equal(queue.baseline, null); assert.equal(shown.length, 2);
});
test('compact wire carries committed event cursors and merges only history summaries', () => {
  assert.equal(viewQuery(null), '?compact=true'); assert.deepEqual(viewCursor(view(1)).sync, {epoch: 0, after_event: 10, history_after: null});
  const old = {...view(1), event_log: ['old'], history: {epoch: 0, entries: [{step: 1}]},
    sync: {...view(1).sync, history_loaded: true, history_after: 1}};
  const next = {...view(2), event_log: ['new'], history: {epoch: 0, entries: [{step: 2}]}};
  const merged = mergeMatchView(old, next);
  assert.deepEqual(merged.event_log, ['new']); assert.deepEqual(merged.history.entries, [{step: 1}, {step: 2}]);
});
