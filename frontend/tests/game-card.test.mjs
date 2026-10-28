import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';

const source = await readFile(new URL('../.test-dist/game-card-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="game"><section id="dungeon"></section><section id="village"></section><section id="deck"></section></main><div id="overlays"></div></body></html>';

test('Space inspection shows all current statuses beside the original image and scrolls them without leaking back-side information', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  const card = interactions.add(elements, '民兵'); await settle();
  elements.button.fire('pointerenter'); ui.key(' '); assert.equal(elements.statusPanel.hidden, true);
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

test('any region can glow a physical card independently of hover, face changes and Space inspection', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('dungeon').append(elements.button);
  const card = interactions.add(elements, '怪物'); await settle();
  card.setGlow(true); card.setFaceUp(false, false); elements.button.fire('pointerenter'); ui.key(' ');
  assert.equal(elements.button.dataset.glowing, 'true'); assert.equal(elements.button.dataset.face, 'back');
  assert.equal(inspection.overlay.hidden, false); card.setGlow(false);
  assert.equal(elements.button.dataset.glowing, 'false'); assert.equal(inspection.overlay.hidden, false);
  assert.equal(elements.frontImage.decodeCalls, 1); assert.equal(elements.frontImage.srcWrites.length, 1);
  interactions.dispose(); inspection.dispose();
});

test('Space inspection works for dungeon and village cards outside the player deck, with one active inspector across all regions', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(ui.get('overlays'));
  const interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const monster = api.createCardElements('TS-0592'), village = api.createCardElements('TS-0238');
  ui.get('dungeon').append(monster.button); ui.get('village').append(village.button);
  interactions.add(monster, '怪物'); const villageCard = interactions.add(village, '村庄牌', false);
  const deck = new api.PlayerDeckArea(ui.get('deck'), {idPrefix: 'deck', overlayRoot: ui.get('overlays'), background: [ui.get('game')]});
  deck.setState({hand: [{id: 'hero', cardId: 'TS-0001', name: '民兵'}], draw: [], discard: []}); await settle();
  monster.button.fire('pointerenter'); ui.key(' ');
  assert.equal(inspection.overlay.hidden, false); assert.equal(monster.largeFront.hidden, false);
  assert.equal(monster.largeFront.width, 504); assert.equal(monster.largeBack.hidden, true);
  village.button.fire('pointerenter');
  assert.equal(monster.inspection.hidden, true); assert.equal(village.inspection.hidden, false);
  assert.equal(village.largeFront.hidden, true); assert.equal(village.largeBack.hidden, false);
  assert.equal(village.largeBack.width, 501); assert.equal(inspection.content.dataset.face, 'back');
  ui.get('deck-first-card').fire('pointerenter');
  assert.equal(inspection.overlay.hidden, true); assert.equal(ui.get('deck-inspect-overlay').hidden, false);
  monster.button.fire('pointerenter');
  assert.equal(inspection.overlay.hidden, false); assert.equal(ui.get('deck-inspect-overlay').hidden, true);
  // A pile modal disables every underlying game region, not just the hand.
  deck.openPileBrowser('draw'); ui.key(' ');
  assert.equal(inspection.overlay.hidden, true); assert.equal(ui.get('game').inert, true);
  ui.key('Escape'); ui.release();
  villageCard.setFaceUp(true, false); ui.key('Tab'); village.button.focus(); ui.key(' ');
  assert.equal(village.largeFront.hidden, false); assert.equal(village.largeBack.hidden, true);
  assert.equal(village.frontImage.decodeCalls, 1); assert.equal(village.frontImage.srcWrites.length, 1);
  ui.release(); assert.equal(inspection.overlay.hidden, true);
  interactions.dispose(); inspection.dispose(); deck.dispose();
  assert.equal(ui.get('overlays').children.length, 0); assert.equal(ui.key(' ').defaultPrevented, false);
});

test('shared inspection ignores hidden/disconnected cards and releases its image on blur or removal', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('dungeon').append(elements.button);
  interactions.add(elements, '民兵'); await settle(); elements.button.fire('pointerenter'); ui.key(' ');
  assert.equal(inspection.overlay.hidden, false); ui.window.fire('blur'); assert.equal(inspection.overlay.hidden, true);
  ui.get('dungeon').hidden = true; elements.button.fire('pointerenter'); ui.key(' ');
  assert.equal(inspection.overlay.hidden, true);
  ui.get('dungeon').hidden = false; elements.button.fire('pointerenter'); assert.equal(inspection.overlay.hidden, false);
  elements.button.remove(); interactions.refresh(); assert.equal(inspection.overlay.hidden, true);
  interactions.dispose(); inspection.dispose();
});

for (const interruption of ['pointerleave', 'remove', 'scope', 'suspend', 'blur', 'hidden']) {
  test(`inspection consumes the Space release after ${interruption}, so it cannot click a card or scroll`, async () => {
    const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
    const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
    const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
    const card = interactions.add(elements, '民兵'); await settle(); elements.button.fire('pointerenter');
    assert.equal(ui.key(' ').defaultPrevented, true); assert.equal(inspection.overlay.hidden, false);
    if (interruption === 'pointerleave') elements.button.fire('pointerleave');
    if (interruption === 'remove') interactions.remove(card);
    if (interruption === 'scope') interactions.setScope(ui.get('village'));
    if (interruption === 'suspend') interactions.setSuspended(true);
    if (interruption === 'blur') ui.window.fire('blur');
    if (interruption === 'hidden') {ui.document.hidden = true; ui.document.fire('visibilitychange');}
    assert.equal(inspection.overlay.hidden, true);
    assert.equal(ui.key(' ', {repeat: true}).defaultPrevented, true, 'held repeats must not scroll after interruption');
    assert.equal(ui.release().defaultPrevented, true);
    assert.equal(ui.release().defaultPrevented, false, 'release ownership is cleared, not retained indefinitely');
    interactions.dispose(); inspection.dispose();
  });
}

test('Space pressed before hovering is consumed on release even after leaving the card', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle();
  assert.equal(ui.key(' ').defaultPrevented, false);
  elements.button.fire('pointerenter'); assert.equal(inspection.overlay.hidden, false);
  elements.button.fire('pointerleave'); assert.equal(ui.release().defaultPrevented, true);
  elements.button.fire('pointerenter'); ui.key(' '); ui.window.fire('blur');
  assert.equal(ui.key(' ').defaultPrevented, false, 'a fresh press after a missed keyup clears obsolete ownership');
  assert.equal(ui.release().defaultPrevented, false);
  elements.button.fire('pointermove'); ui.key(' '); assert.equal(inspection.overlay.hidden, false);
  ui.release(); interactions.dispose(); inspection.dispose();
});

test('inspection does not consume form input, IME or modified Space shortcuts', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle(); elements.button.fire('pointerenter');
  const input = ui.document.createElement('input'); ui.get('game').append(input);
  for (const fields of [{target: input}, {isComposing: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true}]) {
    assert.equal(ui.key(' ', fields).defaultPrevented, false);
    assert.equal(inspection.overlay.hidden, true); assert.equal(ui.release().defaultPrevented, false);
  }
  input.focus(); elements.button.fire('pointermove', {altKey: true}); assert.equal(inspection.overlay.hidden, true);
  ui.document.activeElement = null;
  elements.button.fire('pointermove', {altKey: true, ctrlKey: true}); assert.equal(inspection.overlay.hidden, true);
  ui.key(' '); assert.equal(inspection.overlay.hidden, false);
  assert.equal(ui.key('f', {altKey: true}).defaultPrevented, false);
  assert.equal(inspection.overlay.hidden, true); assert.equal(ui.release().defaultPrevented, true, 'the preceding inspection still owns its Space release');
  interactions.dispose(); inspection.dispose();
});

test('Space key and physical code inspect without clicks; E and Alt no longer inspect', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle(); elements.button.focus(); elements.button.fire('pointerenter');
  let clicks = 0; elements.button.addEventListener('click', () => clicks++);
  assert.equal(ui.key('Alt', {altKey: true, code: 'AltLeft'}).defaultPrevented, false);
  assert.equal(inspection.overlay.hidden, true);
  elements.button.fire('pointermove', {altKey: true}); assert.equal(inspection.overlay.hidden, true);
  assert.equal(ui.window.fire('keyup', {key: 'Alt', code: 'AltLeft'}).defaultPrevented, false);
  assert.equal(ui.key('e', {code: 'KeyE'}).defaultPrevented, false);
  assert.equal(inspection.overlay.hidden, true);
  assert.equal(ui.window.fire('keyup', {key: 'e', code: 'KeyE'}).defaultPrevented, false);
  for (const fields of [{key: ' '}, {key: 'Spacebar'}, {key: 'Unidentified', code: 'Space'}]) {
    const down = ui.key(fields.key, {...fields, target: elements.button});
    assert.equal(down.defaultPrevented, true); assert.equal(down.propagationStopped, true);
    assert.equal(inspection.overlay.hidden, false);
    assert.equal(ui.key(' ', {target: elements.button, repeat: true}).defaultPrevented, true);
    const release = ui.release(); if (!release.defaultPrevented) elements.button.fire('click', {detail: 0});
    assert.equal(clicks, 0); assert.equal(inspection.overlay.hidden, true);
  }
  assert.match(elements.button.getAttribute('aria-label'), /\u7a7a\u683c/);
  assert.doesNotMatch(elements.button.getAttribute('aria-label'), /Alt/);
  interactions.dispose(); inspection.dispose();
});

test('mouse inspection releases the stale focus ring without changing card selection', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle(); elements.button.dataset.selected = 'true';
  const action = ui.document.createElement('button'); ui.get('game').append(action);
  for (const control of [action, elements.button]) {
    ui.window.fire('pointerdown', {target: control}); control.focus();
    elements.button.fire('pointerenter');
    assert.equal(ui.key(' ', {target: control}).defaultPrevented, true);
    assert.equal(ui.document.activeElement, ui.document.body);
    assert.equal(inspection.overlay.hidden, false);
    assert.equal(ui.key(' ', {target: control, repeat: true}).defaultPrevented, true);
    assert.equal(ui.release().defaultPrevented, true);
    assert.equal(ui.document.activeElement, ui.document.body, 'releasing inspection must not restore the stale ring');
    assert.equal(elements.button.dataset.selected, 'true', 'actual selection remains intact');
  }
  interactions.dispose(); inspection.dispose();
});

test('Space after leaving a mouse-clicked card clears focus and cannot activate it', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, 'Militia'); await settle();
  elements.button.dataset.selected = 'true';
  ui.window.fire('pointerdown', {target: elements.button}); elements.button.focus();
  elements.button.fire('pointerenter'); elements.button.fire('pointerleave');
  assert.equal(ui.key(' ', {target: elements.button}).defaultPrevented, true);
  assert.equal(ui.document.activeElement === ui.document.body, true);
  assert.equal(inspection.overlay.hidden, true);
  assert.equal(ui.key(' ', {target: ui.document.body, repeat: true}).defaultPrevented, true);
  assert.equal(ui.release().defaultPrevented, true);
  assert.equal(elements.button.dataset.selected, 'true');
  ui.key('Tab'); elements.button.focus();
  assert.equal(ui.key(' ', {target: elements.button}).defaultPrevented, true);
  assert.equal(inspection.overlay.hidden, false, 'keyboard navigation still supports inspection without hover');
  ui.release(); interactions.dispose(); inspection.dispose();
});

test('Tab navigation retains real keyboard focus through inspection', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle();
  ui.key('Tab'); elements.button.focus(); elements.button.fire('pointerenter');
  assert.equal(ui.key(' ', {target: elements.button}).defaultPrevented, true);
  assert.equal(inspection.overlay.hidden, false);
  assert.equal(ui.document.activeElement, elements.button);
  ui.release(); assert.equal(ui.document.activeElement, elements.button);
  ui.window.fire('pointerdown', {target: elements.button});
  ui.key(' ', {target: elements.button}); assert.equal(ui.document.activeElement, ui.document.body);
  ui.release(); interactions.dispose(); inspection.dispose();
});

test('Space releases mouse focus from game pile controls, tabs and desktops even with no hovered card', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  ui.get('game').classList.add('game-cursor'); ui.get('overlays').classList.add('game-cursor');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  for (const [tag, role, host] of [['button', 'button', 'deck'], ['button', 'tab', 'village'],
    ['section', 'tabpanel', 'dungeon'], ['button', 'button', 'overlays']]) {
    const control = ui.document.createElement(tag); control.setAttribute('role', role); control.tabIndex = 0;
    ui.get(host).append(control); ui.window.fire('pointerdown', {target: control}); control.focus();
    assert.equal(ui.key(' ', {target: control}).defaultPrevented, true, `${host}: suppress native activation/scroll`);
    assert.equal(ui.document.activeElement, ui.document.body, `${host}: clear stale focus before painting`);
    assert.equal(ui.key(' ', {target: ui.document.body, repeat: true}).defaultPrevented, true);
    assert.equal(ui.release().defaultPrevented, true); assert.equal(inspection.overlay.hidden, true);
    // Deliberate Tab navigation still focuses and activates the same controls normally.
    ui.key('Tab'); control.focus();
    assert.equal(ui.key(' ', {target: control}).defaultPrevented, false);
    assert.equal(ui.document.activeElement, control); ui.release(); control.remove();
  }
  interactions.dispose(); inspection.dispose();
});

test('game-wide mouse focus cleanup leaves text editing, modified shortcuts and outside-page buttons intact', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  ui.get('game').classList.add('game-cursor');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const field = ui.document.createElement(tag); if (tag === 'div') field.isContentEditable = true;
    ui.get('deck').append(field); ui.window.fire('pointerdown', {target: field}); field.focus();
    assert.equal(ui.key(' ', {target: field}).defaultPrevented, false);
    assert.equal(ui.document.activeElement, field); ui.release(); field.remove();
  }
  const control = ui.document.createElement('button'); ui.get('deck').append(control);
  ui.window.fire('pointerdown', {target: control}); control.focus();
  assert.equal(ui.key(' ', {target: control, ctrlKey: true}).defaultPrevented, false);
  assert.equal(ui.document.activeElement, control); ui.release();
  ui.document.body.append(control);
  assert.equal(ui.key(' ', {target: control}).defaultPrevented, false);
  assert.equal(ui.document.activeElement, control); ui.release();
  interactions.dispose(); inspection.dispose();
});

test('inspection over a hovered card does not toggle a mouse-focused checkbox or radio', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle();
  for (const type of ['checkbox', 'radio']) {
    const control = ui.document.createElement('input'); control.setAttribute('type', type); control.checked = true;
    ui.get('game').append(control); ui.window.fire('pointerdown', {target: control}); control.focus();
    elements.button.fire('pointerenter');
    assert.equal(ui.key(' ', {target: control}).defaultPrevented, true);
    assert.equal(inspection.overlay.hidden, false); assert.equal(ui.document.activeElement, ui.document.body);
    assert.equal(ui.release().defaultPrevented, true); assert.equal(control.checked, true);
  }
  interactions.dispose(); inspection.dispose();
});

test('Space keeps ordinary controls usable without a hovered card and never interrupts editable content', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle();
  for (const tag of ['button', 'input', 'textarea', 'select', 'div']) {
    if (tag !== 'button') elements.button.fire('pointerenter');
    const control = ui.document.createElement(tag); if (tag === 'div') control.isContentEditable = true;
    ui.get('game').append(control); control.focus();
    assert.equal(ui.key(' ', {target: control}).defaultPrevented, false, tag);
    assert.equal(inspection.overlay.hidden, true); assert.equal(ui.release().defaultPrevented, false); control.remove();
  }
  interactions.dispose(); inspection.dispose();
});

test('hovered cards inspect even if an action button still holds focus after a click', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle();
  const action = ui.document.createElement('button'); ui.get('game').append(action); action.focus();
  elements.button.fire('pointerenter');
  assert.equal(ui.key(' ', {target: action}).defaultPrevented, true);
  assert.equal(inspection.overlay.hidden, false);
  assert.equal(ui.release().defaultPrevented, true);
  assert.equal(inspection.overlay.hidden, true);
  interactions.dispose(); inspection.dispose();
});

test('inspection captures wheel input even when the full-size card fits, leaving the desktop unchanged', async () => {
  const ui = await page({html, source}), api = ui.evaluate('GameCardPackage');
  const inspection = api.createCardInspection(), interactions = new api.CardInteractions(inspection.overlay, inspection.content);
  const elements = api.createCardElements('TS-0001'); ui.get('deck').append(elements.button);
  interactions.add(elements, '民兵'); await settle(); elements.button.fire('pointerenter'); ui.key(' ');
  const wheel = ui.window.fire('wheel', {deltaY: 120, target: elements.button});
  assert.equal(wheel.defaultPrevented, true); assert.equal(wheel.propagationStopped, true);
  ui.release(); assert.equal(ui.window.fire('wheel', {deltaY: 120}).defaultPrevented, false);
  interactions.dispose(); inspection.dispose();
});
