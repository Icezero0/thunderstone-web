import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';

const source = await readFile(new URL('../.test-dist/game-card-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="game"><section id="dungeon"></section><section id="village"></section><section id="deck"></section></main><div id="overlays"></div></body></html>';

test('Alt inspection shows all current statuses beside the original image and scrolls them without leaking back-side information', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  const card = interactions.add(elements, '民兵'); await settle();
  elements.button.fire('pointerenter'); ui.key('Alt'); assert.equal(elements.statusPanel.hidden, true);
  const statuses = [{kind: 'buff', source_name: '应急干粮', description: '力量 +2'},
    {kind: 'debuff', source_name: '<script>text</script>', description: '力量 -1'},
    {kind: 'destroy', source_name: '远古泰尔', description: '本场战斗结束后摧毁'}];
  card.setStatuses(statuses);
  assert.equal(elements.statusPanel.hidden, false); assert.equal(elements.statusPanel.style.height, '704px');
  assert.equal(elements.statusPanel.children.length, 3); assert.match(elements.statusPanel.textContent, /应急干粮力量 \+2/);
  assert.match(elements.statusPanel.textContent, /<script>text<\/script>/);
  Object.defineProperties(elements.statusPanel, {scrollHeight: {get: () => 1600}, clientHeight: {get: () => 704}});
  elements.statusPanel.scrollTop = 0;
  assert.equal(ui.window.fire('wheel', {deltaY: 200}).defaultPrevented, true); assert.equal(elements.statusPanel.scrollTop, 200);
  card.setFaceUp(false, false); assert.equal(elements.statusPanel.hidden, true); assert.equal(elements.largeFront.hidden, true);
  assert.equal(elements.largeBack.hidden, false);
  card.setFaceUp(true, false); assert.equal(elements.statusPanel.hidden, false);
  card.setStatuses([]); assert.equal(elements.statusPanel.hidden, true); assert.equal(elements.statusPanel.children.length, 0);
  assert.equal(elements.largeFront.width, 504); assert.equal(elements.frontImage.srcWrites.length, 1);
  ui.release(); assert.equal(inspection.overlay.hidden, true); interactions.dispose(); inspection.dispose();
});

test('card status icons group by kind, show source/value tooltips at the pointer, and never trigger card actions', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  const card = interactions.add(elements, '民兵'); await settle();
  const statuses = [{kind: 'buff', source_name: '应急干粮', description: '力量 +2'},
    {kind: 'buff', source_name: '<img src=x>', description: '攻击 +1'}, {kind: 'debuff', source_name: '怪物', description: '力量 -1'},
    {kind: 'destroy', source_name: '远古泰尔', description: '本场战斗结束后摧毁'}];
  card.setStatuses(statuses);
  const badges = elements.button.children[0].children[1]; assert.equal(badges.children.length, 3);
  const buff = badges.children[0]; buff.fire('pointerenter', {clientX: 220, clientY: 180});
  const tooltip = () => ui.all.find(node => node.className === 'card-status-tooltip game-cursor' && node.isConnected);
  assert.match(tooltip().textContent, /应急干粮：力量 \+2/); assert.match(tooltip().textContent, /<img src=x>：攻击 \+1/);
  assert.equal(tooltip().children.some(node => node.tagName === 'img'), false); assert.equal(tooltip().style.left, '234px');
  buff.fire('pointermove', {clientX: 250, clientY: 210}); assert.equal(tooltip().style.left, '264px');
  assert.equal(buff.fire('click').propagationStopped, true); assert.equal(buff.fire('pointerdown').defaultPrevented, true);
  buff.fire('pointerleave'); assert.equal(tooltip(), undefined);
  badges.children[2].fire('focus'); assert.match(tooltip().textContent, /远古泰尔/);
  interactions.setSuspended(true); assert.equal(tooltip(), undefined);
  buff.fire('pointerenter'); assert.equal(tooltip(), undefined); interactions.setSuspended(false);
  card.setFaceUp(false, false); buff.fire('pointerenter'); assert.equal(tooltip(), undefined);
  card.setFaceUp(true, false); buff.fire('pointerenter'); assert.ok(tooltip()); ui.window.fire('blur'); assert.equal(tooltip(), undefined);
  card.setStatuses([]); assert.equal(badges.hidden, true); assert.equal(badges.children.length, 0);
  assert.equal(elements.frontImage.srcWrites.length, 1); interactions.dispose(); inspection.dispose();
});

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

for (const interruption of ['pointerleave', 'remove', 'scope', 'suspend', 'blur', 'hidden']) {
  test(`inspection consumes the Alt release after ${interruption}, so it cannot activate the browser menu`, async () => {
    const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
    const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
    const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
    const card = interactions.add(elements, '民兵'); await settle(); elements.button.fire('pointerenter');
    assert.equal(ui.key('Alt').defaultPrevented, true); assert.equal(inspection.overlay.hidden, false);
    if (interruption === 'pointerleave') elements.button.fire('pointerleave');
    if (interruption === 'remove') interactions.remove(card);
    if (interruption === 'scope') interactions.setScope(ui.get('village'));
    if (interruption === 'suspend') interactions.setSuspended(true);
    if (interruption === 'blur') ui.window.fire('blur');
    if (interruption === 'hidden') {ui.document.hidden = true; ui.document.fire('visibilitychange');}
    assert.equal(inspection.overlay.hidden, true);
    assert.equal(ui.release().defaultPrevented, true);
    assert.equal(ui.release().defaultPrevented, false, 'release ownership is cleared, not retained indefinitely');
    interactions.dispose(); inspection.dispose();
  });
}

test('Alt pressed before hovering is consumed on release even after leaving the card', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle();
  assert.equal(ui.key('Alt').defaultPrevented, false);
  elements.button.fire('pointerenter', {altKey: true}); assert.equal(inspection.overlay.hidden, false);
  elements.button.fire('pointerleave'); assert.equal(ui.release().defaultPrevented, true);
  elements.button.fire('pointerenter'); ui.key('Alt'); ui.window.fire('blur');
  assert.equal(ui.key('Alt').defaultPrevented, false, 'a fresh press after a missed keyup clears obsolete ownership');
  assert.equal(ui.release().defaultPrevented, false);
  elements.button.fire('pointermove'); ui.key('Alt'); assert.equal(inspection.overlay.hidden, false);
  ui.release(); interactions.dispose(); inspection.dispose();
});

test('inspection does not consume form input, IME or Alt combinations', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle(); elements.button.fire('pointerenter');
  const input = ui.document.createElement('input'); ui.get('game').append(input);
  for (const fields of [{target: input}, {isComposing: true}, {ctrlKey: true}, {metaKey: true}]) {
    assert.equal(ui.key('Alt', fields).defaultPrevented, false);
    assert.equal(inspection.overlay.hidden, true); assert.equal(ui.release().defaultPrevented, false);
  }
  input.focus(); elements.button.fire('pointermove', {altKey: true}); assert.equal(inspection.overlay.hidden, true);
  ui.document.activeElement = null;
  elements.button.fire('pointermove', {altKey: true, ctrlKey: true}); assert.equal(inspection.overlay.hidden, true);
  ui.key('Alt'); assert.equal(inspection.overlay.hidden, false);
  assert.equal(ui.key('f', {altKey: true}).defaultPrevented, false);
  assert.equal(inspection.overlay.hidden, true); assert.equal(ui.release().defaultPrevented, false);
  interactions.dispose(); inspection.dispose();
});
