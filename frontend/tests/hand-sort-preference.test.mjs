import test from 'node:test';
import assert from 'node:assert/strict';
import {HandSortPreference} from '../.test-dist/hand-sort-preference.js';

const user = (enabled = false, id = 1) => ({id, email: 'test@example.com', username: 'Test', auto_sort_hand: enabled});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('account preference restores on a fresh page and anonymous changes remain local', async () => {
  const applied = [], saved = [], pref = new HandSortPreference(value => applied.push(value), assert.fail, async value => {saved.push(value); return user(value);});
  pref.receive(user(true)); assert.deepEqual(applied, [true]);
  pref.change(false); await tick(); assert.deepEqual(saved, [false]);
  const restored = new HandSortPreference(value => applied.push(value), assert.fail); restored.receive(user(saved.at(-1)));
  assert.equal(applied.at(-1), false);
  pref.receive(null); pref.change(true); await tick(); assert.deepEqual(saved, [false]);
  pref.dispose(); restored.dispose();
});

test('rapid toggles write serially and finish with the latest intent despite an intervening profile refresh', async () => {
  const writes = [], pending = [], pref = new HandSortPreference(() => {}, assert.fail, value => {
    writes.push(value); return new Promise(resolve => pending.push(() => resolve(user(value))));
  });
  pref.receive(user()); pref.change(true); pref.change(false); pref.receive(user());
  assert.deepEqual(writes, [true]); pending.shift()(); await tick();
  assert.deepEqual(writes, [true, false]); pending.shift()(); await tick(); assert.equal(pending.length, 0); pref.dispose();
});

test('failed persistence restores the saved value and reports, while late replies cannot change a different account', async () => {
  const applied = [], errors = [], pref = new HandSortPreference(value => applied.push(value), text => errors.push(text), async () => {throw new Error('offline');});
  pref.receive(user(true)); pref.change(false); await tick(); assert.equal(applied.at(-1), true); assert.equal(errors.length, 1); pref.dispose();
  let finish;
  const next = new HandSortPreference(value => applied.push(value), assert.fail, () => new Promise(resolve => {finish = resolve;}));
  next.receive(user()); next.change(true); next.receive(user(false, 2)); finish(user(true)); await tick();
  assert.equal(applied.at(-1), false); next.dispose();
});
