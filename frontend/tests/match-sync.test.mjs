import test from 'node:test';
import assert from 'node:assert/strict';
import {MatchSync} from '../.test-dist/match-sync.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
const change = version => ({type: 'match_changed', payload: {match_id: 'match', version}});

test('own command notifications wait for its response and do not fetch the same version', async () => {
  let view = {id: 'match', version: 1}, busy = true, calls = 0;
  const sync = new MatchSync(() => view, () => busy, async () => {calls++;});
  sync.invalidate(change(2)); sync.invalidate(change(2)); assert.equal(calls, 0);
  view = {...view, version: 2}; busy = false; sync.resume(); await settle();
  assert.equal(calls, 0);
  sync.invalidate(change(1)); sync.invalidate({type: 'room_changed'});
  sync.invalidate({type: 'match_changed', payload: {match_id: 'other', version: 100}});
  assert.equal(calls, 0); sync.dispose();
});

test('notifications during a slow refresh coalesce and only fetch again if still behind', async () => {
  let view = {id: 'match', version: 1}, calls = 0, reply;
  const sync = new MatchSync(() => view, () => false, () => {calls++; return new Promise(resolve => {reply = resolve;});});
  sync.invalidate(change(2)); sync.invalidate(change(3)); sync.invalidate(change(3));
  assert.equal(calls, 1);
  view.version = 2; reply(); await settle(); assert.equal(calls, 2);
  sync.invalidate(change(3)); view.version = 3; reply(); await settle(); assert.equal(calls, 2); sync.dispose();
});

test('reconnect and profile changes refresh same-version data and failures never retry indefinitely', async () => {
  let busy = true, calls = 0;
  const sync = new MatchSync(() => ({id: 'match', version: 4}), () => busy, async () => {calls++; throw new Error('offline');});
  sync.invalidate({type: 'profile_changed'}); sync.invalidate({type: 'connected'});
  busy = false; sync.resume(); await settle(); assert.equal(calls, 1);
  await settle(); assert.equal(calls, 1);
  sync.invalidate(change(5)); await settle(); assert.equal(calls, 2);
  sync.dispose(); sync.invalidate({type: 'connected'}); await settle(); assert.equal(calls, 2);
});
