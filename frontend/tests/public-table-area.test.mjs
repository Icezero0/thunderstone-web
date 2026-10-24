import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';
import {createDungeonDemo, createVillageDemo, createPublicPlayersDemo, takeDemoSupply} from '../.test-dist/probe-public-state.js';

const source = await readFile(new URL('../.test-dist/public-table-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="game"><div id="one"></div><div id="two"></div></main><div id="overlays"></div></body></html>';
const snapshot = () => ({dungeon: createDungeonDemo({spire: false, rankZero: false, rankFour: false}), village: createVillageDemo(), players: createPublicPlayersDemo()});
const top = slot => slot.children.find(node => node.className === 'physical-card' && !node.hidden);
const levels = (ui, prefix = 'first') => ui.get(`${prefix}-village-cards-browser-grid`).children;
async function setup(options = {}) {
  const ui = await page({html, source, width: 400}), api = ui.evaluate('PublicTablePackage');
  const area = new api.PublicTableArea(ui.get('one'), {overlayRoot: ui.get('overlays'), idPrefix: 'first', ...options});
  area.setState(snapshot()); await settle(); return {ui, api, area};
}
function size(ui, area, prefix = 'first') {
  for (const kind of ['dungeon', 'village']) {
    const desktop = ui.get(`${prefix}-${kind}-desktop`);
    Object.defineProperties(desktop, {scrollWidth: {get: () => 900}, scrollHeight: {get: () => 800}});
  }
  area.refresh();
}

test('the standalone public component owns all DOM and overlays, generates unique IDs and supports custom images', async () => {
  const ui = await page({html, source}), api = ui.evaluate('PublicTablePackage');
  const first = new api.PublicTableArea(ui.get('one'), {images: {front: id => `/custom/${id}.png`, back: '/custom/back.png'}});
  const second = new api.PublicTableArea(ui.get('two'), {initialTab: 'village'});
  first.setState(snapshot()); second.setState(snapshot()); await settle();
  assert.equal(first.activeTab, 'dungeon'); assert.equal(second.activeTab, 'village');
  assert.notEqual(first.root.id, second.root.id);
  const ids = ui.all.filter(node => node.isConnected && node.id).map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const area of [first, second]) {
    assert.equal(area.root.getAttribute('aria-label'), '公共游戏区域');
    const window = area.root.children[0]; assert.equal(window.getAttribute('aria-label'), '公共视窗');
    assert.equal(window.children[0].children.length, 1); // Tabs without a duplicate visible title.
    assert.equal(area.root.children[1].children[1].children.length, 3);
  }
  assert.ok(ui.all.some(node => node.tagName === 'img' && node.src === '/custom/TS-0354.png'));
  assert.deepEqual(ui.requests, []);
  first.dispose(); second.dispose();
  assert.equal(ui.get('one').children.length, 0); assert.equal(ui.get('two').children.length, 0);
  assert.equal(ui.document.body.children.length, 2); // Only the original main and overlay host remain.
});

test('a full snapshot is copied and validated atomically; player identities survive reorder and names remain plain text', async () => {
  const {ui, area} = await setup(), state = snapshot(); area.setState(state);
  const players = ui.get('first-players').children[1], alice = players.children[0], bob = players.children[1];
  state.players[0].name = 'Caller mutation'; state.village.piles[0].name = 'Caller mutation';
  assert.equal(alice.children[0].children[1].children[0].children[0].textContent, '玩家 1');
  assert.equal(ui.get('first-village-cards-pile-amazon').children[0].children[0].textContent, '亚马逊');
  const invalid = snapshot(); invalid.dungeon.dungeons[0].deckCount = 999; invalid.village.piles[0].cards[0].count = -1;
  assert.throws(() => area.setState(invalid), /non-negative/);
  assert.equal(ui.get('first-dungeon-cards-deck-main-slot').dataset.count, '27');
  const duplicate = snapshot(); duplicate.players.push({...duplicate.players[0]});
  assert.throws(() => area.setState(duplicate), /unique/);
  const updated = snapshot(); updated.players = [{id: 'player-2', name: '<b>玩家二</b>', isActive: true}, {id: 'player-1', name: '玩家一', isYou: true}];
  area.setState(updated);
  assert.equal(players.children[0], bob); assert.equal(players.children[1], alice);
  assert.equal(bob.children[0].children[1].children[0].children[0].textContent, '<b>玩家二</b>');
  assert.equal(bob.getAttribute('aria-current'), 'true'); assert.equal(alice.getAttribute('aria-current'), null);
  assert.equal(alice.children[0].children[0].textContent, ''); // Avatar has no list number.
  area.setState({...updated, players: []}); assert.equal(ui.get('first-players').hidden, true); assert.equal(area.root.dataset.hasPlayers, 'false');
  area.setState(snapshot()); assert.equal(ui.get('first-players').hidden, false); area.dispose();
});

test('the component preserves separate camera states, notifies real tab changes and resets only the active desktop', async () => {
  const changes = [], {ui, area} = await setup({onTabChange: tab => changes.push(tab)}); size(ui, area);
  const dungeon = ui.get('first-dungeon-panel'), village = ui.get('first-village-panel');
  dungeon.fire('wheel', {deltaY: -100, clientX: 200, clientY: 210});
  const dungeonView = ui.get('first-dungeon-desktop').style.transform;
  ui.get('first-village-tab').fire('click'); assert.equal(area.activeTab, 'village');
  village.fire('pointerdown', {buttons: 1, clientX: 200, clientY: 200});
  ui.window.fire('pointermove', {buttons: 1, clientX: 100, clientY: 100}); ui.window.fire('pointerup');
  const villageView = ui.get('first-village-desktop').style.transform;
  area.setState(snapshot()); assert.equal(ui.get('first-village-desktop').style.transform, villageView);
  area.setTab('dungeon'); assert.equal(ui.get('first-dungeon-desktop').style.transform, dungeonView);
  ui.get('first-reset-view').fire('click'); assert.equal(ui.get('first-dungeon-desktop').style.transform, 'translate(0px, 0px) scale(1.5)');
  assert.equal(ui.get('first-village-desktop').style.transform, villageView);
  area.setTab('dungeon'); assert.deepEqual(changes, ['village', 'dungeon']);
  const tab = ui.get('first-dungeon-tab'); tab.fire('keydown', {key: 'End'});
  assert.equal(ui.document.activeElement, ui.get('first-village-tab')); assert.equal(area.activeTab, 'village');
  assert.equal(ui.get('first-reset-view').getAttribute('aria-controls'), 'first-village-panel');
  assert.throws(() => area.setTab('invalid'), /Unknown/); assert.equal(area.activeTab, 'village'); area.dispose();
});

test('village stacks pan with the left button while hero and village-hero clicks still open their level preview', async () => {
  const {ui, area} = await setup(); size(ui, area); area.setTab('village');
  const viewport = ui.get('first-village-panel'), desktop = ui.get('first-village-desktop');
  // The fixture dispatches capture and target phases explicitly.
  const clickCard = card => {
    const event = viewport.fire('click', {target: card});
    if (!event.propagationStopped) card.fire('click');
    return event;
  };
  for (const id of ['amazon', 'village-thief', 'TS-0213', 'TS-0003']) {
    const card = top(ui.get(`first-village-cards-${id}-slot`));
    const image = ui.all.find(node => node.tagName === 'img' && card.contains(node));
    area.resetView(); const initial = desktop.style.transform;
    viewport.fire('pointerdown', {target: image, buttons: 1, clientX: 200, clientY: 200});
    assert.equal(viewport.captured.size, 0);
    ui.window.fire('pointermove', {buttons: 1, clientX: 198, clientY: 198}); ui.window.fire('pointerup');
    assert.equal(clickCard(card).defaultPrevented, false);
    assert.equal(area.isBrowsing, ['amazon', 'village-thief'].includes(id));
    area.closeBrowsers();
    card.fire('pointerenter'); ui.key('Alt'); assert.equal(ui.get('first-village-cards-inspect').hidden, false); ui.release();
    viewport.fire('pointerdown', {target: image, buttons: 1, clientX: 200, clientY: 200});
    ui.window.fire('pointermove', {buttons: 1, clientX: 100, clientY: 90});
    assert.equal(viewport.dataset.panning, 'true'); assert.notEqual(desktop.style.transform, initial);
    assert.equal(card.dataset.active, 'false'); ui.key('Alt'); assert.equal(ui.get('first-village-cards-inspect').hidden, true); ui.release();
    ui.window.fire('pointerup'); assert.equal(viewport.dataset.panning, 'false');
    assert.equal(clickCard(card).propagationStopped, true); assert.equal(area.isBrowsing, false);
    viewport.fire('pointerdown', {target: card, buttons: 1}); ui.window.fire('pointerup'); clickCard(card);
    assert.equal(area.isBrowsing, ['amazon', 'village-thief'].includes(id)); area.closeBrowsers();
  }
  // A supply update replaces the exposed hero card, which must remain pannable.
  const changed = snapshot(); changed.village.piles[0].cards[0].count = 0; area.setState(changed);
  const promoted = top(ui.get('first-village-cards-amazon-slot'));
  assert.equal(promoted.dataset.cardId, 'TS-0355');
  viewport.fire('pointerdown', {target: promoted, buttons: 1, clientX: 200, clientY: 200});
  ui.window.fire('pointermove', {buttons: 1, clientX: 140, clientY: 140});
  assert.equal(viewport.dataset.panning, 'true'); ui.window.fire('pointerup');
  assert.equal(clickCard(promoted).propagationStopped, true); assert.equal(area.isBrowsing, false);
  area.dispose();
});

test('environment, both dungeon decks and every hall rank pan without declaring a target on drag release', async () => {
  const clicked = [], {ui, area} = await setup({onHallCardClick: card => clicked.push(card.id)});
  const state = snapshot(); state.dungeon = createDungeonDemo({spire: true, rankZero: true, rankFour: true});
  area.setState(state); size(ui, area);
  const viewport = ui.get('first-dungeon-panel'), desktop = ui.get('first-dungeon-desktop');
  const targets = [{card: top(ui.get('first-dungeon-cards-environment-slot')), hall: false}];
  for (const lane of state.dungeon.dungeons) {
    targets.push({card: top(ui.get(`first-dungeon-cards-deck-${lane.id}-slot`)), hall: false});
    for (const slot of lane.hall) if (slot.card) targets.push({
      card: top(ui.get(`first-dungeon-cards-${lane.id}-rank-${slot.rank}`).children[1]), hall: true});
  }
  for (const {card, hall} of targets) {
    area.resetView(); const initial = desktop.style.transform, before = clicked.length;
    const image = ui.all.find(node => node.tagName === 'img' && card.contains(node));
    const click = () => {
      const event = viewport.fire('click', {target: card});
      if (!event.propagationStopped) card.fire('click');
      return event;
    };
    viewport.fire('pointerdown', {target: image, buttons: 1, clientX: 200, clientY: 200});
    assert.equal(viewport.captured.size, 0); ui.window.fire('pointerup'); click();
    assert.equal(clicked.length, before + Number(hall));
    viewport.fire('pointerdown', {target: image, buttons: 1, clientX: 200, clientY: 200});
    ui.window.fire('pointermove', {buttons: 1, clientX: 120, clientY: 100});
    assert.equal(viewport.dataset.panning, 'true'); assert.notEqual(desktop.style.transform, initial);
    ui.window.fire('pointerup'); assert.equal(click().propagationStopped, true);
    assert.equal(clicked.length, before + Number(hall)); assert.equal(area.isBrowsing, false);
  }
  area.dispose();
});

test('a live hero browser follows snapshots without reopening, keeps cached images and emits only the current supply top', async () => {
  let state = snapshot(), area; const taken = [];
  const setupResult = await setup({onTakeTop: selection => {
    taken.push(selection); state = {...state, village: takeDemoSupply(state.village, selection)}; area.setState(state);
  }});
  const ui = setupResult.ui; area = setupResult.area;
  area.openSupply('village-thief'); await settle(); assert.equal(area.activeTab, 'village'); assert.equal(area.isBrowsing, true);
  assert.equal(area.root.inert, true);
  const browser = ui.get('first-village-cards-browser'), preview = levels(ui)[1].children.find(node => node.className === 'physical-card');
  const images = ui.all.filter(node => node.tagName === 'img'); const loads = images.map(image => image.srcWrites.length);
  preview.fire('pointerenter'); ui.key('Alt'); assert.equal(ui.get('first-village-cards-inspect').hidden, false);
  ui.get('first-village-cards-browser-take').fire('click'); await settle();
  assert.equal(taken[0].cardId, 'TS-0301'); assert.equal(taken[0].pileId, 'village-thief');
  assert.equal(levels(ui)[0].children[3].textContent, '剩余 4 张');
  assert.equal(browser.hidden, false); assert.equal(ui.get('first-village-cards-inspect').hidden, false);
  assert.deepEqual(images.map(image => image.srcWrites.length), loads);
  ui.release(); ui.key('Escape'); assert.equal(area.isBrowsing, false); assert.equal(area.root.inert, false);
  state = {...state, village: {...state.village, piles: state.village.piles.map(pile => pile.id === 'village-thief' ? {...pile, cards: pile.cards.map(card => ({...card, count: card.level === 1 ? 0 : 3}))} : pile)}};
  area.setState(state); area.openSupply('village-thief'); await settle();
  assert.equal(levels(ui)[1].dataset.current, 'true');
  ui.get('first-village-cards-browser-take').fire('click'); await settle(); assert.equal(taken[1].cardId, 'TS-0300');
  area.setState({...state, village: {piles: []}}); assert.equal(area.isBrowsing, false); assert.equal(area.root.inert, false);
  area.dispose();
});

test('modal and hidden backgrounds cannot respond to tab/reset input, while host tab changes close a browser and restore inert state', async () => {
  const {ui, area} = await setup(); size(ui, area); area.openSupply('amazon');
  const tab = ui.get('first-dungeon-tab'); tab.fire('click'); tab.fire('keydown', {key: 'Home'});
  assert.equal(area.activeTab, 'village'); assert.equal(area.isBrowsing, true);
  area.setTab('dungeon'); assert.equal(area.isBrowsing, false); assert.equal(area.root.inert, false);
  area.root.hidden = true; ui.get('first-village-tab').fire('click'); assert.equal(area.activeTab, 'dungeon');
  area.root.hidden = false; ui.get('first-village-tab').fire('click'); assert.equal(area.activeTab, 'village'); area.dispose();
});

test('disposal releases capture, observers, modal and inspection without changing another component or accepting stale events', async () => {
  const {ui, area, api} = await setup(); size(ui, area);
  const other = new api.PublicTableArea(ui.get('two'), {idPrefix: 'second', overlayRoot: ui.get('overlays')});
  other.setState(snapshot()); await settle();
  const panel = ui.get('first-dungeon-panel'), desktop = ui.get('first-dungeon-desktop');
  panel.fire('pointerdown', {buttons: 1, clientX: 200, clientY: 200}); ui.window.fire('pointermove', {buttons: 1, clientX: 100, clientY: 100});
  assert.equal(panel.captured.size, 1); area.finish(); assert.equal(panel.captured.size, 0);
  area.openSupply('amazon'); await settle();
  const preview = levels(ui)[0].children.find(node => node.className === 'physical-card');
  preview.fire('pointerenter'); ui.key('Alt'); assert.equal(ui.get('first-village-cards-inspect').hidden, false);
  const committed = desktop.style.transform; area.dispose(); area.dispose();
  assert.equal(ui.get('one').children.length, 0); assert.equal(ui.get('first-overlays').isConnected, false);
  assert.ok(ui.observers.slice(0, 2).every(observer => observer.disconnected));
  assert.ok(ui.observers.slice(2).every(observer => !observer.disconnected));
  ui.observers[0].callback(); panel.fire('wheel', {deltaY: -100}); ui.get('first-village-tab').fire('click');
  assert.equal(desktop.style.transform, committed); assert.equal(other.activeTab, 'dungeon');
  other.openSupply('amazon'); assert.equal(other.isBrowsing, true);
  assert.throws(() => area.setState(snapshot()), /disposed/); assert.throws(() => area.setTab('village'), /disposed/);
  other.dispose(); assert.equal(ui.get('overlays').children.length, 0);
});
