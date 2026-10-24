import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';

const source = await readFile(new URL('../.test-dist/game-card-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="game"><section id="dungeon"></section><section id="village"></section><section id="deck"></section></main><div id="overlays"></div></body></html>';

test('any region can glow a physical card independently of hover, face changes and Alt inspection', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('dungeon').append(elements.button);
  const card = interactions.add(elements, '怪物'); await settle();
  card.setGlow(true); card.setFaceUp(false, false); elements.button.fire('pointerenter'); ui.key('Alt');
  assert.equal(elements.button.dataset.glowing, 'true'); assert.equal(elements.button.dataset.face, 'back');
  assert.equal(inspection.overlay.hidden, false); card.setGlow(false);
  assert.equal(elements.button.dataset.glowing, 'false'); assert.equal(inspection.overlay.hidden, false);
  assert.equal(elements.frontImage.decodeCalls, 1); assert.equal(elements.frontImage.srcWrites.length, 1);
  interactions.dispose(); inspection.dispose();
});

test('Alt inspection works for dungeon and village cards outside the player deck, with one active inspector across all regions', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(ui.get('overlays'));
  const interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const monster = api.createCardElements('TS-0592'), village = api.createCardElements('TS-0238');
  ui.get('dungeon').append(monster.button); ui.get('village').append(village.button);
  interactions.add(monster, '怪物'); const villageCard = interactions.add(village, '村庄牌', false);
  const deck = new api.PlayerDeckArea(ui.get('deck'), {idPrefix: 'deck', overlayRoot: ui.get('overlays'), background: [ui.get('game')]});
  deck.setState({hand: [{id: 'hero', cardId: 'TS-0001', name: '民兵'}], draw: [], discard: []}); await settle();
  monster.button.fire('pointerenter'); ui.key('Alt');
  assert.equal(inspection.overlay.hidden, false); assert.equal(monster.largeFront.hidden, false);
  assert.equal(monster.largeFront.width, 504); assert.equal(monster.largeBack.hidden, true);
  village.button.fire('pointerenter', {altKey: true});
  assert.equal(monster.inspection.hidden, true); assert.equal(village.inspection.hidden, false);
  assert.equal(village.largeFront.hidden, true); assert.equal(village.largeBack.hidden, false);
  assert.equal(village.largeBack.width, 501); assert.equal(inspection.content.dataset.face, 'back');
  ui.get('deck-first-card').fire('pointerenter', {altKey: true});
  assert.equal(inspection.overlay.hidden, true); assert.equal(ui.get('deck-inspect-overlay').hidden, false);
  monster.button.fire('pointerenter', {altKey: true});
  assert.equal(inspection.overlay.hidden, false); assert.equal(ui.get('deck-inspect-overlay').hidden, true);
  // A pile modal disables every underlying game region, not just the hand.
  deck.openPileBrowser('draw'); ui.key('Alt');
  assert.equal(inspection.overlay.hidden, true); assert.equal(ui.get('game').inert, true);
  ui.key('Escape'); ui.release();
  villageCard.setFaceUp(true, false); village.button.focus(); ui.key('Alt');
  assert.equal(village.largeFront.hidden, false); assert.equal(village.largeBack.hidden, true);
  assert.equal(village.frontImage.decodeCalls, 1); assert.equal(village.frontImage.srcWrites.length, 1);
  ui.release(); assert.equal(inspection.overlay.hidden, true);
  interactions.dispose(); inspection.dispose(); deck.dispose();
  assert.equal(ui.get('overlays').children.length, 0); assert.equal(ui.key('Alt').defaultPrevented, false);
});

test('shared inspection ignores hidden/disconnected cards and releases its image on blur or removal', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('dungeon').append(elements.button);
  interactions.add(elements, '民兵'); await settle(); elements.button.fire('pointerenter'); ui.key('Alt');
  assert.equal(inspection.overlay.hidden, false); ui.window.fire('blur'); assert.equal(inspection.overlay.hidden, true);
  ui.get('dungeon').hidden = true; elements.button.fire('pointerenter', {altKey: true}); ui.key('Alt');
  assert.equal(inspection.overlay.hidden, true);
  ui.get('dungeon').hidden = false; elements.button.fire('pointerenter', {altKey: true}); assert.equal(inspection.overlay.hidden, false);
  elements.button.remove(); interactions.refresh(); assert.equal(inspection.overlay.hidden, true);
  interactions.dispose(); inspection.dispose();
});
