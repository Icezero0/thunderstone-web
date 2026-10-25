import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';

const source = await readFile(new URL('../.test-dist/player-list-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="game"><div id="host"></div><div id="other"></div></main><div id="overlays"></div></body></html>';
const card = (id, cardId) => ({id, cardId, name: cardId});
const snapshot = () => [
  {id: 'alice', name: 'Alice', isYou: true, isActive: true, avatarUrl: '/avatars/alice.png'},
  {id: 'bob', name: 'Bob', cards: {
    hand: [{id: 'hidden', cardId: 'SECRET-99', name: '秘密卡名', revealed: false}, {...card('shown', 'TS-0003'), revealed: true}],
    draw: [card('d1', 'TS-10'), card('d2', 'TS-2')], discard: [card('x1', 'TS-30'), card('x2', 'TS-3')],
  }},
];
const rows = list => list.root.children[1].children;
const visible = (ui, prefix = 'first') => ui.get(`${prefix}-player-browser-grid`).children.filter(node => node.className === 'player-browser-entry').map(node => node.children[0]);
async function setup(options = {}) {
  const ui = await page({html, source}), api = ui.evaluate('PlayerListPackage');
  const list = new api.PlayerList(ui.get('host'), {idPrefix: 'first', overlayRoot: ui.get('overlays'), ...options});
  const players = snapshot(); list.setPlayers(players); await settle(); return {ui, api, list, players};
}

test('the player list mounts independently, supports multiple instances and owns its modal lifecycle', async () => {
  const calls = [], {ui, api, list} = await setup({onBeforeOpen: (id, zone) => calls.push([id, zone])});
  const other = new api.PlayerList(ui.get('other'), {overlayRoot: ui.get('overlays')}); other.setPlayers(snapshot());
  assert.notEqual(list.root.id, other.root.id);
  const ids = ui.all.filter(node => node.isConnected && node.id).map(node => node.id); assert.equal(new Set(ids).size, ids.length);
  assert.equal(ui.all.some(node => node.className.split(' ').includes('public-table-area')), false);
  const own = rows(list)[0].children[0]; assert.equal(own.disabled, true); own.fire('click'); assert.equal(list.isBrowsing, false);
  const trigger = rows(list)[1].children[0]; trigger.focus(); trigger.fire('click'); await settle();
  assert.deepEqual(calls, [['bob', 'hand']]); assert.equal(list.browsingPlayerId, 'bob'); assert.equal(list.root.inert, true);
  assert.equal(other.root.inert, false); ui.key('Escape'); assert.equal(list.root.inert, false); assert.equal(ui.document.activeElement, trigger);
  list.dispose(); assert.equal(ui.get('host').children.length, 0); assert.equal(ui.get('overlays').children.length, 1);
  assert.equal(rows(other).length, 2); other.dispose(); assert.equal(ui.get('overlays').children.length, 0);
  assert.deepEqual(ui.requests, []);
});

test('snapshots are copied atomically, inventories sort by card ID and hidden identities never reach image loading', async () => {
  const loaded = [], {ui, list, players} = await setup({images: {front: id => {loaded.push(id); return `/custom/${id}.png`;}}});
  list.openPlayer('bob'); await settle();
  assert.equal(visible(ui)[0].dataset.face, 'back'); assert.equal(visible(ui)[0].dataset.cardId, undefined);
  assert.equal(loaded.includes('SECRET-99'), false);
  players[1].name = 'Caller mutation'; players[1].cards.hand[0].revealed = true;
  assert.equal(ui.get('first-player-browser-title').textContent, 'Bob'); assert.equal(visible(ui)[0].dataset.face, 'back');
  const invalid = snapshot(); invalid[1].cards.draw.push(card('shown', 'TS-9'));
  assert.throws(() => list.setPlayers(invalid), /unique/); assert.equal(ui.get('first-player-browser-title').textContent, 'Bob');
  ui.get('first-player-browser-draw-tab').fire('click'); await settle();
  assert.deepEqual(visible(ui).map(node => node.dataset.cardId), ['TS-2', 'TS-10']);
  ui.get('first-player-browser-discard-tab').fire('click'); await settle();
  assert.deepEqual(visible(ui).map(node => node.dataset.cardId), ['TS-3', 'TS-30']);
  list.dispose();
});

test('a standalone open browser follows reveal, conceal and player removal without replacing the modal', async () => {
  const {ui, list, players} = await setup(); list.openPlayer('bob'); await settle();
  const modal = ui.get('first-player-browser'), retained = visible(ui)[1];
  players[1].cards.hand[0].revealed = true; list.setPlayers(players); await settle();
  const front = visible(ui)[0]; assert.equal(front.dataset.face, 'front'); assert.equal(visible(ui)[1], retained);
  front.fire('pointerenter'); ui.key('e'); assert.equal(ui.get('first-player-browser-inspect').hidden, false);
  list.finish(); assert.equal(ui.get('first-player-browser-inspect').hidden, true); assert.equal(list.isBrowsing, true);
  players[1].cards.hand[0].revealed = false; list.setPlayers(players); await settle();
  assert.equal(front.isConnected, false); assert.equal(visible(ui)[0].dataset.face, 'back'); assert.equal(ui.get('first-player-browser'), modal);
  assert.equal(ui.all.some(node => node.isConnected && node.tagName === 'img' && node.src?.includes('SECRET-99')), false);
  list.setPlayers([]); assert.equal(list.root.hidden, true); assert.equal(list.isBrowsing, false);
  assert.equal(list.root.inert, false); assert.equal(ui.document.activeElement, ui.get('host'));
  list.dispose(); list.dispose(); assert.throws(() => list.setPlayers(players), /disposed/);
});

test('the host controls modal backgrounds and opening coordination without coupling the component to a game board', async () => {
  const ui = await page({html, source}), api = ui.evaluate('PlayerListPackage');
  const background = ui.get('game'); background.inert = true;
  const list = new api.PlayerList(ui.get('host'), {idPrefix: 'scoped', overlayRoot: ui.get('overlays'), background: [background]});
  list.setPlayers(snapshot()); rows(list)[1].children[0].fire('click'); assert.equal(list.isBrowsing, false);
  list.openPlayer('bob', 'draw'); await settle(); assert.equal(list.isBrowsing, true);
  list.closePlayer(); assert.equal(background.inert, true);
  background.inert = false; list.openPlayer('bob'); await settle(); list.dispose();
  assert.equal(background.inert, false); assert.equal(ui.get('overlays').children.length, 0); assert.equal(ui.key('Escape').defaultPrevented, false);
});

test('activity bubbles attach to player rows, replace text and expire without replaying on snapshots', async () => {
  const {ui, list, players} = await setup(); list.showActivity('bob', '展示了手牌');
  const bubble = ui.get('first-player-activity');
  assert.ok(bubble.parentElement === list.root); assert.equal(bubble.dataset.playerId, 'bob'); assert.equal(bubble.textContent, '展示了手牌');
  assert.equal(bubble.getAttribute('role'), 'status');
  await ui.advance(3000); list.setPlayers([...players].reverse()); assert.ok(bubble.parentElement === list.root);
  list.showActivity('bob', '摧毁了 <民兵>');
  assert.equal(bubble.textContent, '摧毁了 <民兵>'); assert.equal(bubble.children.length, 2);
  assert.equal(bubble.children[0].children.length, 0, 'message remains plain text');
  assert.equal(bubble.children[1].tagName, 'svg'); assert.equal(bubble.children[1].getAttribute('aria-hidden'), 'true');
  await ui.advance(2000); assert.equal(bubble.isConnected, true);
  await ui.advance(2500); assert.equal(bubble.isConnected, false);
  list.setPlayers(players); assert.equal(bubble.isConnected, false);
  list.showActivity('bob', '展示了手牌'); list.setPlayers(players.slice(0, 1)); assert.equal(bubble.isConnected, false); list.dispose();
});

test('activity bubbles clean up on hidden pages and disposal; probe examples only affect presentation', async () => {
  const {ui, list} = await setup(); list.showActivity('bob', '展示了手牌'); const bubble = ui.get('first-player-activity');
  ui.document.hidden = true; ui.document.fire('visibilitychange'); assert.equal(bubble.isConnected, false);
  list.showActivity('bob', '不会显示'); assert.equal(bubble.isConnected, false);
  ui.document.hidden = false; list.showActivity('bob', '展示了手牌'); ui.window.fire('pagehide'); assert.equal(bubble.isConnected, false);
  list.showActivity('bob', '摧毁了 民兵'); list.dispose(); await ui.advance(10000); assert.equal(bubble.isConnected, false);
  const probe = await page(), before = probe.cards().map(card => card.dataset.instanceId);
  await probe.click('demo-player-activity'); assert.equal(probe.get('public-probe-player-activity').textContent, '展示了手牌');
  await probe.click('demo-player-destroy'); assert.equal(probe.get('public-probe-player-activity').textContent, '摧毁了 民兵');
  assert.deepEqual(probe.cards().map(card => card.dataset.instanceId), before); probe.window.fire('pagehide', {persisted: false});
});

test('scrolling the player list moves the external bubble and hides it when its row is clipped', async () => {
  const {ui, list} = await setup(), scroller = ui.get('first-players-list'), row = rows(list)[1];
  let top = 95, height = 72;
  const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
  list.root.getBoundingClientRect = () => rect(600, 50, 160, 180);
  scroller.getBoundingClientRect = () => rect(610, 90, 140, 120);
  row.getBoundingClientRect = () => rect(610, top, 140, height);
  list.showActivity('bob', '展示了手牌'); const bubble = ui.get('first-player-activity');
  assert.equal(scroller.contains(bubble), false); assert.equal(bubble.style.left, '-4px');
  assert.equal(bubble.style.top, '81px'); assert.equal(bubble.hidden, false);
  top = 230; scroller.fire('scroll'); assert.equal(bubble.hidden, true);
  top = 170; scroller.fire('scroll'); assert.equal(bubble.hidden, false); assert.equal(bubble.style.top, '140px');
  top = 90; height = 40; ui.observers.at(-1).callback(); assert.equal(bubble.style.top, '60px');
  list.dispose(); scroller.fire('scroll'); assert.equal(bubble.isConnected, false);
});
