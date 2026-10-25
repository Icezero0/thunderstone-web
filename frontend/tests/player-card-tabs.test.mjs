import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';

const source = await readFile(new URL('../.test-dist/player-deck-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="game"></main></body></html>';
const card = (id, cardId = 'TS-0001') => ({id, cardId, name: `Card ${id}`});
const snapshot = () => ({hand: [card('h2', 'TS-0002'), card('h1')], draw: [card('draw')], discard: [],
  treasures: [card('treasure', 'TS-0700')], aside: [{...card('aside', 'TS-0336'), faceUp: false}]});
const displayed = (ui, kind) => ui.get(`one-${kind}-track`).children.filter(node => node.tagName === 'button' && !node.hidden);
async function setup(options = {}, pageOptions = {}) {
  const ui = await page({html, source, ...pageOptions}), Area = ui.evaluate('PlayerDeckPackage.PlayerDeckArea');
  const area = new Area(ui.get('game'), {idPrefix: 'one', ...options}); return {ui, area};
}

test('only the hand tab exists visually initially; nonempty auxiliary snapshots add tabs without moving the current view', async () => {
  const {ui, area} = await setup();
  assert.equal(ui.get('one-hand-heading').getAttribute('role'), 'tab');
  assert.equal(ui.get('one-hand-heading').getAttribute('aria-selected'), 'true');
  assert.equal(ui.get('one-treasures-tab').hidden, true); assert.equal(ui.get('one-aside-tab').hidden, true);
  assert.equal(area.setActiveTab('treasures'), false);
  const state = snapshot(); area.setState(state); await settle();
  assert.equal(area.activeTab, 'hand'); assert.equal(ui.get('one-treasures-tab').hidden, false); assert.equal(ui.get('one-aside-tab').hidden, false);
  state.treasures[0].name = 'Caller mutation'; state.aside[0].faceUp = true;
  area.setActiveTab('treasures'); assert.doesNotMatch(displayed(ui, 'treasures')[0].getAttribute('aria-label'), /Caller mutation/);
  area.setActiveTab('aside'); assert.equal(displayed(ui, 'aside')[0].dataset.face, 'back');
  assert.throws(() => area.setState({...snapshot(), treasures: [card('h1')]}), /unique/);
  assert.throws(() => area.setState({...snapshot(), aside: [{...card('aside'), faceUp: 'no'}]}), /boolean/);
  assert.equal(area.activeTab, 'aside'); assert.equal(displayed(ui, 'aside')[0].dataset.face, 'back'); area.dispose();
});

test('switching tabs preserves hand order and selection, supports E on both faces, and reuses decoded images', async () => {
  const {ui, area} = await setup(); area.setState(snapshot()); await settle();
  const hand = displayed(ui, 'hand')[0]; hand.fire('click');
  assert.deepEqual(Array.from(area.selectedIds), ['h2']); area.setActiveTab('treasures');
  assert.equal(ui.get('one-hand-track').hidden, true); assert.equal(ui.get('one-draw-count').textContent, '1');
  const treasure = displayed(ui, 'treasures')[0]; treasure.fire('pointerenter'); ui.key('e');
  assert.equal(ui.get('one-inspect-overlay').hidden, false);
  area.setActiveTab('aside'); assert.equal(ui.get('one-inspect-overlay').hidden, true);
  const aside = displayed(ui, 'aside')[0]; aside.fire('pointerenter');
  const large = ui.get('one-inspect-content').children.find(node => !node.hidden);
  assert.equal(large.children[0].hidden, true); assert.equal(large.children[1].hidden, false); assert.equal(large.children[1].width, 501);
  aside.fire('click'); assert.deepEqual(Array.from(area.selectedIds), ['h2']);
  area.setAutoSort(true); assert.equal(area.isBusy, false); assert.deepEqual(Array.from(area.handOrder), ['h1', 'h2']);
  area.setActiveTab('hand'); assert.equal(displayed(ui, 'hand')[1], hand); assert.equal(hand.dataset.selected, 'true');
  for (let i = 0; i < 3; i++) {area.setActiveTab('treasures'); area.setActiveTab('aside'); area.setActiveTab('hand');}
  assert.ok(ui.all.filter(node => node.tagName === 'img').every(node => node.decodeCalls === 1 && node.srcWrites.length === 1));
  assert.deepEqual(ui.requests, []); area.dispose();
});

test('tabs support keyboard navigation and return focus to the hand when the selected zone becomes empty', async () => {
  const {ui, area} = await setup(); area.setState(snapshot()); await settle();
  const hand = ui.get('one-hand-heading'); hand.focus(); hand.fire('keydown', {key: 'ArrowRight'});
  assert.equal(area.activeTab, 'treasures'); assert.equal(ui.document.activeElement, ui.get('one-treasures-tab'));
  ui.get('one-treasures-tab').fire('keydown', {key: 'End'}); assert.equal(area.activeTab, 'aside');
  const held = displayed(ui, 'aside')[0]; held.focus(); ui.key('e');
  area.setState({...snapshot(), aside: []});
  assert.equal(area.activeTab, 'hand'); assert.equal(ui.get('one-aside-tab').hidden, true);
  assert.equal(ui.document.activeElement, hand); assert.equal(ui.get('one-inspect-overlay').hidden, true);
  hand.fire('keydown', {key: 'ArrowRight'}); assert.equal(area.activeTab, 'treasures');
  const treasureTab = ui.get('one-treasures-tab'); treasureTab.focus();
  area.setState({hand: [], draw: [], discard: []});
  assert.equal(area.activeTab, 'hand'); assert.equal(ui.document.activeElement, hand);
  assert.equal(ui.get('one-empty-hand').hidden, false);
  area.dispose(); assert.equal(hand.fire('keydown', {key: 'ArrowRight'}).defaultPrevented, false);
});

test('drawing while viewing treasures updates the hidden hand without flying cards into a hidden panel', async () => {
  const {ui, area} = await setup({}, {animationsEnabled: true}); const state = snapshot(); area.setState(state); await settle();
  area.setActiveTab('treasures'); const treasure = displayed(ui, 'treasures')[0];
  const next = {...state, hand: [...state.hand, ...state.draw], draw: []};
  await area.animateTo(next, {kind: 'draw', instanceIds: ['draw']});
  assert.equal(area.activeTab, 'treasures'); assert.equal(area.isBusy, false); assert.equal(displayed(ui, 'treasures')[0], treasure);
  assert.equal(ui.get('one-card-motion-layer').children.length, 0); assert.equal(ui.get('one-draw-count').textContent, '0');
  area.setActiveTab('hand'); assert.deepEqual(Array.from(area.handOrder), ['h2', 'h1', 'draw']); area.dispose();
});

test('the response region is between tabs and sorting; choices follow copied host data and stale, disabled or inert controls cannot respond', async () => {
  const answers = [], {ui, area} = await setup({onResponse: (...answer) => answers.push(answer)});
  const header = ui.get('one-hand-zone-heading');
  assert.deepEqual(header.children.map(node => node.id), ['one-card-tabs', 'one-player-response', 'one-resources', 'one-auto-sort-label']);
  assert.equal(ui.get('one-player-response').hidden, false); assert.equal(ui.get('one-player-response').children.length, 0);
  const request = {id: 'turn', prompt: '行动', choices: [{id: 'village', label: '村庄'}, {id: 'dungeon', label: '地下城', disabled: true}]};
  area.setResponse(request); request.choices[0].label = 'Caller mutation';
  const village = ui.get('one-response-village'); assert.equal(village.textContent, '村庄');
  village.fire('click'); ui.get('one-response-dungeon').fire('click'); assert.deepEqual(answers, [['turn', 'village']]);
  assert.throws(() => area.setResponse({id: 'invalid', prompt: '', choices: [{id: 'x', label: 'x'}, {id: 'x', label: 'x'}]}), /unique/);
  area.setResponse({id: 'replacement', prompt: '确认', choices: [{id: 'confirm', label: '确认'}], disabled: true});
  village.fire('click'); ui.get('one-response-confirm').fire('click'); assert.equal(answers.length, 1);
  area.setResponse({id: 'replacement', prompt: '确认', choices: [{id: 'confirm', label: '确认'}]});
  area.root.inert = true; ui.get('one-response-confirm').fire('click'); assert.equal(answers.length, 1); area.root.inert = false;
  ui.get('one-response-confirm').fire('click'); assert.deepEqual(answers.at(-1), ['replacement', 'confirm']);
  const confirm = ui.get('one-response-confirm'); area.setResponse(null); confirm.fire('click'); assert.equal(answers.length, 2);
  assert.equal(ui.get('one-player-response').dataset.empty, 'true'); assert.equal(ui.get('one-player-response').children.length, 0);
  area.dispose(); assert.throws(() => area.setResponse(null), /disposed/);
});

test('card movement temporarily blocks tabs and response choices, then restores them', async () => {
  const answers = [], {ui, area} = await setup({onResponse: (...answer) => answers.push(answer)}, {animationsEnabled: true});
  const state = snapshot(); area.setState(state); await settle();
  area.setResponse({id: 'turn', prompt: '行动', choices: [{id: 'rest', label: '休整'}]});
  const pending = area.animateTo({...state, hand: [...state.hand, ...state.draw], draw: []}, {kind: 'draw', instanceIds: ['draw']});
  await settle(); assert.equal(area.isBusy, true); assert.equal(ui.get('one-treasures-tab').disabled, true);
  ui.get('one-treasures-tab').fire('click'); ui.get('one-response-rest').fire('click'); assert.equal(area.activeTab, 'hand'); assert.equal(answers.length, 0);
  area.finish(); await pending;
  assert.equal(ui.get('one-response-rest').disabled, false); assert.equal(area.setActiveTab('treasures'), true);
  ui.get('one-response-rest').fire('click'); assert.deepEqual(answers, [['turn', 'rest']]); area.dispose();
});

test('the probe demos gaining treasures, setting cards aside, returning them and selecting an action without network requests', async () => {
  const ui = await page(); assert.equal(ui.get('treasures-tab').hidden, true); assert.equal(ui.get('aside-tab').hidden, true);
  await ui.click('demo-treasures'); assert.equal(ui.get('treasures-tab').hidden, false);
  assert.equal(ui.get('hand-heading').getAttribute('aria-selected'), 'true');
  await ui.click('treasures-tab'); assert.equal(ui.get('treasures-track').hidden, false);
  await ui.click('demo-aside'); assert.equal(ui.get('aside-tab').hidden, false); assert.equal(ui.get('hand-count-label').textContent, '4 张');
  await ui.click('aside-tab'); const cards = ui.get('aside-track').children.filter(node => node.tagName === 'button' && !node.hidden);
  assert.deepEqual(cards.map(node => node.dataset.face), ['front', 'back']);
  await ui.click('demo-response-action'); await ui.click('response-village');
  assert.equal(ui.get('player-response').children.length, 0);
  assert.match(ui.get('demo-status').textContent, /村庄/);
  await ui.click('demo-aside'); assert.equal(ui.get('aside-tab').hidden, true); assert.equal(ui.get('hand-track').hidden, false);
  assert.equal(ui.get('hand-count-label').textContent, '6 张');
  await ui.click('demo-treasures'); assert.equal(ui.get('treasures-tab').hidden, true);
  assert.deepEqual(ui.requests, []); ui.window.fire('pagehide', {persisted: false});
});

test('the response API supports blank space, phase text without choices and replacement choices with safe keyboard focus', async () => {
  const answers = [], {ui, area} = await setup({onResponse: (...answer) => answers.push(answer)}), root = ui.get('one-player-response');
  assert.equal(root.hidden, false); assert.equal(root.dataset.empty, 'true'); assert.equal(root.textContent, '');
  area.setResponse({id: 'phase', prompt: '地下城准备'});
  assert.equal(root.dataset.empty, 'false'); assert.equal(root.children.length, 1); assert.equal(root.textContent, '地下城准备');
  assert.equal(root.children[0].getAttribute('role'), 'status');
  area.setResponse({id: 'phase', prompt: '等待其他玩家', choices: []}); assert.equal(root.children.length, 1);
  assert.throws(() => area.setResponse({id: 'phase', prompt: '阶段', selectedId: 'missing'}), /selectedId/);
  assert.equal(root.textContent, '等待其他玩家');
  area.setResponse({id: 'action', prompt: '请选择行动', choices: [{id: 'rest', label: '休整'}]});
  const old = ui.get('one-response-rest'); old.focus();
  area.setResponse({id: 'rest', prompt: '请选择手牌', choices: [{id: 'destroy', label: '摧毁', disabled: true}, {id: 'end', label: '结束回合'}]});
  assert.equal(ui.document.activeElement, ui.get('one-response-end')); old.fire('click'); assert.equal(answers.length, 0);
  assert.equal(ui.get('one-response-end').getAttribute('aria-pressed'), null);
  area.setResponse({id: 'phase', prompt: '回合结束'}); assert.equal(ui.document.activeElement, ui.get('one-hand-heading'));
  area.setResponse(null); assert.equal(root.textContent, ''); assert.equal(root.hidden, false); area.dispose();
});

test('probe response examples are temporary and rest confirmation changes only the response display, not cards or turns', async () => {
  const ui = await page(), root = ui.get('player-response');
  assert.equal(root.hidden, false); assert.equal(root.children.length, 0);
  const ids = () => ui.cards().map(card => card.dataset.instanceId), before = ids();
  await ui.click('demo-response-action'); const oldVillage = ui.get('response-village');
  assert.match(root.textContent, /回合开始/); assert.equal(oldVillage.getAttribute('aria-pressed'), null);
  await ui.click('response-rest'); assert.match(root.textContent, /休整/); assert.equal(ui.get('response-rest').isConnected, false);
  assert.equal(ui.get('response-destroy').disabled, true); oldVillage.fire('click'); assert.match(root.textContent, /休整/);
  await ui.click('probe-card'); assert.equal(ui.get('response-destroy').disabled, false);
  await ui.click('response-destroy'); assert.equal(root.children.length, 0); assert.deepEqual(ids(), before);
  assert.match(ui.get('demo-status').textContent, /未实际移除/);
  await ui.click('demo-response-rest'); await ui.click('response-end-turn');
  assert.equal(root.children.length, 0); assert.deepEqual(ids(), before); assert.match(ui.get('demo-status').textContent, /未实际推进/);
  await ui.click('demo-response-phase'); assert.equal(root.children.length, 1); assert.match(root.textContent, /地下城准备/);
  await ui.click('demo-response-clear'); assert.equal(root.children.length, 0);
  await ui.click('demo-response-action'); await ui.click('response-dungeon'); assert.equal(root.children.length, 0);
  await ui.click('demo-response-rest'); await ui.click('reset-demo'); assert.equal(root.children.length, 0);
  assert.deepEqual(ui.requests, []); ui.window.fire('pagehide', {persisted: false});
  ui.get('demo-response-action').fire('click'); assert.equal(root.children.length, 0);
});
