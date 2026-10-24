import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';
import {copyDungeonState, copyVillageState, isHeroSupply, supplyCount, supplyTop} from '../.test-dist/table-area-model.js';
import {createDungeonDemo, createVillageDemo, takeDemoSupply} from '../.test-dist/probe-public-state.js';

const source = await readFile(new URL('../.test-dist/game-card-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="game"><div id="dungeon"></div><div id="village"></div><div id="deck"></div></main><div id="overlays"></div></body></html>';
const defaultDungeon = {spire: false, rankZero: false, rankFour: false};
const topCard = slot => slot.children.find(node => node.className === 'physical-card' && !node.hidden);
const browserCards = ui => ui.get('village-browser-grid').children.map(entry => entry.children.find(child => child.className === 'physical-card'));
const check = async (ui, id, value) => {ui.get(id).checked = value; ui.get(id).fire('change'); await settle();};
async function setup() {
  const ui = await page({html, source}); return {ui, api: ui.evaluate('GameCardPackage')};
}

test('dungeon normalization retains ranks 1–3, orders extra ranks, copies inputs and rejects invalid or repeated positions', () => {
  const state = {dungeons: [{id: 'main', name: '主地下城', deckCount: 0, hall: [{rank: 4, card: null}, {rank: 0, card: null}]}]};
  const normalized = copyDungeonState(state);
  assert.deepEqual(normalized.dungeons[0].hall.map(slot => slot.rank), [0, 1, 2, 3, 4]);
  assert.deepEqual(state.dungeons[0].hall.map(slot => slot.rank), [4, 0]);
  assert.throws(() => copyDungeonState({...state, dungeons: [{...state.dungeons[0], deckCount: -1}]}), /non-negative/);
  assert.throws(() => copyDungeonState({...state, dungeons: [{...state.dungeons[0], hall: [{rank: 1, card: null}, {rank: 1, card: null}]}]}), /unique/);
});

test('a dungeon displays only a back for its hidden deck, while public hall cards support Alt at original size', async () => {
  const {ui, api} = await setup(), area = new api.DungeonArea(ui.get('dungeon'), {idPrefix: 'dungeon', overlayRoot: ui.get('overlays')});
  area.setState(createDungeonDemo(defaultDungeon)); await settle();
  const deck = topCard(ui.get('dungeon-deck-main-slot'));
  assert.equal(ui.get('dungeon-deck-main-slot').parentElement.children[0].children[0].textContent, '地下城');
  assert.equal(deck.dataset.face, 'back'); assert.equal(deck.getAttribute('aria-haspopup'), null);
  assert.equal(deck.getAttribute('title'), null);
  deck.fire('pointerenter'); ui.key('Alt');
  const inspection = ui.get('dungeon-inspect-content').children.find(node => !node.hidden);
  assert.ok(inspection); assert.equal(inspection.children[0].src, '/cards/TS-BACK-001.jpg');
  assert.equal(inspection.children[0].hidden, true); assert.equal(inspection.children[1].hidden, false);
  ui.release(); deck.fire('pointerleave');
  const rank = ui.get('dungeon-main-rank-1'), monster = rank.children[1].children[0];
  monster.fire('pointerenter'); ui.key('Alt');
  assert.equal(ui.get('dungeon-inspect-content').dataset.face, 'front');
  assert.equal(ui.get('dungeon-inspect').hidden, false);
  assert.deepEqual(Array.from(ui.get('dungeon-lane-main').children[0].children[1].children).map(cell => cell.dataset.rank), ['3', '2', '1']);
  area.setState({dungeons: [{id: 'main', name: '主地下城', deckCount: 0, hall: []}]});
  assert.equal(ui.get('dungeon-inspect').hidden, true); assert.equal(topCard(ui.get('dungeon-deck-main-slot')), undefined);
  assert.equal(ui.get('dungeon-main-rank-1').children[1].children[0].textContent, '空阶层');
  area.dispose(); assert.equal(ui.get('dungeon').children.length, 0); assert.equal(ui.get('overlays').children.length, 0);
});

test('two independent halls and ranks 0/4 survive live layout changes without extra reserve piles', async () => {
  const {ui, api} = await setup(), area = new api.DungeonArea(ui.get('dungeon'), {idPrefix: 'dungeon'});
  const options = {spire: true, rankZero: true, rankFour: true};
  const state = createDungeonDemo(options); area.setState(state); await settle();
  const board = ui.get('dungeon-board'), lanes = board.children[0]; assert.equal(lanes.children.length, 2);
  for (const id of ['a', 'b']) for (const rank of [0, 1, 2, 3, 4]) {
    assert.equal(ui.get(`dungeon-${id}-rank-${rank}`).isConnected, true);
  }
  for (const id of ['a', 'b']) assert.deepEqual(Array.from(ui.get(`dungeon-lane-${id}`).children[0].children[1].children).map(cell => cell.dataset.rank), ['4', '3', '2', '1', '0']);
  assert.equal(board.children.length, 1);
  assert.equal(ui.get('dungeon-deck-a-slot').dataset.count, '27'); assert.equal(ui.get('dungeon-deck-b-slot').dataset.count, '19');
  state.dungeons[0].hall[0].card.name = 'Host mutation';
  assert.doesNotMatch(ui.get('dungeon-a-rank-1').children[1].children[0].getAttribute('aria-label'), /Host mutation/);
  area.setState(createDungeonDemo(defaultDungeon));
  assert.equal(lanes.children.length, 1);
  assert.equal(ui.get('dungeon-a-rank-0').isConnected, false);
  area.dispose(); assert.throws(() => area.setState(createDungeonDemo(defaultDungeon)), /disposed/);
});

test('hero supplies sort every level upward, expose the lowest stocked level and keep depleted levels available for preview', () => {
  const demo = createVillageDemo(), hero = demo.piles[0];
  const sorted = copyVillageState({piles: [{...hero, cards: [...hero.cards].reverse()}]}).piles[0];
  assert.deepEqual(sorted.cards.map(card => card.level), [1, 2, 3]); assert.equal(supplyTop(sorted).level, 1);
  const emptyLow = {...sorted, cards: sorted.cards.map(card => ({...card, count: card.level < 3 ? 0 : 2}))};
  assert.equal(supplyTop(emptyLow).level, 3); assert.equal(supplyCount(emptyLow), 2);
  assert.equal(emptyLow.cards.length, 3);
  const basic = demo.piles.find(pile => pile.kind === 'basic'); assert.equal(supplyCount(basic), null);
  assert.throws(() => copyVillageState({piles: [{...basic, cards: [{...basic.cards[0], count: 8}]}]}), /infinite/);
  assert.throws(() => copyVillageState({piles: [{...hero, cards: [{...hero.cards[0], count: -1}]}]}), /non-negative/);
});

test('the hero browser previews all levels, but its action always takes the current top and updates while staying open', async () => {
  const {ui, api} = await setup(); let state = createVillageDemo(); const taken = [];
  const area = new api.VillageArea(ui.get('village'), {idPrefix: 'village', background: [ui.get('game')], onTakeTop: selection => {
    taken.push(selection); state = takeDemoSupply(state, selection); area.setState(state);
  }});
  state = {...state, piles: state.piles.map(pile => pile.id === 'amazon' ? {...pile, cards: [...pile.cards].reverse().map(card => ({...card, count: card.level === 1 ? 1 : card.count}))} : pile)};
  area.setState(state); await settle(); area.openSupply('amazon'); await settle();
  assert.deepEqual(browserCards(ui).map(card => card.dataset.cardId), ['TS-0354', 'TS-0355', 'TS-0356']);
  const levels = ui.get('village-browser-grid').children;
  assert.deepEqual(levels.map(entry => entry.children[0].children[0].textContent), ['1 级', '2 级', '3 级']);
  assert.deepEqual(levels.map(entry => entry.children[1].textContent), ['亚马逊弓箭手', '亚马逊女猎手', '亚马逊女王']);
  assert.deepEqual(levels.map(entry => entry.dataset.current), ['true', 'false', 'false']);
  assert.equal(levels[0].children[0].children[1].textContent, '当前顶牌');
  const preview = browserCards(ui)[2]; preview.fire('pointerenter'); ui.key('Alt');
  assert.equal(ui.get('village-inspect').hidden, false); assert.match(ui.get('village-browser-take').textContent, /弓箭手/);
  ui.get('village-browser-take').fire('click'); await settle();
  assert.equal(taken[0].level, 1); assert.equal(taken[0].cardId, 'TS-0354');
  assert.equal(area.isBrowsing, true); assert.equal(ui.get('game').inert, true);
  assert.equal(ui.get('village-pile-amazon').dataset.topLevel, '2');
  assert.match(ui.get('village-browser-take').textContent, /女猎手/);
  assert.equal(levels[0].children[3].textContent, '剩余 0 张');
  assert.equal(levels[0].children[0].children[1].textContent, '已售罄');
  assert.equal(levels[1].children[0].children[1].textContent, '当前顶牌');
  assert.deepEqual(levels.map(entry => entry.dataset.current), ['false', 'true', 'false']);
  assert.equal(ui.get('village-inspect').hidden, false);
  ui.release(); ui.key('Escape');
  assert.equal(ui.document.activeElement.dataset.cardId, 'TS-0355'); assert.equal(ui.get('game').inert, false);
  area.openSupply('phalanx'); assert.equal(browserCards(ui).length, 2); ui.key('Escape');
  area.openSupply('krell'); assert.equal(browserCards(ui).length, 4);
  area.dispose(); assert.equal(ui.key('Escape').defaultPrevented, false);
});

test('non-hero supplies ignore clicks but retain hover and Alt; infinite basics keep their thickness after external takes', async () => {
  const {ui, api} = await setup(); let state = createVillageDemo();
  const area = new api.VillageArea(ui.get('village'), {idPrefix: 'village', onTakeTop: () => {throw new Error('Non-hero clicks cannot take cards');}});
  area.setState(state); await settle();
  const basic = ui.get('village-TS-0003-slot'), village = ui.get('village-TS-0238-slot');
  assert.equal(basic.dataset.layers, '4'); assert.equal(village.dataset.layers, '2'); assert.equal(basic.dataset.count, 'infinite');
  assert.equal(basic.parentElement.children[0].children[1].textContent, '∞');
  for (const pile of state.piles.filter(pile => !isHeroSupply(pile))) {
    const card = topCard(ui.get(`village-${pile.id}-slot`));
    assert.equal(card.getAttribute('aria-haspopup'), null);
    card.fire('click'); area.openSupply(pile.id); assert.equal(area.isBrowsing, false);
    card.fire('pointerenter'); assert.equal(card.dataset.active, 'true');
    ui.key('Alt'); assert.equal(ui.get('village-inspect').hidden, false);
    ui.release(); card.fire('pointerleave');
  }
  const before = topCard(basic);
  for (let index = 0; index < 5; index++) {
    state = takeDemoSupply(state, {pileId: 'TS-0003', cardId: 'TS-0003'}); area.setState(state); await settle();
  }
  assert.equal(topCard(basic), before); assert.equal(basic.dataset.count, 'infinite');
  assert.equal(basic.dataset.layers, '4');
  assert.equal(ui.get('village-browser').hidden, true);
  const depleted = state.piles.find(pile => pile.kind === 'village' && !isHeroSupply(pile));
  area.setState({piles: [{...depleted, cards: depleted.cards.map(card => ({...card, count: 0}))}]});
  const empty = ui.get(`village-${depleted.id}-slot`).children.find(node => node.className === 'pile-empty');
  assert.equal(empty.disabled, true); assert.equal(empty.getAttribute('aria-haspopup'), null);
  empty.fire('click'); assert.equal(area.isBrowsing, false);
  const sourceHero = state.piles[0]; assert.throws(() => takeDemoSupply(state, {pileId: sourceHero.id, cardId: sourceHero.cards[1].cardId}), /exposed/);
  area.dispose();
});

test('village heroes form one pile with five level-1 cards above three level-2 cards and update the open preview', async () => {
  const {ui, api} = await setup();
  const original = createVillageDemo().piles.find(pile => pile.id === 'village-thief');
  let state = {piles: [{...original, cards: [...original.cards].reverse()}]};
  const taken = [], area = new api.VillageArea(ui.get('village'), {idPrefix: 'village', onTakeTop: selection => {
    taken.push(selection); state = takeDemoSupply(state, selection); area.setState(state);
  }});
  area.setState(state); await settle();
  const slot = ui.get('village-village-thief-slot'), cutpurse = topCard(slot), pile = slot.parentElement;
  assert.equal(cutpurse.dataset.cardId, 'TS-0301'); assert.equal(cutpurse.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(pile.dataset.kind, 'village'); assert.equal(pile.parentElement.parentElement.dataset.kind, 'village');
  assert.equal(pile.parentElement.children.length, 1); assert.equal(pile.children[0].children[1].textContent, '8');
  assert.throws(() => takeDemoSupply(state, {pileId: 'village-thief', cardId: 'TS-0300'}), /exposed/);
  cutpurse.fire('click'); await settle();
  assert.deepEqual(browserCards(ui).map(card => card.dataset.cardId), ['TS-0301', 'TS-0300']);
  assert.equal(ui.get('village-browser-title').textContent, '村庄盗贼');
  const levels = ui.get('village-browser-grid').children;
  assert.deepEqual(levels.map(entry => entry.children[0].children[0].textContent), ['1 级', '2 级']);
  assert.deepEqual(levels.map(entry => entry.dataset.current), ['true', 'false']);
  assert.deepEqual(levels.map(entry => entry.children[3].textContent), ['剩余 5 张', '剩余 3 张']);
  browserCards(ui)[1].fire('pointerenter'); ui.key('Alt');
  assert.equal(ui.get('village-inspect').hidden, false);
  for (let index = 0; index < 5; index++) {
    assert.match(ui.get('village-browser-take').textContent, /村庄扒手/);
    assert.equal(topCard(slot).dataset.cardId, 'TS-0301');
    ui.get('village-browser-take').fire('click'); await settle();
    assert.equal(taken[index].cardId, 'TS-0301'); assert.equal(taken[index].pileId, 'village-thief');
    assert.equal(slot.dataset.count, String(7 - index));
  }
  assert.equal(topCard(slot).dataset.cardId, 'TS-0300'); assert.equal(pile.dataset.topLevel, '2');
  assert.deepEqual(levels.map(entry => entry.children[3].textContent), ['剩余 0 张', '剩余 3 张']);
  assert.deepEqual(levels.map(entry => entry.dataset.current), ['false', 'true']);
  assert.equal(ui.get('village-inspect').hidden, false); ui.release();
  ui.key('Escape'); assert.equal(ui.document.activeElement, topCard(slot));
  topCard(slot).fire('click'); await settle();
  for (let index = 0; index < 3; index++) {
    assert.match(ui.get('village-browser-take').textContent, /村庄强盗/);
    ui.get('village-browser-take').fire('click'); await settle();
    assert.equal(taken[index + 5].cardId, 'TS-0300');
  }
  assert.equal(slot.dataset.count, '0'); assert.equal(topCard(slot), undefined);
  assert.equal(area.isBrowsing, true); assert.equal(ui.get('village-browser-take').disabled, true);
  assert.deepEqual(ui.get('village-browser-grid').children.map(entry => entry.children[0].children[1].textContent), ['已售罄', '已售罄']);
  ui.key('Escape');
  const empty = slot.children.find(node => node.className === 'pile-empty');
  empty.fire('click'); assert.equal(browserCards(ui).length, 2); area.dispose();
});

test('hero tags enable ordered multi-level village supplies without enabling basic militia or ordinary mixed piles', () => {
  const demo = createVillageDemo(), villageHeroes = demo.piles.filter(pile => pile.id === 'village-thief');
  const copied = copyVillageState({piles: villageHeroes});
  villageHeroes[0].cards[0].tags.pop(); assert.equal(copied.piles[0].cards[0].tags.includes('村庄'), true);
  for (const pile of copied.piles) assert.equal(isHeroSupply(pile), true);
  const militia = {...demo.piles.find(pile => pile.id === 'TS-0001'), cards: [{cardId: 'TS-0001', name: '民兵', count: null, level: 0, tags: ['英雄']}]};
  assert.equal(isHeroSupply(copyVillageState({piles: [militia]}).piles[0]), false);
  const ordinary = demo.piles.find(pile => pile.id === 'TS-0238');
  assert.equal(isHeroSupply({...ordinary, cards: [{...ordinary.cards[0], level: 1}]}), false);
  assert.throws(() => copyVillageState({piles: [{...ordinary, cards: [{...ordinary.cards[0]}, {...copied.piles[0].cards[1]}]}]}), /Only hero/);
  assert.throws(() => copyVillageState({piles: copied.piles.map(pile => ({...pile, cards: pile.cards.map(card => ({...card, level: 1}))}))}), /unique/);
  const veteran = {id: 'veteran', name: '精锐民兵', kind: 'village', cards: [{cardId: 'TS-0261', name: '精锐民兵', count: 8, level: 0, tags: ['民兵', '英雄', '村庄']}]};
  assert.equal(copyVillageState({piles: [veteran]}).piles[0].cards[0].level, 0);
  assert.throws(() => copyVillageState({piles: [{...copied.piles[0], cards: [{...copied.piles[0].cards[0], level: -1}]}]}), /valid level/);
  assert.throws(() => copyVillageState({piles: [{...demo.piles[0], cards: [{...demo.piles[0].cards[0], level: 0}]}]}), /valid level/);
});

test('the probe has one village-thief pile whose exposed level changes after five demo takes', async () => {
  const ui = await page(); await ui.click('village-tab');
  const slot = ui.get('village-probe-village-thief-slot');
  assert.equal(slot.dataset.count, '8'); assert.equal(topCard(slot).dataset.cardId, 'TS-0301');
  for (const id of ['TS-0301', 'TS-0300']) {
    topCard(slot).fire('click'); await settle();
    assert.equal(ui.get('village-probe-browser').hidden, false);
    assert.deepEqual(ui.get('village-probe-browser-grid').children.map(entry => entry.children[1].textContent), ['村庄扒手', '村庄强盗']);
    ui.key('Escape');
    if (id === 'TS-0301') {
      ui.get('take-supply-id').value = 'village-thief';
      for (let index = 0; index < 5; index++) await ui.click('take-supply-top');
      assert.equal(slot.dataset.count, '3'); assert.equal(topCard(slot).dataset.cardId, 'TS-0300');
    }
  }
  await ui.click('reset-supplies'); assert.equal(slot.dataset.count, '8'); assert.equal(topCard(slot).dataset.cardId, 'TS-0301');
  ui.window.fire('pagehide', {persisted: false});
});

test('a supply kind change closes a hero preview and updates its click semantics in both directions', async () => {
  const {ui, api} = await setup(), area = new api.VillageArea(ui.get('village'), {idPrefix: 'village'});
  const original = createVillageDemo().piles[0], hero = {...original, cards: [original.cards[0]]};
  area.setState({piles: [hero]}); await settle();
  const card = topCard(ui.get('village-amazon-slot'));
  card.fire('click'); assert.equal(area.isBrowsing, true);
  area.setState({piles: [{...hero, kind: 'village'}]});
  assert.equal(area.isBrowsing, false); assert.equal(area.root.inert, false);
  assert.equal(card.getAttribute('aria-haspopup'), null);
  card.fire('click'); assert.equal(area.isBrowsing, false);
  area.setState({piles: [hero]});
  assert.equal(card.getAttribute('aria-haspopup'), 'dialog');
  card.fire('click'); assert.equal(area.isBrowsing, true); area.dispose();
});

test('sold-out hero piles still open the full level browser, external removal releases the modal and invalid updates are atomic', async () => {
  const {ui, api} = await setup(), area = new api.VillageArea(ui.get('village'), {idPrefix: 'village', onTakeTop: () => {throw new Error('Empty pile cannot be taken');}});
  const original = createVillageDemo().piles[0], hero = {...original, cards: original.cards.map(card => ({...card, count: 0}))};
  area.setState({piles: [hero]}); await settle();
  const empty = ui.get('village-amazon-slot').children.find(node => node.className === 'pile-empty');
  empty.fire('click'); await settle(); assert.equal(browserCards(ui).length, 3);
  assert.equal(ui.get('village-browser-take').disabled, true); ui.get('village-browser-take').fire('click');
  assert.throws(() => area.setState({piles: [hero, hero]}), /unique/); assert.equal(area.isBrowsing, true);
  area.setState({piles: []}); assert.equal(area.isBrowsing, false); assert.equal(area.root.inert, false);
  assert.equal(ui.document.activeElement, area.root); area.dispose();
});

test('supply modal traps focus, dismisses on backdrop and hides unrelated dungeon and player inspectors', async () => {
  const {ui, api} = await setup(), options = {overlayRoot: ui.get('overlays'), background: [ui.get('game')]};
  const village = new api.VillageArea(ui.get('village'), {...options, idPrefix: 'village'});
  const dungeon = new api.DungeonArea(ui.get('dungeon'), {...options, idPrefix: 'dungeon'});
  const deck = new api.PlayerDeckArea(ui.get('deck'), {...options, idPrefix: 'deck'});
  dungeon.setState(createDungeonDemo(defaultDungeon)); village.setState(createVillageDemo());
  deck.setState({hand: [{id: 'h', cardId: 'TS-0001', name: '民兵'}], draw: [], discard: []}); await settle();
  const monster = ui.get('dungeon-main-rank-1').children[1].children[0]; monster.fire('pointerenter'); ui.key('Alt');
  assert.equal(ui.get('dungeon-inspect').hidden, false);
  village.openSupply('amazon'); ui.key('Alt'); assert.equal(ui.get('dungeon-inspect').hidden, true);
  ui.get('deck-first-card').fire('pointerenter', {altKey: true}); assert.equal(ui.get('deck-inspect-overlay').hidden, true);
  assert.equal(ui.key('Tab', {shiftKey: true}).defaultPrevented, true);
  assert.equal(ui.document.activeElement, browserCards(ui).at(-1));
  assert.equal(ui.key('Tab').defaultPrevented, true); assert.equal(ui.document.activeElement, ui.get('village-browser-close'));
  ui.get('village-browser').fire('click', {target: browserCards(ui)[0]}); assert.equal(village.isBrowsing, true);
  ui.get('village-browser').fire('click'); assert.equal(village.isBrowsing, false); assert.equal(ui.get('game').inert, false);
  village.dispose(); dungeon.dispose(); deck.dispose(); assert.equal(ui.get('overlays').children.length, 0);
});

test('game-probe switches dungeon scenarios and takes an infinite supply into the player discard without reducing stock', async () => {
  const ui = await page();
  ui.get('dungeon-demo-layout').value = 'spire'; ui.get('dungeon-demo-layout').fire('change');
  for (const id of ['show-rank-zero', 'show-rank-four']) await check(ui, id, true);
  assert.equal(ui.get('dungeon-probe-lane-a').isConnected, true); assert.equal(ui.get('dungeon-probe-lane-b').isConnected, true);
  assert.equal(ui.get('dungeon-probe-a-rank-0').isConnected, true); assert.equal(ui.get('dungeon-probe-b-rank-4').isConnected, true);
  await ui.click('village-tab');
  ui.get('take-supply-id').value = 'TS-0002'; await ui.click('take-supply-top');
  topCard(ui.get('village-probe-TS-0002-slot')).fire('click'); await settle();
  assert.equal(ui.get('discard-count').textContent, '9');
  assert.equal(ui.get('village-probe-TS-0002-slot').dataset.count, 'infinite');
  assert.equal(topCard(ui.get('discard-pile')).dataset.cardId, 'TS-0002'); assert.equal(ui.get('village-probe-browser').hidden, true);
  ui.window.fire('pagehide', {persisted: false});
  assert.equal(ui.get('dungeon-area').children.length, 0); assert.equal(ui.get('village-area').children.length, 0);
  assert.equal(ui.get('player-deck-overlays').children.length, 0);
});

test('public tabs switch separate desktops, retain inventory and images and leave the player deck fixed', async () => {
  const ui = await page(), hand = ui.get('probe-card');
  assert.equal(ui.get('dungeon-panel').hidden, false); assert.equal(ui.get('village-panel').hidden, true);
  assert.equal(ui.get('dungeon-tab').getAttribute('aria-selected'), 'true');
  assert.equal(ui.get('village-tab').tabIndex, -1);
  await check(ui, 'show-rank-zero', true);
  const monster = ui.get('dungeon-probe-main-rank-1').children[1].children[0];
  monster.fire('pointerenter'); ui.key('Alt'); assert.equal(ui.get('dungeon-probe-inspect').hidden, false);
  await ui.click('village-tab');
  assert.equal(ui.get('dungeon-probe-inspect').hidden, true); assert.equal(ui.get('dungeon-panel').hidden, true);
  assert.equal(ui.get('village-panel').hidden, false); assert.equal(ui.get('village-tab').getAttribute('aria-selected'), 'true');
  assert.equal(ui.get('village-desktop').style.transform, 'translate(56px, 0px) scale(1.5)');
  ui.release();
  const top = topCard(ui.get('village-probe-TS-0238-slot'));
  ui.get('take-supply-id').value = 'TS-0238'; await ui.click('take-supply-top');
  assert.equal(ui.get('village-probe-TS-0238-slot').dataset.count, '7');
  await ui.click('dungeon-tab'); assert.equal(ui.get('show-rank-zero').checked, true);
  assert.equal(ui.get('dungeon-probe-main-rank-0').isConnected, true);
  await ui.click('village-tab');
  assert.equal(ui.get('village-probe-TS-0238-slot').dataset.count, '7');
  assert.equal(topCard(ui.get('village-probe-TS-0238-slot')), top);
  assert.equal(ui.get('probe-card'), hand); assert.equal(hand.hidden, false); assert.equal(ui.get('discard-count').textContent, '9');
});

test('public tabs support arrow/Home/End navigation and remove their handlers on page disposal', async () => {
  const ui = await page(), dungeon = ui.get('dungeon-tab'), village = ui.get('village-tab');
  dungeon.focus(); assert.equal(dungeon.fire('keydown', {key: 'ArrowRight'}).defaultPrevented, true);
  assert.equal(ui.document.activeElement, village); assert.equal(village.tabIndex, 0); assert.equal(dungeon.tabIndex, -1);
  assert.equal(village.fire('keydown', {key: 'ArrowLeft', altKey: true}).defaultPrevented, false);
  assert.equal(village.getAttribute('aria-selected'), 'true');
  village.fire('keydown', {key: 'Home'}); assert.equal(ui.document.activeElement, dungeon); assert.equal(ui.get('dungeon-panel').hidden, false);
  dungeon.fire('keydown', {key: 'End'}); assert.equal(ui.document.activeElement, village); assert.equal(ui.get('village-panel').hidden, false);
  ui.window.fire('pagehide', {persisted: false});
  assert.equal(village.fire('keydown', {key: 'ArrowLeft'}).defaultPrevented, false);
  dungeon.fire('click'); assert.equal(village.getAttribute('aria-selected'), 'true');
});

test('village supplies form hero, village and basic rows, with a name followed by the count above each pile', async () => {
  const {ui, api} = await setup(), area = new api.VillageArea(ui.get('village'), {idPrefix: 'village'});
  area.setState(createVillageDemo()); await settle();
  const groups = area.root.children[0].children;
  assert.deepEqual(Array.from(groups).map(group => group.dataset.kind), ['hero', 'village', 'basic']);
  assert.deepEqual(Array.from(groups).map(group => group.children[0].children.length), [4, 8, 4]);
  for (const group of groups) {
    assert.ok(group.getAttribute('aria-label')); assert.equal(group.children.length, 1);
    for (const pile of group.children[0].children) {
      assert.ok(pile.getAttribute('aria-label')); assert.equal(pile.children.length, 2);
      const heading = pile.children[0]; assert.equal(heading.children.length, 2);
      assert.equal(heading.children[0].textContent, pile.getAttribute('aria-label'));
      assert.match(heading.children[1].textContent, /^(\d+|∞)$/);
    }
  }
  area.dispose();
});

test('a separate environment container has a heading, hides completely without a card and supports live updates and Alt', async () => {
  const {ui, api} = await setup(), area = new api.DungeonArea(ui.get('dungeon'), {idPrefix: 'dungeon'});
  area.setState(createDungeonDemo(defaultDungeon)); await settle();
  const slot = ui.get('dungeon-environment-slot');
  assert.equal(area.root.children[0], ui.get('dungeon-environment'));
  const container = ui.get('dungeon-environment'), board = ui.get('dungeon-board');
  assert.equal(container.hidden, true); assert.equal(slot.children.length, 0);
  assert.equal(container.parentElement, board.parentElement); assert.equal(board.contains(container), false);
  assert.equal(ui.get('dungeon-environment-heading').textContent, '环境');
  assert.equal(area.root.dataset.hasEnvironment, 'false');
  assert.equal(area.root.getAttribute('aria-label'), '地下城');
  assert.equal(ui.get('dungeon-lane-main').children.length, 1); // No duplicate region/lane titles.
  const state = createDungeonDemo({...defaultDungeon, spire: true}); area.setState(state); await settle();
  const environment = slot.children[0]; assert.equal(environment.dataset.cardId, 'TS-0198');
  assert.equal(container.hidden, false); assert.equal(area.root.dataset.hasEnvironment, 'true');
  assert.equal(board.children[0].children.length, 2);
  assert.equal(ui.all.filter(node => node.className === 'table-area dungeon-environment' && node.isConnected).length, 1);
  state.environment.name = 'Caller mutation'; assert.doesNotMatch(environment.getAttribute('aria-label'), /Caller mutation/);
  environment.fire('pointerenter'); ui.key('Alt'); assert.equal(ui.get('dungeon-inspect').hidden, false);
  assert.throws(() => area.setState({...state, environment: {...state.environment, id: state.dungeons[0].hall[0].card.id}}), /unique/);
  assert.equal(slot.children[0], environment); // Invalid updates do not alter the displayed environment.
  area.setState(createDungeonDemo({...defaultDungeon, forest: true})); await settle();
  assert.equal(slot.children[0].dataset.cardId, 'TS-0193'); assert.equal(ui.get('dungeon-inspect').hidden, true);
  ui.release();
  area.setState(createDungeonDemo(defaultDungeon)); assert.equal(slot.children.length, 0); assert.equal(container.hidden, true);
  area.setState(createDungeonDemo({...defaultDungeon, spire: true})); await settle();
  assert.equal(slot.children[0], environment); assert.ok(environment.children.length);
  area.dispose();
});

test('the public window has tabs without a visible title, and the external scene picker previews ordinary or shared environments', async () => {
  const ui = await page(), frame = ui.get('public-table-viewport').parentElement;
  assert.equal(frame.getAttribute('aria-label'), '公共视窗');
  assert.equal(frame.children[0].children.length, 1); assert.equal(frame.children[0].children[0].getAttribute('role'), 'tablist');
  const scene = ui.get('dungeon-demo-layout'); scene.value = 'forest'; scene.fire('change'); await settle();
  assert.equal(ui.get('dungeon-probe-environment-slot').children[0].dataset.cardId, 'TS-0193');
  scene.value = 'spire'; scene.fire('change'); await settle();
  assert.equal(ui.get('dungeon-probe-environment-slot').children[0].dataset.cardId, 'TS-0198');
  scene.value = 'classic'; scene.fire('change'); await settle();
  assert.equal(ui.get('dungeon-probe-environment-slot').children.length, 0);
  assert.equal(ui.get('dungeon-probe-environment').hidden, true);
  ui.window.fire('pagehide', {persisted: false});
});
