import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';
import {createDungeonDemo, createVillageDemo} from '../.test-dist/probe-public-state.js';

const source = await readFile(new URL('../.test-dist/public-table-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="game"><div id="host"></div></main><div id="overlays"></div></body></html>';
const card = (id, cardId, name = cardId) => ({id, cardId, name});
function snapshot(isYou = false) {
  return {dungeon: createDungeonDemo({spire: false, rankZero: false, rankFour: false}), village: createVillageDemo(), players: [
    {id: 'alice', name: 'Alice', isActive: true, isYou, avatarUrl: '/avatar/alice.svg', cards: {
      hand: [{...card('h1', 'SECRET-99', '秘密卡名'), revealed: false}, {...card('h2', 'TS-0003', '火把'), revealed: true}, {id: 'h3', revealed: false}],
      draw: [card('d1', 'TS-10'), card('d2', 'TS-2'), card('d3', 'TS-10')],
      discard: [card('x1', 'TS-30'), card('x2', 'TS-3')],
    }}, {id: 'bob', name: 'Bob', cards: {hand: [], draw: [], discard: []}},
  ]};
}
const rows = ui => ui.get('players-players').children[1].children;
const trigger = (ui, index = 0) => rows(ui)[index].children[0];
const visible = ui => ui.get('players-player-browser-grid').children.filter(node => node.className === 'player-browser-entry').map(node => node.children[0]);
const browse = ui => ui.get('players-player-browser');
async function setup(state = snapshot(), options = {}) {
  const ui = await page({html, source}), api = ui.evaluate('PublicTablePackage');
  const area = new api.PublicTableArea(ui.get('host'), {idPrefix: 'players', overlayRoot: ui.get('overlays'), ...options});
  area.setState(state); await settle(); return {ui, area, state};
}

test('players use a circular-avatar image/fallback and a named native button, without a list number, and current turn follows snapshots', async () => {
  const {ui, area, state} = await setup(), alice = rows(ui)[0], button = trigger(ui), avatar = button.children[0];
  assert.equal(button.tagName, 'button'); assert.equal(button.getAttribute('aria-label'), 'Alice，查看牌区');
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog'); assert.equal(avatar.textContent, '');
  assert.equal(avatar.children[1].src, '/avatar/alice.svg'); assert.equal(alice.getAttribute('aria-current'), 'true');
  avatar.children[1].fire('error'); assert.equal(avatar.children[1].hidden, true); assert.equal(avatar.children[0].hidden, false);
  state.players[0].avatarUrl = '/avatar/new.svg'; state.players[0].isActive = false; state.players[1].isActive = true;
  area.setState(state); assert.equal(avatar.children[1].hidden, false); assert.equal(avatar.children[1].src, '/avatar/new.svg');
  assert.equal(rows(ui)[0], alice); assert.equal(alice.getAttribute('aria-current'), null); assert.equal(rows(ui)[1].getAttribute('aria-current'), 'true');
  button.fire('click'); await settle(); assert.equal(area.browsingPlayerId, 'alice'); assert.equal(ui.get('players-player-browser-title').textContent, 'Alice'); area.dispose();
});

test('opponent hand hides identity in DOM and image requests; Space only inspects backs for unrevealed cards', async () => {
  const loaded = [], {ui, area} = await setup(snapshot(), {images: {front: id => {loaded.push(id); return `/faces/${id}.png`;}}});
  trigger(ui).fire('click'); await settle();
  const hand = visible(ui); assert.deepEqual(hand.map(node => node.dataset.face), ['back', 'front', 'back']);
  assert.equal(hand[0].dataset.cardId, undefined); assert.equal(hand[0].getAttribute('aria-label').includes('秘密卡名'), false);
  assert.equal(loaded.includes('SECRET-99'), false);
  assert.equal(ui.all.some(node => node.isConnected && node.tagName === 'img' && node.src?.includes('SECRET-99')), false);
  for (const index of [0, 2]) {
    hand[index].fire('pointerenter'); ui.key(' '); assert.equal(ui.get('players-player-browser-inspect').hidden, false);
    assert.equal(ui.get('players-player-browser-inspect-content').dataset.face, 'back');
    const image = ui.get('players-player-browser-inspect-content').children.find(node => !node.hidden).children[1];
    assert.equal(image.src, '/cards/TS-BACK-001.jpg'); assert.equal(image.width, 501);
    ui.release(); hand[index].fire('pointerleave');
  }
  hand[1].fire('pointerenter'); ui.key(' '); assert.equal(ui.get('players-player-browser-inspect-content').dataset.face, 'front');
  assert.equal(ui.key('f').defaultPrevented, false); assert.equal(hand[0].dataset.face, 'back'); area.dispose();
});

test('owners see private hand faces while draw and discard are both canonical ID inventories without mutating source order', async () => {
  const state = snapshot(true); state.players[0].cards.hand[2] = {...card('h3', 'TS-0001', '民兵'), revealed: false};
  const before = structuredClone(state), {ui, area} = await setup(state);
  area.openPlayer('alice'); await settle(); assert.deepEqual(visible(ui).map(node => node.dataset.face), ['front', 'front', 'front']);
  assert.equal(visible(ui)[0].dataset.cardId, 'SECRET-99');
  ui.get('players-player-browser-draw-tab').fire('click'); await settle();
  assert.deepEqual(visible(ui).map(node => node.dataset.cardId), ['TS-2', 'TS-10', 'TS-10']);
  assert.deepEqual(visible(ui).map(node => node.dataset.instanceId), ['d2', 'd1', 'd3']);
  ui.get('players-player-browser-discard-tab').fire('click'); await settle();
  assert.deepEqual(visible(ui).map(node => node.dataset.cardId), ['TS-3', 'TS-30']);
  assert.equal(ui.get('players-player-browser-grid').getAttribute('aria-labelledby'), 'players-player-browser-discard-tab');
  assert.ok(ui.get('players-player-browser-grid').children.filter(node => node.className === 'player-browser-entry').every(node => node.children.length === 1));
  assert.deepEqual(state, before); area.dispose();
});

test('live reveal and conceal replace only the affected view and release its front and Space inspection on conceal', async () => {
  const {ui, area, state} = await setup(); area.openPlayer('alice'); await settle();
  const modal = browse(ui), firstBack = visible(ui)[0], publicCard = visible(ui)[1];
  state.players[0].cards.hand[0].revealed = true; area.setState(state); await settle();
  const revealed = visible(ui)[0]; assert.notEqual(revealed, firstBack); assert.equal(firstBack.isConnected, false);
  assert.equal(visible(ui)[1], publicCard); assert.equal(revealed.dataset.face, 'front');
  ui.key('Tab'); revealed.focus(); revealed.fire('pointerenter'); ui.key(' '); assert.equal(ui.get('players-player-browser-inspect').hidden, false);
  state.players[0].cards.hand[0].revealed = false; area.setState(state); await settle();
  assert.equal(revealed.isConnected, false); assert.equal(visible(ui)[0].dataset.face, 'back');
  assert.equal(ui.get('players-player-browser-inspect').hidden, true); assert.equal(ui.document.activeElement, ui.get('players-player-browser-close'));
  assert.equal(ui.all.some(node => node.isConnected && node.tagName === 'img' && node.src?.includes('SECRET-99')), false);
  assert.equal(browse(ui), modal); assert.equal(area.browsingPlayerId, 'alice'); area.dispose();
});

test('an open inventory keeps scroll and retained focus through external changes, and an owner change hides its former private hand', async () => {
  const state = snapshot(true); state.players[0].cards.hand[2] = {...card('h3', 'TS-0001'), revealed: false};
  const {ui, area} = await setup(state); area.openPlayer('alice', 'draw'); await settle();
  const retained = visible(ui)[0], image = retained.children[0].children[0].children[0].children[0];
  const writes = image.srcWrites.length; retained.focus(); ui.get('players-player-browser-grid').scrollTop = 90;
  state.players[0].cards.draw.push(card('d4', 'TS-1')); area.setState(state); await settle();
  assert.equal(ui.get('players-player-browser-grid').scrollTop, 90); assert.equal(ui.document.activeElement, retained); assert.equal(image.srcWrites.length, writes);
  ui.get('players-player-browser-hand-tab').fire('click'); await settle(); assert.equal(visible(ui)[0].dataset.face, 'front');
  state.players[0].isYou = false; area.setState(state); await settle(); assert.deepEqual(visible(ui).map(node => node.dataset.face), ['back', 'front', 'back']);
  state.players = state.players.filter(player => player.id !== 'alice'); area.setState(state);
  assert.equal(area.isBrowsing, false); assert.equal(area.root.inert, false); assert.equal(ui.document.activeElement, area.root); area.dispose();
});

test('player browser traps focus, supports tab keys and coordinates with hero preview without leaving nested inert states', async () => {
  const {ui, area} = await setup(); trigger(ui).focus(); trigger(ui).fire('click'); await settle();
  const close = ui.get('players-player-browser-close'); assert.equal(ui.document.activeElement, close);
  assert.equal(ui.key('Tab', {shiftKey: true}).defaultPrevented, true); assert.equal(ui.document.activeElement, visible(ui).at(-1));
  assert.equal(ui.key('Tab').defaultPrevented, true); assert.equal(ui.document.activeElement, close);
  ui.get('players-player-browser-hand-tab').fire('keydown', {key: 'End'}); assert.equal(browse(ui).dataset.zone, 'discard');
  assert.equal(ui.document.activeElement, ui.get('players-player-browser-discard-tab'));
  browse(ui).fire('click', {target: visible(ui)[0]}); assert.equal(area.isBrowsing, true);
  ui.key('Escape'); assert.equal(area.isBrowsing, false); assert.equal(area.root.inert, false); assert.equal(ui.document.activeElement, trigger(ui));
  area.openPlayer('alice'); area.openSupply('amazon'); assert.equal(area.browsingPlayerId, null); assert.equal(area.isBrowsing, true);
  area.openPlayer('alice'); assert.equal(ui.get('players-village-cards-browser').hidden, true); assert.equal(area.root.inert, true);
  area.closePlayer(); assert.equal(area.root.inert, false);
  area.openPlayer('bob', 'discard'); assert.equal(ui.get('players-player-browser-empty').hidden, false);
  browse(ui).fire('click'); assert.equal(area.isBrowsing, false); area.dispose();
});

test('invalid card/reveal snapshots are atomic and player-browser disposal removes modal, focus/Space handlers and card views', async () => {
  const {ui, area, state} = await setup(); area.openPlayer('alice'); await settle();
  const invalid = structuredClone(state); invalid.players[0].cards.hand[0].revealed = 'yes';
  assert.throws(() => area.setState(invalid), /boolean/); assert.equal(area.browsingPlayerId, 'alice');
  const duplicate = structuredClone(state); duplicate.players[0].cards.draw.push(card('h1', 'TS-1'));
  assert.throws(() => area.setState(duplicate), /unique/);
  const unknown = structuredClone(state); unknown.players[0].cards.hand[2].revealed = true;
  assert.throws(() => area.setState(unknown), /require a cardId/);
  visible(ui)[0].fire('pointerenter'); ui.key(' '); area.dispose();
  assert.equal(ui.get('overlays').children.length, 0); assert.equal(ui.get('host').children.length, 0);
  assert.equal(ui.key('Escape').defaultPrevented, false); assert.throws(() => area.openPlayer('alice'), /disposed/);
});

test('probe ignores clicks on yourself, allows inspecting opponents and demonstrates a timed reveal in their open hand', async () => {
  const ui = await page(), playerButton = index => ui.get('probe-player-list').children[1].children[index].children[0];
  playerButton(0).fire('click'); await settle();
  const grid = ui.get('public-probe-player-browser-grid'), entries = () => grid.children.filter(node => node.className === 'player-browser-entry').map(node => node.children[0]);
  assert.equal(ui.get('public-probe-player-browser').hidden, true);
  assert.equal(playerButton(0).disabled, true); assert.equal(playerButton(0).getAttribute('aria-haspopup'), null);
  await ui.click('draw-one'); playerButton(0).fire('click'); await settle();
  assert.equal(ui.cards().length, 7); assert.equal(ui.get('draw-count').textContent, '23');
  assert.equal(ui.get('public-probe-player-browser').hidden, true);
  playerButton(1).fire('click'); await settle(); assert.equal(entries().length, 3); ui.key('Escape');
  await ui.click('test-player-reveal'); assert.equal(entries()[0].dataset.face, 'back');
  const modal = ui.get('public-probe-player-browser'); await ui.advance(2000); assert.equal(entries()[0].dataset.face, 'front');
  assert.equal(entries()[2].dataset.face, 'back'); assert.equal(ui.get('public-probe-player-browser'), modal); assert.deepEqual(ui.requests, []);
  ui.key('Escape'); await ui.click('test-player-reveal'); ui.window.fire('pagehide', {persisted: false});
  await ui.advance(2000); assert.equal(ui.get('player-deck-overlays').children.length, 0); assert.equal(ui.timers.size, 0);
});
