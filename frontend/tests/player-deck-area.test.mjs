import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';
import {deckTransitions} from '../.test-dist/match-deck-transitions.js';

const source = await readFile(new URL('../.test-dist/player-deck-component.js', import.meta.url), 'utf8');
const html = '<html><body><main id="first"></main><main id="second"></main><div id="first-overlays"></div><div id="second-overlays"></div></body></html>';
const card = (id, cardId = 'TS-0001') => ({id, cardId, name: `Card ${id}`});
const snapshot = () => ({hand: [card('b', 'TS-0002'), card('a')], draw: [card('d0'), card('d1')], discard: [card('old')]});
const handCards = (ui, prefix) => ui.get(`${prefix}-hand-track`).children.filter(node => node.tagName === 'button' && !node.hidden);
async function setup(options = {}) {
  const ui = await page({html, source, ...options});
  return {ui, Area: ui.evaluate('PlayerDeckPackage.PlayerDeckArea')};
}

test('temporary revealed cards use their own targetable tab and disappear when resolved', async () => {
  const {ui, Area} = await setup(), picked = [];
  const area = new Area(ui.get('first'), {idPrefix: 'one', onCardTargetClick: id => picked.push(id)});
  area.setState({...snapshot(), revealed: [card('revealed')]}); area.setActiveTab('revealed'); area.setCardTargets(['revealed'], []);
  const button = ui.all.find(node => node.dataset.instanceId === 'revealed');
  assert.equal(button.dataset.glowing, 'true'); button.dispatch('click'); assert.deepEqual(picked, ['revealed']);
  area.setState(snapshot()); assert.equal(button.hidden, true); area.dispose();
});

test('internal temporary tab changes preserve every reveal and discard flight in a running sequence', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const first = card('top'); area.setState({hand: [], draw: [first], discard: []}); await settle();
  const reveal = {hand: [], draw: [], discard: [], revealed: [first]}, discarded = {...reveal, revealed: [], discard: [first]};
  const task = area.animateSequence(discarded, [
    {kind: 'transfer', state: reveal, source: 'draw', destination: 'revealed', instanceIds: ['top']},
    {kind: 'transfer', state: discarded, source: 'revealed', destination: 'discard', instanceIds: ['top']},
  ]);
  await settle(); assert.equal(area.activeTab, 'revealed'); assert.equal(area.isBusy, true);
  await ui.advance(2000); await task;
  assert.equal(ui.animations.filter(animation => animation.element.className === 'card-flight').length, 2);
  assert.equal(ui.get('one-discard-count').textContent, '1'); area.dispose();
});

test('attachments form a mini stack, merge equipped weapons, browse with Space and close during state updates', async () => {
  const {ui, Area} = await setup(), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const child = {...card('captive'), kind: 'cage'}, weapon = card('weapon');
  const state = {hand: [{...card('hero'), attachments: [child]}, weapon, child], draw: [], discard: []};
  area.setState(state); area.setBattleDisplay({mandatoryIds: [], equipment: {hero: ['weapon']}}); await settle();
  assert.deepEqual(handCards(ui, 'one').map(card => card.dataset.instanceId), ['hero']);
  const marker = ui.all.find(node => node.className === 'card-attachments');
  assert.match(marker.getAttribute('aria-label'), /2/); marker.dispatch('click'); await settle();
  const browser = ui.all.find(node => node.className.includes('attachment-browser') && node.isConnected); assert.ok(browser);
  assert.match(browser.textContent, /武器/); assert.match(browser.textContent, /囚禁/);
  area.setState({hand: [card('hero'), weapon], draw: [], discard: [child]});
  assert.equal(browser.isConnected, false); area.dispose();
});

test('local status projections preserve manual statuses and are cleared when a hand card moves to discard', async () => {
  const {ui, Area} = await setup(), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const manual = {kind: 'buff', source_name: '临时力量', description: '力量 +2'};
  const live = {kind: 'buff', source_name: '维里斯侍从', description: '光照 +1', continuous: true};
  const item = {...card('weapon'), statuses: [manual]}, state = {hand: [item], draw: [], discard: []};
  area.setState(state); area.setStatusOverrides({weapon: [manual, live]});
  const badge = ui.get('one-first-card').children[0].children[1].children[0];
  assert.match(badge.getAttribute('aria-label'), /临时力量：力量 \+2/); assert.match(badge.getAttribute('aria-label'), /维里斯侍从：光照 \+1/);
  assert.equal(state.hand[0].statuses.length, 1);
  area.setState({hand: [], draw: [], discard: [item]});
  assert.doesNotMatch(ui.get('one-first-card').children[0].children[1].children[0].getAttribute('aria-label'), /维里斯/);
  area.setStatusOverrides(null); area.dispose();
});

test('a host preference waits for animation completion and does not emit a user toggle callback', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), changes = [];
  const area = new Area(ui.get('first'), {idPrefix: 'one', onAutoSortChange: value => changes.push(value)});
  area.setState(snapshot()); await settle();
  const final = {...snapshot(), hand: [card('b', 'TS-0002')], discard: [card('old'), card('a')]};
  const animation = area.animateSequence(final, [{kind: 'discard', state: final, instanceIds: ['a']}]);
  area.setAutoSort(true, {notify: false}); assert.equal(area.autoSortEnabled, false);
  await settle(); await ui.advance(2000); await animation; assert.equal(area.autoSortEnabled, true); assert.deepEqual(changes, []); area.dispose();
});

for (const weaponFirst of [false, true]) test(`unequipping restores full hand geometry, including after relayout: weapon first ${weaponFirst}`, async () => {
  const {ui, Area} = await setup(), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const hero = card('hero'), weapon = card('weapon', 'TS-0002'), other = card('other', 'TS-0300');
  const initial = {hand: weaponFirst ? [weapon, hero, other] : [hero, weapon, other], draw: [], discard: []};
  area.setState(initial);
  const button = handCards(ui, 'one').find(card => card.dataset.instanceId === 'weapon');
  // Model the inline width used by attached cards, including a weapon in slot 1.
  Object.defineProperty(button, 'offsetWidth', {get() {return parseFloat(this.style.width) || 144;}});
  const regularPositions = handCards(ui, 'one').map(card => [card.dataset.instanceId, card.style.left]);
  area.setBattleDisplay({mandatoryIds: [], equipment: {hero: ['weapon']}});
  assert.equal(button.dataset.equippedTo, 'hero'); assert.equal(button.offsetWidth, 144 * .55);
  const anchor = handCards(ui, 'one').find(card => card.dataset.instanceId === 'hero');
  assert.ok(parseFloat(button.style.left) >= parseFloat(anchor.style.left));
  assert.ok(parseFloat(button.style.left) < parseFloat(anchor.style.left) + 144 * .1);
  assert.ok(parseFloat(button.style.top) > 144 * 704 / 504 * .4);
  assert.ok(parseFloat(button.style.top) + 144 * .55 * 704 / 504 <= 144 * 704 / 504);
  area.setBattleDisplay({mandatoryIds: [], equipment: {}});
  assert.equal(button.dataset.equippedTo, undefined);
  assert.equal(button.style.width, ''); assert.equal(button.style.top, ''); assert.equal(button.offsetWidth, 144);
  assert.deepEqual(handCards(ui, 'one').map(card => [card.dataset.instanceId, card.style.left]), regularPositions);
  area.setState(initial); ui.window.fire('resize');
  assert.equal(button.style.width, ''); assert.equal(button.offsetWidth, 144);
  assert.deepEqual(Array.from(area.handOrder), initial.hand.map(card => card.id));
  area.dispose();
});

test('equipment moves and scales the same decoded weapon in both directions without replaying unchanged displays', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  area.setState({hand: [card('hero'), card('weapon', 'TS-0002'), card('other')], draw: [], discard: []}); await settle();
  const buttons = handCards(ui, 'one'), weapon = buttons.find(button => button.dataset.instanceId === 'weapon');
  for (const button of buttons) {
    Object.defineProperty(button, 'offsetWidth', {get() {return parseFloat(this.style.width) || 144;}});
    button.getBoundingClientRect = () => ({left: parseFloat(button.style.left) || 0, top: parseFloat(button.style.top) || 0,
      width: button.offsetWidth, height: button.offsetWidth * 704 / 504});
  }
  const image = weapon.children[0].children[0].children[0], srcWrites = image.srcWrites.length;
  area.setBattleDisplay({mandatoryIds: [], equipment: {hero: ['weapon']}});
  const equip = ui.animations.find(animation => animation.element === weapon && animation.playState === 'running');
  assert.ok(equip); assert.match(equip.keyframes[0].transform, /scale\(1\.818/);
  assert.equal(weapon.dataset.equipmentMoving, 'true');
  const count = ui.animations.length;
  area.setBattleDisplay({mandatoryIds: ['other'], equipment: {hero: ['weapon']}});
  assert.equal(ui.animations.length, count); assert.equal(equip.playState, 'running');
  await ui.advance(250); assert.equal(weapon.dataset.equipmentMoving, undefined);
  area.setBattleDisplay({mandatoryIds: [], equipment: {}});
  const unequip = ui.animations.findLast(animation => animation.element === weapon);
  assert.match(unequip.keyframes[0].transform, /scale\(0\.55/);
  assert.equal(weapon.style.width, ''); assert.equal(weapon.style.top, '');
  assert.equal(weapon.dataset.equippedTo, undefined); assert.equal(area.handOrder.length, 3);
  assert.equal(image.srcWrites.length, srcWrites, 'animation must reuse the already decoded card');
  area.finish(); assert.equal(unequip.playState, 'idle'); assert.equal(weapon.dataset.equipmentMoving, undefined);
  assert.equal(weapon.parentElement.id, 'one-hand-track'); area.dispose();
});

for (const reducedMotion of [false, true]) test(`equipment animation interruption preserves final geometry: reduced motion ${reducedMotion}`, async () => {
  const {ui, Area} = await setup({animationsEnabled: true, reducedMotion}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  area.setState({hand: [card('hero'), card('weapon', 'TS-0002')], draw: [], discard: []}); await settle();
  const weapon = handCards(ui, 'one').find(button => button.dataset.instanceId === 'weapon');
  weapon.getBoundingClientRect = () => ({left: parseFloat(weapon.style.left) || 0, top: parseFloat(weapon.style.top) || 0,
    width: parseFloat(weapon.style.width) || 144, height: (parseFloat(weapon.style.width) || 144) * 704 / 504});
  area.setBattleDisplay({mandatoryIds: [], equipment: {hero: ['weapon']}});
  assert.equal(ui.animations.length > 0, !reducedMotion);
  area.setBattleDisplay({mandatoryIds: [], equipment: {}});
  ui.window.fire('blur');
  assert.equal(weapon.style.width, ''); assert.equal(weapon.dataset.equippedTo, undefined);
  assert.equal(weapon.dataset.equipmentMoving, undefined);
  area.dispose(); assert.ok(ui.animations.every(animation => animation.playState !== 'running'));
});

function refillSequence() {
  const initial = {hand: [card('h1'), card('h2')], draw: [card('d1'), card('d2')], discard: [card('x1'), card('x2')]};
  const final = {hand: [...initial.draw, ...initial.discard, ...initial.hand], draw: [], discard: []};
  const events = ['turn_hand_discarded', 'player_deck_shuffled'].map((kind, i) => ({sequence: i + 1, kind, player_id: 'alice'}));
  return {initial, final, steps: deckTransitions(initial, final, events, 'alice')};
}

test('host-supplied gold and XP counters update independently of cards and validate before changing the display', async () => {
  const {ui, Area} = await setup(), area = new Area(ui.get('first'), {idPrefix: 'one'});
  area.setState(snapshot()); assert.equal(ui.get('one-resources').hidden, true);
  area.setResources({gold: 0, xp: 0});
  assert.equal(ui.get('one-resources').hidden, false); assert.equal(ui.get('one-gold-resource').hidden, false);
  assert.equal(ui.get('one-gold-value').textContent, '0'); assert.equal(ui.get('one-xp-value').textContent, '0');
  assert.equal(ui.get('one-gold-resource').children[0].tagName, 'svg');
  area.setResources({gold: 7, xp: 3}); assert.equal(ui.get('one-gold-value').textContent, '7');
  area.setResources({gold: 0, goldIncomePreview: 10, xp: 3});
  assert.equal(ui.get('one-gold-resource').textContent, '0(+10)');
  assert.equal(ui.get('one-gold-income-preview').hidden, false);
  area.setResources({gold: 4, goldIncomePreview: -2, xp: 3}); assert.equal(ui.get('one-gold-resource').textContent, '4(-2)');
  assert.match(ui.get('one-gold-resource').getAttribute('aria-label'), /预计生产减少 2/);
  assert.throws(() => area.setResources({gold: 2, goldIncomePreview: 0.5, xp: 3}), /integer/);
  assert.equal(ui.get('one-gold-resource').textContent, '4(-2)');
  area.setResources({gold: 7, goldIncomePreview: 0, xp: 3}); assert.equal(ui.get('one-gold-resource').textContent, '7(+0)');
  area.setResources({gold: 7, xp: 3}); assert.equal(ui.get('one-gold-income-preview').hidden, true);
  assert.equal(ui.get('one-xp-resource').getAttribute('aria-label'), '经验值 3');
  assert.throws(() => area.setResources({xp: -1}), /nonnegative/); assert.equal(ui.get('one-xp-value').textContent, '3');
  area.setResources({xp: 2}); assert.equal(ui.get('one-gold-resource').hidden, true); assert.equal(ui.get('one-xp-value').textContent, '2');
  area.setResources(null); assert.equal(ui.get('one-resources').hidden, true); area.dispose();
});

test('a complete refill plays discard, remaining draw, shuffle and remaining draw in order with no interactive gap', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), busy = [];
  const area = new Area(ui.get('first'), {idPrefix: 'one', onBusyChange: value => busy.push(value)});
  const {initial, final, steps} = refillSequence(); area.setState(initial); await settle();
  const pending = area.animateSequence(final, steps); await settle();
  const layer = ui.get('one-card-motion-layer');
  assert.equal(layer.children.length, 2); assert.equal(layer.children[0].className, 'card-flight');
  assert.equal(ui.get('one-draw-count').textContent, '2');
  await ui.advance(310); assert.equal(layer.children.length, 2); assert.equal(layer.children[0].className, 'card-flight');
  assert.equal(ui.get('one-discard-count').textContent, '4');
  await ui.advance(310); assert.equal(layer.children[0].className, 'shuffle-packet'); assert.equal(area.isBusy, true);
  await ui.advance(650); assert.equal(layer.children.length, 4); assert.equal(layer.children[0].className, 'card-flight');
  await ui.advance(430); await pending;
  assert.equal(layer.children.length, 0); assert.equal(area.isBusy, false); assert.deepEqual(busy, [true, false]);
  assert.equal(handCards(ui, 'one').length, 6); assert.equal(ui.get('one-draw-count').textContent, '0');
  assert.equal(ui.get('one-discard-count').textContent, '0'); assert.equal(ui.timers.size, 0);
  assert.ok(ui.all.filter(node => node.tagName === 'img').every(image => image.decodeCalls === 1 && image.srcWrites.length === 1)); area.dispose();
});

function purchaseSequence() {
  const initial = snapshot(), purchased = card('bought', 'TS-0354'), final = {...initial, discard: [...initial.discard, purchased]};
  const origin = {left: 180, top: 140, width: 168, height: 168 * 704 / 504};
  return {initial, final, origin, steps: [{kind: 'gain', instanceIds: [purchased.id], origins: {[purchased.id]: origin}, state: final}]};
}

test('browser DOMRect prototype getters survive gain snapshot copying and still animate', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const {initial, final, steps} = purchaseSequence();
  class BrowserRect {
    get left() {return 180;} get top() {return 140;} get width() {return 168;} get height() {return 235;}
  }
  const rect = new BrowserRect(); assert.deepEqual(Object.keys(rect), []);
  steps[0].origins.bought = rect;
  area.setState(initial); await settle();
  const pending = area.animateSequence(final, steps); await settle();
  const flight = ui.get('one-card-motion-layer').children[0];
  assert.equal(flight.style.left, '180px'); assert.equal(flight.style.top, '140px'); assert.equal(flight.style.width, '168px');
  assert.equal(flight.children[0].dataset.cardId, 'TS-0354'); assert.equal(area.isBusy, true);
  await ui.advance(300); await pending; assert.equal(ui.get('one-discard-count').textContent, '2');
  area.dispose();
});

test('a purchase flies face up from its captured supply bounds into discard, retaining decoded images and busy state', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const {initial, final, origin, steps} = purchaseSequence(); area.setState(initial); await settle();
  const pending = area.animateSequence(final, steps); await settle();
  const flight = ui.get('one-card-motion-layer').children[0], animation = ui.animations.find(item => item.element === flight);
  assert.equal(flight.className, 'card-flight'); assert.equal(flight.style.left, '180px');
  assert.equal(flight.style.top, '140px'); assert.equal(flight.style.width, `${origin.width}px`);
  assert.equal(flight.children[0].dataset.cardId, 'TS-0354'); assert.equal(flight.children[0].dataset.face, 'front');
  assert.equal(ui.get('one-discard-count').textContent, '1'); assert.equal(area.isBusy, true);
  assert.equal(animation.keyframes.at(-1).width, '144px');
  await ui.advance(300); await pending;
  assert.equal(ui.get('one-card-motion-layer').children.length, 0); assert.equal(area.isBusy, false);
  assert.equal(ui.get('one-discard-count').textContent, '2'); assert.deepEqual(Array.from(area.handOrder), ['b', 'a']);
  assert.ok(ui.all.filter(node => node.tagName === 'img').every(image => image.srcWrites.length === 1 && image.decodeCalls === 1)); area.dispose();
});

for (const scenario of ['blur', 'new-state', 'dispose', 'reduced', 'failed-animation', 'browser'])
  test(`purchase flight settles safely on ${scenario}`, async () => {
    const {ui, Area} = await setup({animationsEnabled: true, reducedMotion: scenario === 'reduced', animationFailure: scenario === 'failed-animation'});
    const area = new Area(ui.get('first'), {idPrefix: 'one'}), {initial, final, steps} = purchaseSequence(); area.setState(initial); await settle();
    if (scenario === 'browser') area.openPileBrowser('discard');
    const pending = area.animateSequence(final, steps); await settle();
    const callbacks = ui.animations.map(animation => animation.onfinish).filter(Boolean);
    if (scenario === 'blur') ui.window.fire('blur');
    if (scenario === 'new-state') area.setState({...initial, discard: []});
    if (scenario === 'dispose') area.dispose();
    if (scenario === 'reduced' || scenario === 'failed-animation' || scenario === 'browser') await ui.advance(300);
    await pending; callbacks.forEach(callback => callback()); await ui.advance(1000);
    if (scenario !== 'dispose') {
      assert.equal(area.isBusy, false); assert.equal(ui.get('one-discard-count').textContent, scenario === 'new-state' ? '0' : '2');
      assert.equal(ui.get('one-card-motion-layer').children.length, 0);
      if (scenario === 'browser') assert.equal(browserCards(ui).length, 2);
      area.dispose();
    }
    assert.equal(ui.timers.size, 0);
  });

function upgradeSequence() {
  const source = card('hero-old', 'TS-0354'), target = card('hero-new', 'TS-0355');
  const initial = {hand: [source, card('keep')], draw: [], discard: [card('old-discard')]};
  const final = {...initial, hand: [card('keep')], discard: [...initial.discard, target]};
  return {initial, final, steps: [{kind: 'upgrade', sourceInstanceId: source.id, targetInstanceId: target.id, state: final}]};
}

test('upgrading brings the original hero to center, evolves into its decoded replacement and flies to discard', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), busy = [];
  const area = new Area(ui.get('first'), {idPrefix: 'one', onBusyChange: value => busy.push(value)});
  const {initial, final, steps} = upgradeSequence(); area.setState(initial); await settle();
  const source = handCards(ui, 'one')[0]; area.setSelectedIds(['hero-old']);
  const pending = area.animateSequence(final, steps); await settle();
  const layer = ui.get('one-card-motion-layer'), stage = layer.children[0];
  assert.equal(stage.className, 'card-upgrade'); assert.equal(stage.dataset.stage, 'arrival'); assert.equal(stage.inert, true);
  assert.ok(stage.children[0] === source); assert.equal(source.dataset.cardId, 'TS-0354'); assert.equal(source.dataset.selected, 'false');
  const replacement = stage.children[1]; assert.equal(replacement.dataset.cardId, 'TS-0355'); assert.equal(replacement.style.opacity, '0');
  assert.equal(ui.get('one-discard-count').textContent, '1'); assert.equal(area.isBusy, true);
  await ui.advance(320); assert.equal(stage.dataset.stage, 'evolution');
  const energy = stage.children.find(node => node.className === 'upgrade-energy');
  assert.ok(energy); assert.ok(energy.children.length >= 40 && energy.children.length <= 64, 'particle budget stays bounded');
  assert.ok(Number.parseFloat(stage.style.width) > 144); assert.equal(source.dataset.cardId, 'TS-0354');
  assert.equal(ui.animations.some(animation => animation.element.className === 'card-destruction'), false);
  await ui.advance(1000); assert.equal(stage.dataset.stage, 'departure'); assert.equal(energy.isConnected, false);
  assert.equal(source.style.opacity, '0'); assert.equal(replacement.style.opacity, '1');
  await ui.advance(300); await pending;
  assert.equal(layer.children.length, 0); assert.equal(area.isBusy, false); assert.deepEqual(busy, [true, false]);
  assert.equal(ui.get('one-discard-count').textContent, '2'); assert.equal(source.hidden, true);
  const top = ui.get('one-discard-pile').children.find(node => node.className === 'physical-card' && !node.hidden);
  assert.ok(top === replacement); assert.equal(top.dataset.cardId, 'TS-0355'); assert.deepEqual(Array.from(area.handOrder), ['keep']);
  assert.ok(ui.all.filter(node => node.tagName === 'img').every(image => image.decodeCalls === 1 && image.srcWrites.length === 1));
  assert.equal(ui.timers.size, 0); area.dispose();
});

for (const elapsed of [120, 600, 1400]) test(`new snapshots interrupt upgrade at ${elapsed}ms without resurrecting either hero`, async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const {initial, final, steps} = upgradeSequence(); area.setState(initial); await settle();
  const pending = area.animateSequence(final, steps); await settle(); await ui.advance(elapsed);
  const callbacks = ui.animations.map(animation => animation.onfinish).filter(Boolean);
  area.setState({hand: [card('latest')], draw: [], discard: []});
  callbacks.forEach(callback => callback()); await pending; await ui.advance(3000);
  assert.deepEqual(Array.from(area.handOrder), ['latest']); assert.equal(ui.get('one-discard-count').textContent, '0');
  assert.equal(ui.get('one-card-motion-layer').children.length, 0); assert.equal(ui.timers.size, 0); area.dispose();
});

for (const scenario of ['blur', 'hidden', 'resize', 'dispose', 'reduced', 'failed-animation', 'browser'])
  test(`upgrade settles to its committed result on ${scenario}`, async () => {
    const {ui, Area} = await setup({animationsEnabled: true, reducedMotion: scenario === 'reduced', animationFailure: scenario === 'failed-animation'});
    const area = new Area(ui.get('first'), {idPrefix: 'one'}), {initial, final, steps} = upgradeSequence(); area.setState(initial); await settle();
    if (scenario === 'browser') area.openPileBrowser('discard');
    const pending = area.animateSequence(final, steps); await settle();
    if (scenario === 'blur') ui.window.fire('blur');
    if (scenario === 'hidden') {ui.document.hidden = true; ui.document.fire('visibilitychange');}
    if (scenario === 'resize') ui.window.fire('resize');
    if (scenario === 'dispose') area.dispose();
    await pending; await ui.advance(2500);
    if (scenario !== 'dispose') {
      assert.equal(area.isBusy, false); assert.equal(ui.get('one-discard-count').textContent, '2');
      assert.equal(ui.get('one-card-motion-layer').children.length, 0);
      if (scenario === 'browser') assert.equal(browserCards(ui).length, 2);
      area.dispose();
    }
    assert.equal(ui.timers.size, 0);
  });

test('upgrade waits for both replacement front images to decode before showing a transition', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const {initial, final, steps} = upgradeSequence(); area.setState(initial); await settle();
  const decode = ui.Element.prototype.decode, ready = [];
  ui.Element.prototype.decode = function() {return this.src === '/cards/TS-0355.png' ? new Promise(resolve => ready.push(resolve)) : decode.call(this);};
  const pending = area.animateSequence(final, steps); await settle();
  assert.equal(ready.length, 2); assert.equal(ui.get('one-card-motion-layer').children.length, 0); assert.equal(area.isBusy, true);
  ready[0](); await settle(); assert.equal(ui.get('one-card-motion-layer').children.length, 0);
  ready[1](); await settle(); assert.equal(ui.get('one-card-motion-layer').children[0].dataset.stage, 'arrival');
  await ui.advance(1700); await pending; ui.Element.prototype.decode = decode; area.dispose();
});

test('an upgrade renderer failure after arrival still releases the effect and commits the new hero', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const {initial, final, steps} = upgradeSequence(); area.setState(initial); await settle();
  const pending = area.animateSequence(final, steps); await settle();
  const animate = ui.Element.prototype.animate; ui.Element.prototype.animate = () => {throw new Error('Renderer unavailable');};
  await ui.advance(320); await pending; ui.Element.prototype.animate = animate;
  assert.equal(ui.get('one-discard-count').textContent, '2'); assert.equal(area.isBusy, false);
  assert.equal(ui.get('one-card-motion-layer').children.length, 0); area.dispose();
});

test('the probe upgrade demo uses the same animation and commits only its local demonstration state', async () => {
  const ui = await page({animationsEnabled: true}); await ui.click('upgrade-demo');
  assert.equal(ui.get('card-motion-layer').children[0].className, 'card-upgrade');
  await ui.advance(1700); assert.match(ui.get('demo-status').textContent, /升级为/);
  assert.equal(ui.get('discard-count').textContent, '9'); assert.equal(ui.cards().length, 5);
  assert.equal(ui.get('card-motion-layer').children.length, 0); ui.window.fire('pagehide', {persisted: false});
});

test('destruction lifts and enlarges the original decoded card, then dissolves it without discarding or drawing', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const initial = snapshot(); area.setState(initial); await settle();
  const victim = handCards(ui, 'one')[0], final = {...initial, hand: initial.hand.slice(1)};
  const pending = area.destroyTo(final, ['b']); await settle();
  const animation = ui.animations.find(animation => animation.element.className === 'card-destruction');
  assert.ok(animation); assert.equal(animation.element.children[0], victim);
  assert.ok(Number.parseFloat(animation.keyframes[1].width) > Number.parseFloat(animation.keyframes[0].width));
  assert.equal(animation.keyframes.some(frame => frame.clipPath), false); assert.equal(area.isBusy, true);
  await ui.advance(300);
  const shards = ui.animations.filter(animation => animation.element.className === 'card-shard');
  assert.equal(shards.length, 35); assert.ok(shards.every(animation => animation.element.style.backgroundImage.includes('TS-0002.png')));
  assert.ok(new Set(shards.map(animation => animation.keyframes.at(-1).transform)).size > 20);
  await ui.advance(1200); await pending;
  assert.equal(victim.hidden, true); assert.equal(handCards(ui, 'one').length, 1); assert.equal(area.isBusy, false);
  assert.equal(ui.get('one-draw-count').textContent, '2'); assert.equal(ui.get('one-discard-count').textContent, '1');
  assert.equal(ui.get('one-card-motion-layer').children.length, 0); area.dispose();
});

for (const elapsed of [100, 400, 800, 1400]) test(`newer snapshots override a refill sequence at ${elapsed}ms and late completions cannot restore old state`, async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const {initial, final, steps} = refillSequence(); area.setState(initial); await settle();
  const pending = area.animateSequence(final, steps); await settle(); await ui.advance(elapsed);
  const callbacks = ui.animations.map(animation => animation.onfinish).filter(Boolean);
  area.setState({hand: [card('latest')], draw: [], discard: []}); await settle();
  callbacks.forEach(callback => callback()); await pending; await ui.advance(3000);
  assert.deepEqual(Array.from(area.handOrder), ['latest']); assert.equal(area.isBusy, false);
  assert.equal(ui.get('one-card-motion-layer').children.length, 0); assert.equal(ui.timers.size, 0); area.dispose();
});

for (const scenario of ['blur', 'hidden', 'dispose', 'reduced', 'failed-animation', 'browser']) test(`sequence settles safely on ${scenario}`, async () => {
  const {ui, Area} = await setup({animationsEnabled: true, reducedMotion: scenario === 'reduced', animationFailure: scenario === 'failed-animation'});
  const area = new Area(ui.get('first'), {idPrefix: 'one'}), {initial, final, steps} = refillSequence(); area.setState(initial); await settle();
  if (scenario === 'browser') area.openPileBrowser('draw');
  const pending = area.animateSequence(final, steps); await settle();
  if (scenario === 'blur') ui.window.fire('blur');
  if (scenario === 'hidden') {ui.document.hidden = true; ui.document.fire('visibilitychange');}
  if (scenario === 'dispose') area.dispose();
  await pending; await ui.advance(3000);
  if (scenario !== 'dispose') {
    assert.equal(area.handOrder.length, 6); assert.equal(area.isBusy, false);
    assert.equal(ui.get('one-card-motion-layer').children.length, 0);
    if (scenario === 'browser') {assert.equal(area.isBrowsing, true); assert.equal(ui.get('one-pile-browser-count').textContent, '0 张');}
    area.dispose();
  }
  assert.equal(ui.timers.size, 0);
});

test('hand glow follows instances through sorting and snapshot moves independently of selection and image loading', async () => {
  const {ui, Area} = await setup(), clicks = [];
  const area = new Area(ui.get('first'), {idPrefix: 'one', onHandCardClick: id => {clicks.push(id); return true;}});
  const initial = snapshot(); area.setState(initial); await settle(); area.setSelectedIds(['b']); area.setHighlightedIds(['a']);
  const first = handCards(ui, 'one').find(card => card.dataset.instanceId === 'a');
  first.fire('pointerenter'); first.fire('click'); assert.deepEqual(clicks, ['a']); assert.deepEqual(Array.from(area.selectedIds), ['b']);
  area.setAutoSort(true); await ui.advance(200); assert.equal(handCards(ui, 'one')[0], first); assert.equal(first.dataset.glowing, 'true');
  first.fire('pointerenter'); ui.key(' '); assert.equal(ui.get('one-inspect-overlay').hidden, false); ui.release();
  assert.throws(() => area.setHighlightedIds(['d0']), /hand instances/);
  assert.equal(first.dataset.glowing, 'true');
  area.setState({...initial, hand: initial.hand.filter(card => card.id !== 'a'), discard: [...initial.discard, initial.hand[1]]});
  assert.equal(first.dataset.glowing, 'false');
  assert.equal(ui.all.filter(node => node.tagName === 'img').every(image => image.decodeCalls === 1 && image.srcWrites.length === 1), true);
  area.dispose();
});
const browserCards = (ui, prefix = 'one') => ui.get(`${prefix}-pile-browser-grid`).children
  .filter(node => node.className === 'pile-browser-entry' && !node.hidden).map(node => node.children[0]);

for (const kind of ['draw', 'discard']) test(`an open ${kind} browser follows external snapshots without reopening or resetting scroll/focus`, async () => {
  const {ui, Area} = await setup(), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const initial = {hand: [], draw: [card('d-high', 'TS-0003'), card('d-low'), card('d-same')],
    discard: [card('bottom'), card('middle', 'TS-0002'), card('top', 'TS-0003')]};
  area.setState(initial); await settle(); area.openPileBrowser(kind); await settle();
  const grid = ui.get('one-pile-browser-grid'), modal = ui.get('one-pile-browser');
  const initialCards = browserCards(ui), retained = initialCards[1];
  retained.focus(); ui.key(' '); grid.scrollTop = 153;
  assert.equal(ui.get('one-inspect-overlay').hidden, false);
  const added = card('new', 'TS-0002'), updated = {...initial, [kind]: [...initial[kind].slice(0, 2), added]};
  // Preserve the middle focused instance while replacing a different card, including equal catalog IDs.
  if (kind === 'draw') updated.draw = [initial.draw[0], initial.draw[2], added];
  area.setState(updated); await settle();
  const expected = kind === 'draw' ? ['d-same', 'new', 'd-high'] : ['new', 'middle', 'bottom'];
  assert.deepEqual(browserCards(ui).map(node => node.dataset.instanceId), expected);
  assert.equal(area.isBrowsing, true); assert.equal(modal.hidden, false);
  assert.equal(ui.get('one-pile-browser-count').textContent, '3 张'); assert.equal(grid.scrollTop, 153);
  assert.equal(area.root.inert, true); assert.equal(ui.document.activeElement, retained);
  assert.equal(ui.get('one-inspect-overlay').hidden, false);
  assert.equal(retained.children[0].children[0].children[0].children[0].srcWrites.length, 1);
  // A removed inspected card cannot linger in the list or enlarged image; empty and refilled states are live too.
  const empty = {...updated, [kind]: []}; area.setState(empty); await settle();
  assert.equal(browserCards(ui).length, 0); assert.equal(ui.get('one-pile-browser-empty').hidden, false);
  assert.equal(ui.get('one-pile-browser-count').textContent, '0 张');
  assert.equal(ui.get('one-inspect-overlay').hidden, true); assert.equal(ui.document.activeElement, ui.get('one-close-pile-browser'));
  ui.release();
  area.setState({...empty, [kind]: [added]}); await settle();
  assert.equal(browserCards(ui).length, 1); assert.equal(ui.get('one-pile-browser-empty').hidden, true);
  ui.key('Escape'); assert.equal(area.isBrowsing, false); assert.equal(area.root.inert, false);
  assert.equal(ui.document.activeElement.dataset.instanceId, 'new');
  assert.equal(ui.document.activeElement.getAttribute('title'), null);
  area.dispose();
});

test('external draw/discard and shuffle events update an open browser immediately instead of hiding it for background animation', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const initial = snapshot(); area.setState(initial); await settle(); area.openPileBrowser('draw');
  const drawn = {...initial, hand: [...initial.hand, initial.draw[0]], draw: initial.draw.slice(1)};
  await area.animateTo(drawn, {kind: 'draw', instanceIds: ['d0']});
  assert.equal(area.isBrowsing, true); assert.equal(area.isBusy, false);
  assert.deepEqual(browserCards(ui).map(node => node.dataset.instanceId), ['d1']);
  const shuffled = {...drawn, draw: [...drawn.draw, ...drawn.discard], discard: []};
  await area.shuffleTo(shuffled);
  assert.equal(ui.get('one-pile-browser-count').textContent, '2 张'); assert.equal(area.isBrowsing, true);
  ui.key('Escape'); area.openPileBrowser('discard');
  const discarded = {...shuffled, hand: shuffled.hand.slice(1), discard: [shuffled.hand[0]]};
  await area.animateTo(discarded, {kind: 'discard', instanceIds: [shuffled.hand[0].id]});
  assert.deepEqual(browserCards(ui).map(node => node.dataset.instanceId), [shuffled.hand[0].id]);
  assert.equal(area.isBrowsing, true); assert.equal(area.isBusy, false);
  assert.equal(ui.get('one-card-motion-layer').children.length, 0);
  area.setState(discarded, {closeBrowser: true}); assert.equal(area.isBrowsing, false);
  area.dispose();
});

test('the standalone component owns its DOM, supports multiple scoped instances and accepts custom image sources', async () => {
  const {ui, Area} = await setup();
  const selections = [];
  const first = new Area(ui.get('first'), {idPrefix: 'one', overlayRoot: ui.get('first-overlays'),
    onSelectionChange: ids => selections.push(Array.from(ids)),
    images: {front: id => `/custom/${id}.webp`, back: '/custom/common-back.webp'}});
  const second = new Area(ui.get('second'), {overlayRoot: ui.get('second-overlays')});
  first.setState(snapshot()); second.setState({hand: [card('b')], draw: [], discard: []}); await settle();
  assert.notEqual(first.root.id, second.root.id);
  const ids = ui.all.filter(node => node.isConnected && node.id).map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ui.get('one-draw-count').textContent, '2'); assert.equal(ui.get('one-discard-count').textContent, '1');
  assert.equal(ui.get('one-front-image').src, '/custom/TS-0002.webp');
  assert.equal(ui.get('one-back-image').src, '/custom/common-back.webp');
  ui.get('one-first-card').fire('click');
  assert.deepEqual(Array.from(first.selectedIds), ['b']); assert.deepEqual(Array.from(second.selectedIds), []);
  assert.deepEqual(selections.at(-1), ['b']);
  // No page selectors, demo deck, hand-size cap, HTTP or rule-engine calls are needed.
  second.setState({hand: Array.from({length: 40}, (_, index) => card(`instance-${index}`)), draw: [], discard: []});
  assert.equal(second.handOrder.length, 40); assert.equal(first.handOrder.length, 2); assert.deepEqual(ui.requests, []);
  first.dispose(); second.dispose();
});

test('snapshots are copied, validated atomically and can refresh metadata without replacing loaded card images', async () => {
  const {ui, Area} = await setup(), area = new Area(ui.get('first'), {idPrefix: 'one'});
  const initial = snapshot(); area.setState(initial); await settle();
  initial.hand[0].name = 'Host mutation'; initial.hand.reverse();
  assert.deepEqual(Array.from(area.handOrder), ['b', 'a']);
  assert.match(ui.get('one-first-card').getAttribute('aria-label'), /Card b/);
  assert.throws(() => area.setState({hand: [card('same'), card('same')], draw: [], discard: []}), /unique/);
  assert.throws(() => area.setState({hand: [card('b', 'TS-0999')], draw: [], discard: []}), /changed catalog identity/);
  assert.deepEqual(Array.from(area.handOrder), ['b', 'a']); assert.equal(ui.get('one-draw-count').textContent, '2');
  await assert.rejects(area.animateTo(snapshot(), {kind: 'discard', instanceIds: ['missing']}), /source and destination/);
  assert.equal(area.isBusy, false);
  const updated = snapshot(); updated.hand[0].name = 'Updated name'; area.setState(updated);
  assert.match(ui.get('one-first-card').getAttribute('aria-label'), /Updated name/);
  assert.equal(ui.get('one-front-image').decodeCalls, 1); assert.equal(ui.get('one-front-image').srcWrites.length, 1);
  ui.get('one-first-card').fire('click'); area.setState({hand: [card('a')], draw: [], discard: [card('b', 'TS-0002')]});
  assert.deepEqual(Array.from(area.selectedIds), []);
  area.dispose();
});

test('manual order survives host refreshes, automatic sorting includes incoming cards, and the host can reset presentation order', async () => {
  const {ui, Area} = await setup(), orders = [], auto = [];
  const area = new Area(ui.get('first'), {idPrefix: 'one', onHandOrderChange: ids => orders.push(Array.from(ids)),
    onAutoSortChange: value => auto.push(value)});
  const initial = snapshot(); initial.hand.push(card('c', 'TS-0003')); area.setState(initial); await settle();
  const first = ui.get('one-first-card'), last = handCards(ui, 'one').at(-1).getBoundingClientRect();
  ui.down(first.id); ui.pointer('pointermove', last.left + 12); ui.pointer('pointerup', last.left + 12); await ui.advance(160);
  assert.deepEqual(Array.from(area.handOrder), ['a', 'c', 'b']); assert.deepEqual(orders.at(-1), ['a', 'c', 'b']);
  area.setState({...initial, hand: [...initial.hand, card('new', 'TS-0004')]});
  assert.deepEqual(Array.from(area.handOrder), ['a', 'c', 'b', 'new']);
  area.setState(initial, {resetHandOrder: true}); assert.deepEqual(Array.from(area.handOrder), ['b', 'a', 'c']);
  area.setAutoSort(true); await ui.advance(160);
  assert.deepEqual(Array.from(area.handOrder), ['a', 'b', 'c']); assert.deepEqual(auto, [true]);
  area.setState({...initial, hand: [...initial.hand, card('new-low', 'TS-0001')]});
  assert.deepEqual(Array.from(area.handOrder), ['a', 'new-low', 'b', 'c']);
  area.setState({...initial, hand: [card('new-low', 'TS-0001'), ...initial.hand]});
  assert.deepEqual(Array.from(area.handOrder), ['a', 'new-low', 'b', 'c']);
  assert.deepEqual(initial.hand.map(item => item.id), ['b', 'a', 'c']);
  area.dispose();
});

test('a newer snapshot interrupts animation and disposal removes overlays, handlers, timers and pending completions', async () => {
  const {ui, Area} = await setup({animationsEnabled: true}), busy = [];
  const area = new Area(ui.get('first'), {idPrefix: 'one', overlayRoot: ui.get('first-overlays'), onBusyChange: value => busy.push(value)});
  const initial = snapshot(); area.setState(initial); await settle();
  const drawn = {...initial, hand: [...initial.hand, initial.draw[0]], draw: initial.draw.slice(1)};
  const pending = area.animateTo(drawn, {kind: 'draw', instanceIds: ['d0']}); await settle();
  assert.equal(area.isBusy, true); assert.ok(ui.get('one-card-motion-layer').children.length);
  const newer = {...drawn, hand: [drawn.hand[2], drawn.hand[0], drawn.hand[1]]};
  area.setState(newer, {resetHandOrder: true}); await pending; await ui.advance(1000);
  assert.equal(area.isBusy, false); assert.deepEqual(Array.from(area.handOrder), ['d0', 'b', 'a']);
  assert.equal(ui.get('one-card-motion-layer').children.length, 0); assert.deepEqual(busy, [true, false]);
  const discarded = {...newer, hand: newer.hand.slice(1), discard: [...newer.discard, newer.hand[0]]};
  const second = area.animateTo(discarded, {kind: 'discard', instanceIds: ['d0']}); await settle();
  area.dispose(); area.dispose(); await second; await ui.advance(1000);
  assert.equal(ui.get('first').children.length, 0); assert.equal(ui.get('first-overlays').children.length, 0);
  assert.equal(ui.timers.size, 0); assert.ok(ui.observers.every(observer => observer.disconnected));
  assert.ok(ui.animations.every(animation => animation.playState === 'idle'));
  assert.throws(() => area.setState(initial), /disposed/);
  assert.equal(ui.key(' ').defaultPrevented, false);
});

test('only the hovered or focused component owns Space inspection when multiple deck areas exist', async () => {
  const {ui, Area} = await setup();
  const first = new Area(ui.get('first'), {idPrefix: 'one'}), second = new Area(ui.get('second'), {idPrefix: 'two'});
  first.setState(snapshot()); second.setState(snapshot()); await settle();
  const firstCard = ui.get('one-first-card'), secondCard = ui.get('two-first-card');
  firstCard.focus(); secondCard.fire('pointerenter'); ui.key(' ');
  assert.equal(ui.get('one-inspect-overlay').hidden, true); assert.equal(ui.get('two-inspect-overlay').hidden, false);
  assert.equal(firstCard.dataset.active, 'false'); assert.equal(secondCard.dataset.active, 'true');
  secondCard.fire('pointerleave');
  assert.equal(ui.get('one-inspect-overlay').hidden, false); assert.equal(ui.get('two-inspect-overlay').hidden, true);
  ui.release(); first.dispose(); second.dispose();
});
