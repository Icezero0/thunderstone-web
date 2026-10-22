import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {ApiClient, ApiError, SESSION_KEY} from '../.test-dist/api.js';
import {configurationSummary, roomPresentation} from '../.test-dist/room-view.js';
import {RoomConnection} from '../.test-dist/realtime.js';

const tokens = {access_token: 'old-access', refresh_token: 'old-refresh'};
function storage(value = tokens) {
  const values = new Map([[SESSION_KEY, JSON.stringify(value)]]);
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
}
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

test('default browser fetch retains its global receiver for registration and session refresh', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async function (url, options) {
    // Browser fetch checks its receiver; Node's fetch and injected arrow stubs do not.
    assert.equal(this, globalThis);
    requests.push(url);
    if (url.endsWith('/register')) return json({id: 1}, 201);
    if (url.endsWith('/refresh')) return json({access_token: 'new', refresh_token: 'new-refresh'});
    if (options.headers.get('Authorization') === 'Bearer old-access') return json({error: {message: 'expired'}}, 401);
    return json({rooms: []});
  };
  try {
    const registration = new ApiClient(null);
    assert.equal((await registration.request('/auth/register', {
      method: 'POST', body: JSON.stringify({email: 'a@example.com', password: 'secret123', username: 'Alice'}),
    })).id, 1);
    const session = new ApiClient(storage());
    assert.deepEqual(await session.request('/rooms'), {rooms: []});
    assert.equal(session.accessToken, 'new');
    assert.deepEqual(requests, ['/api/v1/auth/register', '/api/v1/rooms', '/api/v1/auth/refresh', '/api/v1/rooms']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('login stores a tab session and obtains the authenticated user', async () => {
  const saved = storage(null);
  const client = new ApiClient(saved, async (url, options) => {
    if (url.endsWith('/login')) {
      assert.deepEqual(JSON.parse(options.body), {email: 'a@example.com', password: 'secret123'});
      assert.equal(options.headers.has('Authorization'), false);
      return json(tokens);
    }
    assert.equal(options.headers.get('Authorization'), 'Bearer old-access');
    return json({id: 1, email: 'a@example.com', username: 'Alice'});
  });
  assert.equal((await client.login('a@example.com', 'secret123')).id, 1);
  assert.deepEqual(JSON.parse(saved.getItem(SESSION_KEY)), tokens);
  client.signOut(); assert.equal(saved.getItem(SESSION_KEY), null);
});

test('concurrent expired requests refresh once and retry the original payloads', async () => {
  let refreshes = 0;
  let resolveRefresh;
  const refreshed = new Promise(resolve => {resolveRefresh = resolve;});
  const client = new ApiClient(storage(), async (url, options) => {
    if (url.endsWith('/refresh')) {refreshes++; await refreshed; return json({access_token: 'new', refresh_token: 'new-refresh'});}
    if (options.headers.get('Authorization') === 'Bearer old-access') return json({error: {message: 'expired'}}, 401);
    return json({url, body: options.body});
  });
  const original = {method: 'POST', body: JSON.stringify({expected_version: 3, ready: true})};
  const first = client.request('/rooms/one/ready', original);
  const second = client.request('/rooms');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1); resolveRefresh();
  assert.equal((await first).body, original.body);
  assert.equal((await second).url, '/api/v1/rooms');
  assert.equal(client.accessToken, 'new');
  assert.equal(Object.hasOwn(original, 'headers'), false);
});

test('rejected refresh expires the session and does not retry a room command', async () => {
  let expired = 0, commands = 0;
  const saved = storage();
  const client = new ApiClient(saved, async url => {
    if (url.endsWith('/refresh')) return json({error: {message: 'expired'}}, 401);
    commands++; return json({error: {message: 'expired'}}, 401);
  });
  client.onExpired = () => expired++;
  await assert.rejects(client.request('/rooms'), error => error instanceof ApiError && error.status === 401);
  assert.equal(expired, 1); assert.equal(commands, 1); assert.equal(saved.getItem(SESSION_KEY), null);
});

test('logout during refresh cannot silently restore the old session', async () => {
  let resolveRefresh;
  const refreshed = new Promise(resolve => {resolveRefresh = resolve;});
  const saved = storage();
  const client = new ApiClient(saved, async url => {
    if (url.endsWith('/refresh')) {await refreshed; return json({access_token: 'new', refresh_token: 'new-refresh'});}
    return json({error: {message: 'expired'}}, 401);
  });
  const request = client.request('/rooms');
  await new Promise(resolve => setImmediate(resolve));
  client.signOut(); resolveRefresh();
  await assert.rejects(request);
  assert.equal(client.accessToken, null); assert.equal(saved.getItem(SESSION_KEY), null);
});

test('room conflicts preserve their status and do not change session tokens', async () => {
  const client = new ApiClient(storage(), async () => json({error: {
    code: 'room_version_conflict', message: '房间已更新，请刷新后重试', details: {version: 4},
  }}, 409));
  await assert.rejects(client.request('/rooms/one/ready'), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'room_version_conflict');
    assert.deepEqual(error.details, {version: 4}); return true;
  });
  assert.equal(client.accessToken, 'old-access');
});

test('an old rejected refresh cannot clear a newly logged-in account', async () => {
  let release, expired = 0;
  const oldRefresh = new Promise(resolve => {release = resolve;});
  const client = new ApiClient(storage(), async url => {
    if (url.endsWith('/refresh')) {await oldRefresh; return json({error: {message: 'expired'}}, 401);}
    if (url.endsWith('/login')) return json({access_token: 'different-account', refresh_token: 'different-refresh'});
    if (url.endsWith('/me')) return json({id: 2});
    return json({error: {message: 'expired'}}, 401);
  });
  client.onExpired = () => expired++;
  const request = client.request('/rooms');
  await new Promise(resolve => setImmediate(resolve));
  client.signOut(); await client.login('new@example.com', 'secret123'); release();
  await assert.rejects(request);
  assert.equal(client.accessToken, 'different-account'); assert.equal(expired, 0);
});

function roomFixture() {
  return {host_user_id: 1, players: [{user_id: 1, ready: true}, {user_id: 2, ready: false}],
    config: {counts: {village_groups: 8, hero_groups: 4, monster_groups: 3}, selection: {
      village: {fixed_randomizer_ids: ['TS-0088']}, hero: {fixed_randomizer_ids: []}, monster: {fixed_randomizer_ids: []},
      dungeon_features: {mode: 'manual'}, environment: {fixed_card_ids: ['TS-0192'], random_count: 0},
      guardian: {fixed_card_ids: [], random_count: 1}, trap: {fixed_group_ids: [], random_count: 0},
      treasure: {fixed_group_ids: [], random_count: 0}, thunderstone: {fixed_card_ids: []},
    }, instance_multipliers: {village: 1, hero: 2, monster: 1}}};
}

test('room summary uses shared environment rules and resolves selected names', () => {
  const room = roomFixture(); const before = structuredClone(room);
  const result = configurationSummary(room, {card_names: {'TS-0088': '村民', 'TS-0192': '绝境庇护所'}});
  assert.deepEqual(result.counts, {village: 10, hero: 3, monster: 3});
  assert.ok(result.details.some(([title, text]) => title === '环境' && text === '绝境庇护所'));
  assert.ok(result.details.some(([title, text]) => title === '守护者' && text === '随机 1 种'));
  assert.deepEqual(room, before);
  room.config.selection.dungeon_features.mode = 'classic_random';
  assert.deepEqual(configurationSummary(room, null).counts, {village: 8, hero: 4, monster: 3});
  assert.equal(configurationSummary(room, null).featureMode, '经典随机');
  room.config.selection.dungeon_features.mode = 'manual';
  room.config.selection.environment.fixed_card_ids = ['TS-0198'];
  assert.equal(configurationSummary(room, null).counts.monster, 4);
});

test('room permissions follow membership and host identity without a seat model', () => {
  const room = roomFixture();
  assert.deepEqual(roomPresentation(room, 1), {isHost: true, isMember: true, ready: true, readyCount: 1});
  assert.deepEqual(roomPresentation(room, 2), {isHost: false, isMember: true, ready: false, readyCount: 1});
  assert.deepEqual(roomPresentation(room, 3), {isHost: false, isMember: false, ready: false, readyCount: 1});
});

test('realtime handshake and reconnect recovery trigger authoritative room reloads', async () => {
  const previousSocket = globalThis.WebSocket, previousLocation = globalThis.location;
  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; sent = [];
    constructor(url) {this.url = url; sockets.push(this);}
    send(value) {this.sent.push(JSON.parse(value));}
    close() {this.onclose?.();}
  }
  globalThis.WebSocket = FakeSocket; globalThis.location = {protocol: 'https:', host: 'game.example'};
  let reloads = 0; const statuses = [];
  const connection = new RoomConnection({restore: async () => ({id: 1}), accessToken: 'access'}, () => reloads++, value => statuses.push(value));
  try {
    await connection.connect();
    const socket = sockets[0]; assert.equal(socket.url, 'wss://game.example/ws');
    socket.onopen(); assert.deepEqual(socket.sent[0], {type: 'auth', payload: {token: 'access'}});
    socket.onmessage({data: JSON.stringify({type: 'ack'})});
    socket.onmessage({data: JSON.stringify({type: 'room_changed'})});
    assert.equal(reloads, 2); assert.deepEqual(statuses, ['connecting', 'online']);
  } finally {connection.close(); globalThis.WebSocket = previousSocket; globalThis.location = previousLocation;}
});

async function panelContext(request) {
  const source = await readFile(new URL('../panel.js', import.meta.url), 'utf8');
  const elements = new Map();
  const context = vm.createContext({URLSearchParams, location: {search: `?room=${'a'.repeat(32)}`},
    document: {querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {hidden: true, disabled: false, textContent: ''});
      return elements.get(selector);
    }}, structuredClone, apiStub: {request}, payload: {mode: 'classic', test: 'unsaved draft'}});
  vm.runInContext(source.replace(/\nmain\(\);\s*$/, ''), context);
  vm.runInContext(`roomEditor = {api: apiStub, room: {config_version: 1}, dirty: true};
    enginePayload = () => payload; refresh = () => {};`, context);
  return {context, elements};
}

test('room editor preserves the unsaved draft when another page updated its configuration', async () => {
  const requests = [];
  const {context, elements} = await panelContext(async (path, options) => {
    requests.push({path, options}); return {config_version: 2, version: 7};
  });
  await vm.runInContext('saveRoomConfig()', context);
  assert.equal(requests.length, 1);
  assert.match(elements.get('#room-editor-status').textContent, /其他页面更新/);
  assert.equal(elements.get('#reload-room').hidden, false);
  assert.equal(vm.runInContext('roomEditor.dirty', context), true);
});

test('room editor can save after a readiness update using the new room version', async () => {
  let submitted;
  const {context, elements} = await panelContext(async (path, options) => {
    if (!options) return {config_version: 1, version: 7};
    submitted = JSON.parse(options.body); return {config_version: 2, version: 8, config: submitted.config};
  });
  await vm.runInContext('saveRoomConfig()', context);
  assert.equal(submitted.expected_version, 7);
  assert.equal(submitted.config.test, 'unsaved draft');
  assert.equal(vm.runInContext('roomEditor.dirty', context), false);
  assert.match(elements.get('#room-editor-status').textContent, /已保存至房间/);
  assert.equal(elements.get('#save-room').disabled, false);
});
