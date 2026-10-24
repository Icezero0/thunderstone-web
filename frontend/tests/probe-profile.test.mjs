import assert from 'node:assert/strict';
import test from 'node:test';
import {page, settle} from './support/player-deck-dom.mjs';

const session = {access_token: 'access', refresh_token: 'refresh'};
const user = {id: 7, username: '我的冒险者', avatar_url: '/api/v1/users/avatars/test.png', email: 'private@example.com'};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const rows = ui => ui.get('probe-player-list').children[1].children;
const name = row => row.children[0].children[1].children[0].children[0].textContent;
const avatar = row => row.children[0].children[0];

test('probe uses the signed-in username and avatar for yourself while preserving the other demo players', async () => {
  const ui = await page({session, fetchResponse: async (url, options) => {
    assert.equal(url, '/api/v1/users/me'); assert.equal(options.headers.get('Authorization'), 'Bearer access');
    return json(user);
  }});
  assert.equal(name(rows(ui)[0]), user.username); assert.equal(avatar(rows(ui)[0]).children[1].src, user.avatar_url);
  assert.equal(rows(ui)[0].dataset.playerId, 'player-1'); assert.equal(rows(ui)[0].children[0].disabled, true);
  assert.deepEqual(rows(ui).slice(1).map(name), ['玩家 2', '玩家 3']); assert.equal(ui.cards().length, 6);
  assert.equal(ui.get('probe-player-list').textContent.includes(user.email), false);
  ui.window.fire('pagehide', {persisted: false});
});

test('profile changes refresh on returning to the probe and do not reset cards or an open opponent browser', async () => {
  let current = user;
  const ui = await page({session, fetchResponse: async () => json(current)});
  await ui.click('draw-one'); rows(ui)[1].children[0].fire('click'); await settle();
  const modal = ui.get('public-probe-player-browser'); assert.equal(modal.hidden, false);
  current = {...user, username: '更新后的名称', avatar_url: null};
  ui.window.fire('focus'); await settle();
  assert.equal(name(rows(ui)[0]), current.username); assert.equal(avatar(rows(ui)[0]).children[1].hidden, true);
  assert.equal(avatar(rows(ui)[0]).children[0].hidden, false); assert.equal(ui.cards().length, 7);
  assert.equal(ui.get('draw-count').textContent, '23'); assert.equal(ui.get('public-probe-player-browser'), modal); assert.equal(modal.hidden, false);
  current = {...user, username: '再次更新'};
  ui.document.hidden = true; const before = ui.requests.length; ui.document.fire('visibilitychange'); await settle(); assert.equal(ui.requests.length, before);
  ui.document.hidden = false; ui.document.fire('visibilitychange'); await settle(); assert.equal(name(rows(ui)[0]), current.username);
  ui.window.fire('pagehide', {persisted: false});
});

test('anonymous and temporarily offline probes remain usable, and session expiration restores the demo identity', async () => {
  const guest = await page(); assert.equal(name(rows(guest)[0]), '玩家 1'); assert.deepEqual(guest.requests, []);
  guest.window.fire('pagehide', {persisted: false});
  let offline = true, expired = false;
  const ui = await page({session, fetchResponse: async () => {
    if (offline) throw new TypeError('offline');
    return expired ? json({error: {message: 'expired'}}, 401) : json(user);
  }});
  assert.equal(name(rows(ui)[0]), '玩家 1'); await ui.click('draw-one'); assert.equal(ui.cards().length, 7);
  offline = false; ui.window.fire('focus'); await settle(); assert.equal(name(rows(ui)[0]), user.username);
  expired = true; ui.window.fire('focus'); await settle();
  assert.equal(name(rows(ui)[0]), '玩家 1'); assert.equal(avatar(rows(ui)[0]).children[1].src, '/avatars/warrior.svg');
  assert.equal(ui.cards().length, 7); ui.window.fire('pagehide', {persisted: false});
});

test('stale profile responses cannot overwrite newer identity or recreate a disposed probe', async () => {
  let resolveFirst;
  const first = new Promise(resolve => {resolveFirst = resolve;}); let calls = 0;
  const ui = await page({session, fetchResponse: async () => ++calls === 1 ? first : json({...user, username: '最新名称'})});
  ui.window.fire('focus'); await settle(); assert.equal(name(rows(ui)[0]), '最新名称');
  resolveFirst(json({...user, username: '旧名称'})); await settle(); assert.equal(name(rows(ui)[0]), '最新名称');
  ui.window.fire('pagehide', {persisted: false}); const count = ui.requests.length;
  ui.window.fire('focus'); ui.document.fire('visibilitychange'); await settle(); assert.equal(ui.requests.length, count);
  let resolveLate;
  const pending = new Promise(resolve => {resolveLate = resolve;});
  const late = await page({session, fetchResponse: async () => pending});
  late.window.fire('pagehide', {persisted: false}); resolveLate(json(user)); await settle();
  assert.equal(late.get('public-table-area').children.length, 0); assert.equal(late.get('player-deck-overlays').children.length, 0);
});
