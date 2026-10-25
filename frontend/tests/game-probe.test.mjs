import test from 'node:test';
import assert from 'node:assert/strict';
import {html, page, settle} from './support/player-deck-dom.mjs';

const cardImages = ui => ui.all.filter(node => node.tagName === 'img' &&
  (node.parentElement?.className.includes('card-face') || node.parentElement?.className === 'inspect-picture'));

test('destruction demo targets a selected card and changes neither draw nor discard piles', async () => {
  const ui = await page({animationsEnabled: true}), selected = ui.cards()[2]; selected.fire('click');
  const draw = ui.get('draw-count').textContent, discard = ui.get('discard-count').textContent;
  await ui.click('destroy-demo');
  assert.equal(ui.get('destroy-demo').disabled, true);
  assert.equal(ui.animations.find(animation => animation.element.className === 'card-destruction').element.children[0], selected);
  await ui.advance(1600);
  assert.equal(ui.cards().length, 5); assert.equal(ui.cards().includes(selected), false);
  assert.equal(ui.get('draw-count').textContent, draw); assert.equal(ui.get('discard-count').textContent, discard);
  assert.match(ui.get('demo-status').textContent, /已演示摧毁/); assert.equal(ui.get('destroy-demo').disabled, false);
  assert.deepEqual(ui.requests, []); ui.window.fire('pagehide', {persisted: false});
});

for (const elapsed of [100, 600]) test(`reset interrupts destruction cleanly during the lift/dust phases: ${elapsed}ms`, async () => {
  const ui = await page({animationsEnabled: true}); await ui.click('destroy-demo'); await ui.advance(elapsed);
  const callbacks = ui.animations.map(animation => animation.onfinish).filter(Boolean);
  await ui.click('reset-demo'); callbacks.forEach(callback => callback()); await ui.advance(2000);
  assert.equal(ui.cards().length, 6); assert.equal(ui.get('card-motion-layer').children.length, 0);
  assert.equal(ui.get('destroy-demo').disabled, false); assert.equal(ui.timers.size, 0);
  assert.ok(ui.cards().every(card => card.style.opacity !== '0')); ui.window.fire('pagehide', {persisted: false});
});

test('the page starts with six hand cards and separate draw/discard piles; players cannot flip them', async () => {
  const ui = await page();
  assert.equal(ui.cards().length, 6);
  assert.equal(ui.get('draw-pile-card').dataset.face, 'back');
  assert.equal(ui.get('discard-pile-card').dataset.face, 'front');
  assert.deepEqual(ui.requests, []);
  ui.enter(); assert.equal(ui.get('probe-card').dataset.active, 'true');
  assert.equal(ui.key('f', {code: 'KeyF'}).defaultPrevented, false);
  assert.equal(ui.get('probe-card').dataset.face, 'front');
  ui.enter('draw-pile-card'); ui.key('f');
  assert.equal(ui.get('draw-pile-card').dataset.face, 'back');
  assert.doesNotMatch(html, /按 F|<kbd>F<\/kbd>|id="card-info"/);
});

test('a short hand is independent and centered with z order increasing to the right', async () => {
  const ui = await page(); await ui.count(3);
  const cards = ui.cards(), positions = cards.map(card => Number.parseFloat(card.style.left));
  assert.equal(ui.get('hand-track').dataset.overlapping, 'false');
  assert.equal(positions[1] - positions[0], 158);
  assert.equal(positions[2] - positions[1], 158);
  assert.equal(positions[0], 1000 - positions[2] - 144);
  assert.deepEqual(cards.map(card => card.style.zIndex), ['1', '2', '3']);
});

test('an overflowing hand overlaps evenly and keeps its outside edges inside the hand area', async () => {
  const ui = await page({width: 600, cardWidth: 132}); await ui.count(12);
  const cards = ui.cards(), positions = cards.map(card => Number.parseFloat(card.style.left));
  assert.equal(ui.get('hand-track').dataset.overlapping, 'true');
  assert.equal(positions[0], 0); assert.equal(positions.at(-1) + 132, 600);
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1]);
    assert.ok(positions[i] - positions[i - 1] < 132);
    assert.ok(Math.abs(positions[i] - positions[i - 1] - 468 / 11) < 1e-8);
    assert.equal(cards[i].style.zIndex, String(i + 1));
  }
});

test('ResizeObserver recalculates card positions in both directions, including a change of card size', async () => {
  const ui = await page({width: 1400});
  assert.equal(ui.get('hand-track').dataset.overlapping, 'false');
  ui.resize(400, 100);
  assert.equal(ui.get('hand-track').dataset.overlapping, 'true');
  assert.equal(Number.parseFloat(ui.cards().at(-1).style.left) + 100, 400);
  ui.resize(1400, 144);
  assert.equal(ui.get('hand-track').dataset.overlapping, 'false');
  assert.equal(Number.parseFloat(ui.cards()[1].style.left) - Number.parseFloat(ui.cards()[0].style.left), 158);
});

test('zero and one card work; quantity controls reuse already decoded cards and stay within 0 to 30', async () => {
  const ui = await page(), first = ui.get('probe-card');
  await ui.count(30); assert.equal(ui.cards().length, 30); assert.equal(ui.get('more-cards').disabled, true);
  await ui.count(0); assert.equal(ui.cards().length, 0); assert.equal(ui.get('empty-hand').hidden, false);
  assert.equal(ui.get('hand-count-label').textContent, '0 张'); assert.equal(ui.get('fewer-cards').disabled, true);
  assert.equal(ui.get('draw-pile-card').hidden, false); assert.equal(ui.get('discard-pile-card').hidden, false);
  ui.get('more-cards').fire('click'); assert.equal(ui.cards().length, 1);
  assert.equal(ui.cards()[0], first); assert.equal(Number.parseFloat(first.style.left), (1000 - 144) / 2);
  assert.equal(ui.get('front-image').decodeCalls, 1); assert.equal(ui.get('front-image').srcWrites.length, 1);
  ui.get('fewer-cards').fire('click'); assert.equal(ui.cards().length, 0);
  await ui.count(99); assert.equal(ui.cards().length, 30);
  await ui.count(-1); assert.equal(ui.cards().length, 0);
});

test('E inspection shows only full-size art and transfers to another hand card without changing sources', async () => {
  const ui = await page(); ui.enter(); ui.key('e');
  assert.equal(ui.get('inspect-overlay').hidden, false); assert.equal(ui.inspecting().length, 1);
  assert.deepEqual([ui.get('inspect-image').width, ui.get('inspect-image').height], [504, 704]);
  assert.equal(ui.get('inspect-image').hidden, false); assert.equal(ui.get('inspect-back-image').hidden, true);
  ui.cards()[1].fire('pointerenter');
  assert.equal(ui.get('first-inspection').hidden, true); assert.equal(ui.inspecting().length, 1);
  const [front, back] = ui.inspecting()[0].children;
  assert.equal(front.src, '/cards/TS-0001.png'); assert.equal(front.hidden, false); assert.equal(back.hidden, true);
  for (let i = 0; i < 20; i++) {ui.release(); ui.key('e');}
  for (const image of cardImages(ui)) {
    assert.equal(image.decodeCalls, 1); assert.equal(image.srcWrites.length, 1);
  }
  ui.release(); assert.equal(ui.get('inspect-overlay').hidden, true); assert.equal(ui.inspecting().length, 0);
});

test('a face-down draw pile reveals only the original-size shared back, including after pressing F', async () => {
  const ui = await page(); ui.enter('draw-pile-card'); ui.key('e'); ui.key('f');
  assert.equal(ui.get('inspect-content').dataset.face, 'back'); assert.equal(ui.inspecting().length, 1);
  const [front, back] = ui.inspecting()[0].children;
  assert.equal(front.hidden, true); assert.equal(back.hidden, false);
  assert.equal(back.src, '/cards/TS-BACK-001.jpg'); assert.deepEqual([back.width, back.height], [501, 704]);
  assert.doesNotMatch(ui.get('draw-pile-card').getAttribute('aria-label'), /民兵/);
});

test('pointer and keyboard focus share one active card and one inspection owner', async () => {
  const ui = await page(), first = ui.get('probe-card');
  first.keyboardFocus = true; first.fire('focus'); ui.key('e');
  assert.equal(ui.get('first-inspection').hidden, false);
  ui.cards()[2].fire('pointerenter');
  assert.equal(first.dataset.active, 'false'); assert.equal(ui.cards()[2].dataset.active, 'true');
  assert.equal(ui.inspecting().length, 1);
  ui.cards()[2].fire('pointerleave');
  assert.equal(first.dataset.active, 'true'); assert.equal(ui.get('first-inspection').hidden, false);
  first.fire('blur'); assert.equal(ui.get('inspect-overlay').hidden, true);
});

test('E held before entering works; leaving, focus loss and hidden tabs dismiss inspection', async () => {
  const ui = await page(); ui.key('e'); assert.equal(ui.get('inspect-overlay').hidden, true);
  ui.enter('probe-card'); assert.equal(ui.get('inspect-overlay').hidden, false);
  ui.get('probe-card').fire('pointerleave'); assert.equal(ui.get('inspect-overlay').hidden, true);
  ui.enter('probe-card'); ui.window.fire('blur');
  assert.equal(ui.get('inspect-overlay').hidden, true);
  ui.enter(); ui.key('e'); ui.document.hidden = true; ui.document.fire('visibilitychange');
  assert.equal(ui.get('inspect-overlay').hidden, true);
  const input = new ui.Element(); input.editable = true;
  ui.document.hidden = false; ui.enter(); ui.key('e', {target: input});
  assert.equal(ui.get('inspect-overlay').hidden, true);
});

test('removing the inspected card or leaving the page closes inspection and releases observers/listeners', async () => {
  const ui = await page(); ui.enter(); ui.key('e'); await ui.count(0);
  assert.equal(ui.get('inspect-overlay').hidden, true);
  await ui.count(6); ui.enter(); ui.key('e');
  ui.window.fire('pagehide', {persisted: false});
  assert.equal(ui.get('inspect-overlay').hidden, true); assert.ok(ui.observers.every(item => item.disconnected));
  ui.enter(); ui.key('e'); assert.equal(ui.get('inspect-overlay').hidden, true);
  await ui.count(10); assert.equal(ui.cards().length, 0);
  assert.equal(ui.get('player-deck-area').children.length, 0);
});

test('inspection waits for every image of its card to decode; an error does not block other cards', async () => {
  for (const id of ['front-image', 'back-image', 'inspect-image', 'inspect-back-image']) {
    const ui = await page({pendingImages: [id]}); ui.enter(); ui.key('e');
    assert.equal(ui.get('probe-card').dataset.imagesReady, 'false');
    assert.equal(ui.get('inspect-overlay').hidden, true);
    await ui.decoded(id);
    assert.equal(ui.get('probe-card').dataset.imagesReady, 'true');
    assert.equal(ui.get('inspect-overlay').hidden, false);
  }
  const failed = await page({brokenImage: 'back-image'}); failed.enter(); failed.key('e');
  assert.equal(failed.get('inspect-overlay').hidden, true); assert.match(failed.get('probe-notice').textContent, /卡图暂未载入/);
  failed.enter('discard-pile-card'); assert.equal(failed.get('inspect-overlay').hidden, false);
  const pending = await page({pendingImages: ['back-image']}); pending.enter(); pending.key('e');
  pending.window.fire('pagehide', {persisted: false}); await pending.decoded('back-image');
  assert.equal(pending.get('probe-card').dataset.imagesReady, 'false');
  assert.equal(pending.get('inspect-overlay').hidden, true);
});

test('the resize fallback works when ResizeObserver is unavailable', async () => {
  const ui = await page({observer: false}); ui.resize(300);
  assert.equal(ui.get('hand-track').dataset.overlapping, 'true');
  assert.equal(Number.parseFloat(ui.cards().at(-1).style.left) + 144, 300);
});

function pileTop(ui, id) {
  return ui.get(id).children.find(node => node.className === 'physical-card' && !node.hidden);
}

function paperEdges(card) {
  return card.children[0].children.filter(node => node.className === 'pile-edge');
}

test('pile thickness is capped and follows exact counts, including a drained draw pile', async () => {
  const ui = await page();
  assert.equal(ui.get('draw-count').textContent, '24'); assert.equal(ui.get('discard-count').textContent, '8');
  assert.equal(ui.get('draw-pile').dataset.layers, '5');
  assert.equal(paperEdges(pileTop(ui, 'draw-pile')).filter(edge => !edge.hidden).length, 5);
  assert.equal(paperEdges(pileTop(ui, 'discard-pile')).filter(edge => !edge.hidden).length, 2);
  await ui.count(0); ui.get('draw-quantity').value = '30'; await ui.click('draw-many');
  assert.equal(ui.cards().length, 24); assert.equal(ui.get('draw-count').textContent, '0');
  assert.equal(ui.get('draw-pile').dataset.layers, '0'); assert.equal(pileTop(ui, 'draw-pile'), undefined);
  assert.equal(ui.get('draw-pile').children.find(node => node.className === 'pile-empty').hidden, false);
  assert.equal(ui.get('draw-one').disabled, true); assert.equal(ui.get('draw-many').disabled, true);
  await ui.click('discard-all');
  assert.equal(ui.cards().length, 0); assert.equal(ui.get('discard-count').textContent, '32');
  assert.equal(ui.get('discard-pile').dataset.layers, '5');
  assert.equal(pileTop(ui, 'discard-pile').dataset.instanceId, 'draw-23');
  assert.equal(paperEdges(pileTop(ui, 'discard-pile')).filter(edge => !edge.hidden).length, 5);
});

test('selection discards the exact instances in hand order, independently of selection order', async () => {
  const ui = await page();
  ui.cards()[3].fire('click'); ui.cards()[1].fire('click');
  assert.equal(ui.get('discard-selected').textContent, '弃选中（2）');
  assert.equal(ui.cards()[1].getAttribute('aria-pressed'), 'true');
  await ui.click('discard-selected');
  assert.deepEqual(ui.cards().map(card => card.dataset.instanceId), ['hand-0', 'hand-2', 'hand-4', 'hand-5']);
  assert.equal(ui.get('discard-count').textContent, '10');
  assert.equal(pileTop(ui, 'discard-pile').dataset.instanceId, 'hand-3');
  assert.equal(ui.get('discard-selected').disabled, true);
  assert.ok(ui.cards().every(card => card.dataset.selected === 'false'));
  await ui.count(28); ui.get('draw-quantity').value = '5'; await ui.click('draw-many');
  assert.equal(ui.cards().length, 30); assert.equal(ui.get('draw-count').textContent, '22');
  assert.equal(ui.get('draw-one').disabled, true);
});

test('batch draw reserves final hand positions once and staggers existing decoded cards into place', async () => {
  const ui = await page({animationsEnabled: true}); await ui.click('draw-many');
  assert.equal(ui.get('card-motion-layer').children.length, 5);
  assert.equal(ui.get('hand-count-label').textContent, '11 张');
  assert.equal(ui.get('draw-count').textContent, '23'); assert.equal(ui.get('draw-one').disabled, true);
  const left = ui.get('probe-card').style.left;
  const flights = ui.animations.filter(item => item.element.className === 'card-flight');
  assert.deepEqual(flights.map(item => item.options.delay), [0, 60, 120, 180, 240]);
  assert.ok(ui.get('card-motion-layer').children.every(node => node.children[0].dataset.face === 'back'));
  assert.ok(ui.get('card-motion-layer').children.every(node => paperEdges(node.children[0]).length === 0));
  assert.equal(paperEdges(pileTop(ui, 'draw-pile')).length, 5);
  ui.enter(); ui.key('e'); assert.equal(ui.get('inspect-overlay').hidden, true);
  await ui.advance(60); assert.equal(ui.get('draw-count').textContent, '22');
  await ui.advance(65); assert.equal(ui.get('draw-pile-card').dataset.face, 'front');
  await ui.advance(125); assert.equal(ui.get('card-motion-layer').children.length, 4);
  assert.equal(ui.cards().length, 7); assert.equal(ui.get('probe-card').style.left, left);
  await ui.advance(240);
  assert.equal(ui.get('card-motion-layer').children.length, 0); assert.equal(ui.cards().length, 11);
  assert.equal(ui.get('draw-count').textContent, '19'); assert.equal(ui.get('discard-count').textContent, '8');
  assert.equal(ui.get('draw-one').disabled, false);
  assert.deepEqual(ui.cards().slice(-5).map(card => card.dataset.instanceId), ['draw-0', 'draw-1', 'draw-2', 'draw-3', 'draw-4']);
  assert.ok(ui.cards().every(card => card.dataset.face === 'front'));
  assert.ok(ui.animations.every(animation => animation.playState === 'idle'));
  for (const image of cardImages(ui)) {
    assert.equal(image.decodeCalls, 1); assert.equal(image.srcWrites.length, 1);
  }
});

test('discard animation retains the old top until landing and then exposes the ordered new top', async () => {
  const ui = await page({animationsEnabled: true});
  ui.cards()[2].fire('click'); ui.cards()[0].fire('click'); await ui.click('discard-selected');
  assert.equal(ui.get('card-motion-layer').children.length, 2);
  assert.equal(pileTop(ui, 'discard-pile').dataset.instanceId, 'discard-7');
  assert.equal(ui.get('discard-count').textContent, '8');
  await ui.advance(250);
  assert.equal(pileTop(ui, 'discard-pile').dataset.instanceId, 'hand-0');
  assert.equal(ui.get('discard-count').textContent, '9');
  await ui.advance(60);
  assert.equal(pileTop(ui, 'discard-pile').dataset.instanceId, 'hand-2');
  assert.equal(paperEdges(ui.get('discard-pile-card')).length, 0);
  assert.equal(paperEdges(pileTop(ui, 'discard-pile')).length, 5);
  assert.equal(ui.get('discard-count').textContent, '10'); assert.equal(ui.cards().length, 4);
  assert.equal(ui.get('card-motion-layer').children.length, 0);
});

test('interrupted animation snaps to its committed result and late callbacks cannot change it', async () => {
  for (const interruption of ['blur', 'hidden', 'resize', 'pagehide']) {
    const ui = await page({animationsEnabled: true}); await ui.click('draw-many');
    await ui.advance(40);
    if (interruption === 'hidden') {ui.document.hidden = true; ui.document.fire('visibilitychange');}
    else if (interruption === 'resize') ui.resize(500, 110);
    else ui.window.fire(interruption, {persisted: true});
    await settle();
    assert.equal(ui.get('card-motion-layer').children.length, 0, interruption);
    assert.equal(ui.cards().length, 11, interruption); assert.equal(ui.get('draw-count').textContent, '19');
    assert.equal(ui.get('probe-table').getAttribute('aria-busy'), 'false');
    assert.ok(ui.cards().every(card => card.dataset.face === 'front'));
    assert.equal(ui.timers.size, 0);
    await ui.advance(2000); assert.equal(ui.cards().length, 11);
  }
});

test('reset during flight and reset during decoding preserve the next operation', async () => {
  const ui = await page({animationsEnabled: true}); await ui.click('draw-many');
  await ui.click('reset-demo'); assert.equal(ui.cards().length, 6); assert.equal(ui.get('draw-count').textContent, '24');
  await ui.click('draw-one'); await ui.advance(250);
  assert.equal(ui.cards().length, 7); assert.equal(ui.get('draw-count').textContent, '23');
  assert.equal(ui.get('card-motion-layer').children.length, 0); assert.equal(ui.timers.size, 0);
  const pending = await page({pendingImages: ['back-image'], animationsEnabled: true});
  pending.get('probe-card').fire('click'); await pending.click('discard-selected');
  assert.equal(pending.get('probe-table').getAttribute('aria-busy'), 'true');
  await pending.click('reset-demo'); await pending.decoded('back-image');
  assert.equal(pending.cards().length, 6); assert.equal(pending.get('discard-count').textContent, '8');
  assert.equal(pending.get('probe-table').getAttribute('aria-busy'), 'false');
});

test('reduced motion and unavailable browser animations update piles without leaving moving elements', async () => {
  for (const options of [{reducedMotion: true}, {animationFailure: true}]) {
    const ui = await page({animationsEnabled: true, ...options}); await ui.click('draw-many');
    assert.equal(ui.cards().length, 11); assert.equal(ui.get('draw-count').textContent, '19');
    assert.equal(ui.get('card-motion-layer').children.length, 0); assert.equal(ui.timers.size, 0);
    assert.equal(ui.get('probe-table').getAttribute('aria-busy'), 'false');
  }
});

test('shuffle preview flips, splits and reunites a packet while preserving the hand and decoded images', async () => {
  const ui = await page({animationsEnabled: true}), hand = ui.cards();
  await ui.click('shuffle-demo');
  const layer = ui.get('card-motion-layer'), packet = layer.children[0];
  assert.equal(layer.children.length, 1); assert.equal(packet.className, 'shuffle-packet');
  const sheets = packet.children.filter(node => node.className === 'shuffle-sheet');
  assert.equal(sheets.length, 6); assert.equal(packet.children.length, sheets.length);
  assert.deepEqual(ui.cards(), hand); assert.equal(ui.get('shuffle-demo').disabled, true);
  assert.equal(ui.get('draw-count').textContent, '0'); assert.equal(ui.get('discard-count').textContent, '0');
  assert.equal(sheets.at(-1).children[0].dataset.face, 'front');
  await ui.advance(140);
  assert.ok(sheets.every(sheet => sheet.children[0].dataset.face === 'back'));
  await ui.advance(510);
  assert.equal(layer.children.length, 0); assert.equal(ui.timers.size, 0);
  assert.equal(ui.get('draw-count').textContent, '32'); assert.equal(ui.get('discard-count').textContent, '0');
  assert.equal(pileTop(ui, 'draw-pile').dataset.face, 'back'); assert.equal(pileTop(ui, 'discard-pile'), undefined);
  assert.deepEqual(ui.cards(), hand); assert.equal(ui.get('shuffle-demo').disabled, false);
  assert.ok(ui.animations.every(animation => animation.playState === 'idle'));
  for (const image of cardImages(ui)) {
    assert.equal(image.decodeCalls, 1); assert.equal(image.srcWrites.length, 1);
  }
});

test('shuffle can follow a truly empty draw pile and can be replayed or skipped for reduced motion', async () => {
  const ui = await page(); await ui.count(0); ui.get('draw-quantity').value = '30';
  await ui.click('draw-many'); assert.equal(ui.get('draw-count').textContent, '0');
  await ui.click('shuffle-demo');
  assert.equal(ui.cards().length, 24); assert.equal(ui.get('draw-count').textContent, '8');
  assert.equal(ui.get('discard-count').textContent, '0');
  await ui.click('shuffle-demo'); assert.equal(ui.get('draw-count').textContent, '8');
  await ui.click('draw-one'); assert.equal(ui.cards().length, 25); assert.equal(ui.get('draw-count').textContent, '7');
  for (const options of [{reducedMotion: true}, {animationFailure: true}]) {
    const fallback = await page({animationsEnabled: true, ...options}); await fallback.click('shuffle-demo');
    assert.equal(fallback.get('draw-count').textContent, '32'); assert.equal(fallback.get('discard-count').textContent, '0');
    assert.equal(fallback.get('card-motion-layer').children.length, 0); assert.equal(fallback.timers.size, 0);
    assert.equal(fallback.get('probe-table').getAttribute('aria-busy'), 'false');
  }
});

test('shuffle interruption and reset remove every temporary sheet and ignore late completion', async () => {
  for (const interruption of ['blur', 'hidden', 'resize', 'pagehide', 'reset']) {
    const ui = await page({animationsEnabled: true}); await ui.click('shuffle-demo');
    const late = ui.animations.find(animation => animation.element.className === 'shuffle-packet').onfinish;
    await ui.advance(180);
    if (interruption === 'hidden') {ui.document.hidden = true; ui.document.fire('visibilitychange');}
    else if (interruption === 'resize') ui.resize(500, 110);
    else if (interruption === 'reset') await ui.click('reset-demo');
    else ui.window.fire(interruption, {persisted: true});
    await settle(); late(); await ui.advance(2000);
    assert.equal(ui.get('card-motion-layer').children.length, 0, interruption);
    assert.equal(ui.timers.size, 0); assert.equal(ui.cards().length, 6);
    assert.equal(ui.get('draw-count').textContent, interruption === 'reset' ? '24' : '32');
    assert.equal(ui.get('discard-count').textContent, interruption === 'reset' ? '8' : '0');
    assert.equal(ui.get('probe-table').getAttribute('aria-busy'), 'false');
    assert.ok(ui.animations.every(animation => animation.playState === 'idle'));
  }
});

function browserCards(ui) {
  return ui.get('pile-browser-grid').children.filter(node => node.className === 'pile-browser-entry' && !node.hidden)
    .map(entry => entry.children[0]);
}

for (const [kind, total] of [['draw', 24], ['discard', 8]]) {
  test(`the probe's ${kind} sync scenario visibly removes and restores cards while its browser stays open`, async () => {
    const ui = await page(); await ui.click(`test-${kind}-sync`);
    assert.equal(ui.get('pile-browser').hidden, false);
    assert.equal(ui.get('pile-browser').dataset.pile, kind);
    assert.equal(browserCards(ui).length, total);
    await ui.advance(2000);
    assert.equal(ui.get('pile-browser').hidden, false); assert.equal(browserCards(ui).length, total - 2);
    assert.equal(ui.get('pile-browser-count').textContent, `${total - 2} 张`);
    await ui.advance(2000);
    assert.equal(ui.get('pile-browser').hidden, false); assert.equal(browserCards(ui).length, total);
    assert.equal(ui.get('pile-browser-count').textContent, `${total} 张`);
    assert.equal(ui.get('probe-shell').inert, true); ui.key('Escape');
    assert.equal(ui.get('probe-shell').inert, false);
  });
}

test('resetting or leaving the probe cancels a queued external sync scenario', async () => {
  const ui = await page(); await ui.click('test-draw-sync');
  await ui.click('reset-demo'); await ui.advance(4000);
  assert.equal(ui.get('pile-browser').hidden, true); assert.equal(ui.get('draw-count').textContent, '24');
  await ui.click('test-discard-sync'); ui.window.fire('pagehide', {persisted: false});
  await ui.advance(4000); assert.equal(ui.timers.size, 0);
});

test('a later demo action cannot be overwritten by a previous sync scenario restoring its snapshot', async () => {
  const ui = await page(); await ui.click('test-draw-sync'); await ui.advance(2000);
  ui.key('Escape'); await ui.click('draw-one');
  pileTop(ui, 'discard-pile').fire('click'); await settle(); await ui.advance(2000);
  assert.equal(ui.cards().length, 7); assert.equal(ui.get('draw-count').textContent, '21');
  assert.equal(ui.get('pile-browser-count').textContent, '10 张'); assert.equal(ui.get('pile-browser').hidden, false);
});

test('draw-pile browsing sorts all instances by card ID without revealing or changing the real top', async () => {
  const ui = await page(); await ui.click('draw-pile-card');
  assert.equal(ui.get('pile-browser').hidden, false); assert.equal(ui.get('pile-browser-title').textContent, '抽牌堆');
  assert.equal(ui.get('pile-browser-count').textContent, '24 张');
  assert.equal(ui.all.some(node => node.id === 'pile-browser-order' || node.id === 'pile-browser-help'), false);
  assert.equal(ui.get('draw-pile-card').getAttribute('title'), null);
  const cards = browserCards(ui), ids = cards.map(card => card.dataset.cardId);
  assert.equal(cards.length, 24); assert.equal(new Set(cards.map(card => card.dataset.instanceId)).size, 24);
  assert.deepEqual(ids, [...ids].sort()); assert.equal(ids[0], 'TS-0001');
  assert.ok(cards.every(card => card.dataset.face === 'front'));
  assert.equal(ui.get('draw-pile-card').dataset.face, 'back');
  assert.equal(paperEdges(ui.get('draw-pile-card')).length, 5);
  assert.equal(ui.document.activeElement, ui.get('close-pile-browser'));
  await ui.click('close-pile-browser');
  await ui.click('draw-one');
  assert.equal(ui.cards().at(-1).dataset.instanceId, 'draw-0');
  assert.equal(ui.cards().at(-1).dataset.cardId, 'TS-0002');
  assert.equal(ui.get('draw-count').textContent, '23');
});

test('discard-pile browsing shows top-to-bottom order, including duplicate cards and newly discarded instances', async () => {
  const ui = await page(); await ui.click('discard-pile-card');
  assert.equal(ui.get('pile-browser-title').textContent, '弃牌堆');
  assert.equal(ui.get('discard-pile-card').getAttribute('title'), null);
  assert.deepEqual(browserCards(ui).map(card => card.dataset.instanceId),
    ['discard-7', 'discard-6', 'discard-5', 'discard-4', 'discard-3', 'discard-2', 'discard-1', 'discard-0']);
  assert.equal(browserCards(ui).filter(card => card.dataset.cardId === 'TS-0336').length, 2);
  await ui.click('close-pile-browser');
  ui.cards()[0].fire('click'); ui.cards()[2].fire('click'); await ui.click('discard-selected');
  const top = pileTop(ui, 'discard-pile'); top.fire('click'); await settle();
  assert.equal(ui.get('pile-browser-count').textContent, '10 张');
  assert.deepEqual(browserCards(ui).slice(0, 3).map(card => card.dataset.instanceId), ['hand-2', 'hand-0', 'discard-7']);
  browserCards(ui)[0].fire('click');
  assert.equal(ui.get('discard-count').textContent, '10'); assert.equal(ui.cards().length, 4);
  assert.equal(ui.get('discard-selected').disabled, true);
});

test('browser E inspection owns the overlay while the table is inert, then closing restores pile focus', async () => {
  const ui = await page(); await ui.click('draw-pile-card');
  assert.equal(ui.get('probe-shell').inert, true); assert.equal(ui.get('probe-header').inert, true);
  ui.enter(); ui.key('e'); assert.equal(ui.get('inspect-overlay').hidden, true);
  const first = browserCards(ui)[0]; first.fire('pointerenter');
  assert.equal(ui.get('inspect-overlay').hidden, false); assert.equal(ui.inspecting().length, 1);
  const [front, back] = ui.inspecting()[0].children;
  assert.equal(front.src, `/cards/${first.dataset.cardId}.png`); assert.equal(front.hidden, false); assert.equal(back.hidden, true);
  assert.deepEqual([front.width, front.height], [504, 704]);
  const handCount = ui.cards().length; await ui.click('draw-one'); assert.equal(ui.cards().length, handCount);
  ui.key('Escape');
  assert.equal(ui.get('pile-browser').hidden, true); assert.equal(ui.get('inspect-overlay').hidden, true);
  assert.equal(ui.get('probe-shell').inert, false); assert.equal(ui.get('probe-header').inert, false);
  assert.equal(ui.document.activeElement, ui.get('draw-pile-card'));
  assert.equal(ui.get('draw-pile-card').dataset.face, 'back');
  await ui.click('draw-pile-card'); assert.equal(browserCards(ui)[0], first);
  ui.release();
  for (const image of cardImages(ui)) {
    assert.equal(image.decodeCalls, 1); assert.equal(image.srcWrites.length, 1);
  }
});

test('browser focus stays inside the dialog and backdrop clicks close it without closing for card clicks', async () => {
  const ui = await page(); await ui.click('discard-pile-card');
  const last = browserCards(ui).at(-1), close = ui.get('close-pile-browser');
  assert.equal(ui.key('Tab', {altKey: true}).defaultPrevented, false);
  assert.equal(ui.key('Tab', {shiftKey: true}).defaultPrevented, true);
  assert.equal(ui.document.activeElement, last);
  assert.equal(ui.key('Tab').defaultPrevented, true); assert.equal(ui.document.activeElement, close);
  ui.get('pile-browser').fire('click', {target: last}); assert.equal(ui.get('pile-browser').hidden, false);
  ui.get('pile-browser').fire('click');
  assert.equal(ui.get('pile-browser').hidden, true); assert.equal(ui.get('probe-shell').inert, false);
});

test('an empty pile can be browsed and animation blocks opening a stale pile view', async () => {
  const ui = await page(); await ui.count(0); ui.get('draw-quantity').value = '30'; await ui.click('draw-many');
  const empty = ui.get('draw-pile').children.find(node => node.className === 'pile-empty');
  assert.equal(empty.tagName, 'button'); empty.fire('click'); await settle();
  assert.equal(ui.get('pile-browser').hidden, false); assert.equal(browserCards(ui).length, 0);
  assert.equal(ui.get('pile-browser-count').textContent, '0 张'); assert.equal(ui.get('pile-browser-empty').hidden, false);
  assert.equal(ui.key('Tab').defaultPrevented, true);
  ui.key('Escape'); assert.equal(ui.document.activeElement, empty);
  const moving = await page({animationsEnabled: true}); await moving.click('draw-many');
  pileTop(moving, 'draw-pile').fire('click');
  assert.equal(moving.get('pile-browser').hidden, true); await moving.advance(490);
  pileTop(moving, 'draw-pile').fire('click'); await settle();
  assert.equal(moving.get('pile-browser').hidden, false); assert.equal(browserCards(moving).length, 19);
});

test('reset and disposal close browsing and remove E inspection and modal keyboard handlers', async () => {
  const ui = await page(); await ui.click('discard-pile-card');
  browserCards(ui)[0].fire('pointerenter'); ui.key('e');
  await ui.click('reset-demo');
  assert.equal(ui.get('pile-browser').hidden, true); assert.equal(ui.get('inspect-overlay').hidden, true);
  assert.equal(ui.get('probe-shell').inert, false);
  await ui.click('draw-pile-card'); ui.window.fire('pagehide', {persisted: false});
  assert.equal(ui.get('pile-browser').hidden, true); assert.equal(ui.get('probe-header').inert, false);
  await ui.click('discard-pile-card'); assert.equal(ui.get('pile-browser').hidden, true);
  assert.equal(ui.key('Escape').defaultPrevented, false);
});

const handIds = ui => ui.cards().map(card => card.dataset.instanceId);
const sortedHandIds = ui => ui.cards().map(card => card.dataset.cardId);
const dropSlot = ui => ui.get('hand-track').children.find(node => node.className === 'hand-drop-slot');

test('dragging previews an insertion slot, shifts neighbors and commits the same instances without selecting them', async () => {
  const ui = await page();
  assert.equal(ui.get('auto-sort-hand').checked, false); assert.doesNotMatch(html, /从左向右/);
  await ui.click('probe-card');
  const card = ui.get('probe-card'), neighbor = ui.get('probe-hand-1');
  const oldNeighbor = Number.parseFloat(neighbor.style.left), last = ui.cards().at(-1).getBoundingClientRect();
  const point = ui.down(); ui.pointer('pointermove', last.left + 12);
  assert.equal(card.dataset.dragging, 'true'); assert.equal(card.dataset.selected, 'true');
  assert.equal(Number.parseFloat(neighbor.style.left), oldNeighbor - 158);
  assert.equal(dropSlot(ui).hidden, false); assert.equal(Number.parseFloat(dropSlot(ui).style.left), last.left - 200);
  assert.ok(Number(card.style.zIndex) > Number(neighbor.style.zIndex));
  assert.equal(ui.get('draw-one').disabled, true);
  assert.equal(ui.get('auto-sort-hand').disabled, true);
  ui.key('e'); assert.equal(ui.get('inspect-overlay').hidden, true);
  await ui.click('draw-one'); assert.equal(ui.cards().length, 6);
  await ui.click('draw-pile-card'); assert.equal(ui.get('pile-browser').hidden, true);
  ui.pointer('pointerup', last.left + 12);
  assert.equal(card.dataset.dragging, 'false'); assert.equal(card.dataset.dropping, 'true');
  assert.ok(Number(card.style.zIndex) > Number(neighbor.style.zIndex));
  assert.equal(card.captured.size, 0); assert.equal(dropSlot(ui).hidden, true);
  assert.equal(card.fire('click').defaultPrevented, true);
  assert.equal(card.dataset.selected, 'true');
  await ui.advance(160);
  assert.equal(card.dataset.dropping, 'false'); assert.equal(ui.get('draw-one').disabled, false);
  assert.deepEqual(handIds(ui), ['hand-1', 'hand-2', 'hand-3', 'hand-4', 'hand-5', 'hand-0']);
  assert.equal(ui.cards().at(-1), card);
  card.fire('pointermove');
  assert.equal(card.dataset.active, 'true'); assert.equal(ui.get('inspect-overlay').hidden, false);
  ui.release();
  // The controller must use the new order too, including for the discard pile's top-to-bottom order.
  await ui.click('discard-all'); await ui.click('probe-card');
  assert.deepEqual(browserCards(ui).slice(0, 6).map(card => card.dataset.instanceId),
    ['hand-0', 'hand-5', 'hand-4', 'hand-3', 'hand-2', 'hand-1']);
  assert.ok(point.clientX < last.left);
});

test('dense-hand drag remains inside the hand at both edges and shows the same slot for the same pointer position', async () => {
  const ui = await page({width: 460}); await ui.count(30);
  const original = ui.cards(), first = original[0], last = original.at(-1), track = ui.get('hand-track');
  ui.down(); ui.pointer('pointermove', 10000, {clientY: -1000});
  assert.equal(first.getBoundingClientRect().right, track.getBoundingClientRect().right);
  assert.equal(first.getBoundingClientRect().top, track.getBoundingClientRect().top);
  const preview = Number.parseFloat(last.style.left), slot = dropSlot(ui).style.left;
  ui.pointer('pointermove', 10000, {clientY: 10000});
  assert.equal(last.style.left, `${preview}px`); assert.equal(dropSlot(ui).style.left, slot);
  ui.pointer('pointerup', 10000); await ui.advance(160);
  assert.equal(ui.cards().at(-1), first);
  ui.down(first.id); ui.pointer('pointermove', -10000, {clientY: 10000});
  assert.equal(first.getBoundingClientRect().left, track.getBoundingClientRect().left);
  ui.pointer('pointerup', -10000); await ui.advance(160);
  assert.deepEqual(ui.cards(), original);
  assert.equal(new Set(handIds(ui)).size, 30);
  ui.cards().forEach((card, index) => assert.equal(Number(card.style.zIndex), index + 1));
});

test('short clicks still select, unrelated pointers cannot move the drag, and dropping uses the final pointer position', async () => {
  const ui = await page(), card = ui.get('probe-card');
  const start = ui.down(); ui.pointer('pointermove', start.clientX + 3);
  ui.pointer('pointerup', start.clientX + 3); card.fire('click');
  assert.equal(card.dataset.selected, 'true'); assert.notEqual(card.dataset.dragging, 'true');
  assert.equal(ui.get('draw-one').disabled, false);
  ui.down(); ui.pointer('pointermove', 10000, {pointerId: 2});
  assert.notEqual(card.dataset.dragging, 'true');
  ui.pointer('pointerup', 10000, {pointerId: 2}); assert.equal(card.captured.has(1), true);
  ui.pointer('pointerup', 10000); card.fire('click'); await ui.advance(160);
  assert.equal(ui.cards().at(-1), card); assert.equal(card.dataset.selected, 'true');
  // A keyboard click after a drag is still a selection action, not a suppressed synthetic pointer click.
  card.fire('click', {detail: 0}); assert.equal(card.dataset.selected, 'false');
});

test('cancelled or interrupted hand gestures revert their preview, release capture and unlock the table', async () => {
  for (const reason of ['escape', 'cancel', 'lostcapture', 'resize', 'blur', 'hidden']) {
    const ui = await page(), before = handIds(ui), card = ui.get('probe-card');
    ui.down(); ui.pointer('pointermove', 10000);
    if (reason === 'escape') assert.equal(ui.key('Escape').defaultPrevented, true);
    else if (reason === 'cancel') ui.pointer('pointercancel', 10000);
    else if (reason === 'lostcapture') card.releasePointerCapture(1);
    else if (reason === 'resize') ui.resize(460);
    else if (reason === 'blur') ui.window.fire('blur');
    else {ui.document.hidden = true; ui.document.fire('visibilitychange');}
    assert.deepEqual(handIds(ui), before, reason);
    assert.equal(dropSlot(ui).hidden, true, reason);
    assert.equal(ui.get('draw-one').disabled, false, reason);
    assert.equal(card.captured.size, 0, reason);
    assert.equal(card.dataset.dragging, 'false', reason);
    assert.equal(ui.get('hand-track').dataset.reordering, 'false', reason);
    ui.pointer('pointerup', 10000); await ui.advance(1000);
    assert.deepEqual(handIds(ui), before, reason);
  }
});

test('reset and page disposal remove a drag or its settling timer without stale callbacks changing the new hand', async () => {
  for (const committed of [false, true]) {
    const ui = await page(); ui.down(); ui.pointer('pointermove', 10000);
    if (committed) ui.pointer('pointerup', 10000);
    await ui.click('reset-demo'); await ui.advance(1000);
    assert.deepEqual(handIds(ui), ['hand-0', 'hand-1', 'hand-2', 'hand-3', 'hand-4', 'hand-5']);
    assert.equal(ui.get('probe-table').getAttribute('aria-busy'), 'false');
    ui.down(); ui.pointer('pointermove', 10000); ui.window.fire('pagehide', {persisted: false});
    assert.equal(ui.get('probe-card').captured.size, 0); assert.equal(ui.timers.size, 0);
    ui.pointer('pointerup', 10000); assert.equal(ui.get('hand-track').dataset.reordering, 'false');
  }
});

test('automatic arrangement sorts all hand cards and newly drawn cards, keeping equal-ID instances stable', async () => {
  const ui = await page({animationsEnabled: true});
  await ui.autoSort(true); assert.equal(ui.get('draw-one').disabled, true); await ui.advance(160);
  assert.deepEqual(handIds(ui), ['hand-1', 'hand-2', 'hand-3', 'hand-4', 'hand-0', 'hand-5']);
  ui.down('probe-hand-1'); ui.pointer('pointermove', 10000); ui.pointer('pointerup', 10000);
  assert.equal(dropSlot(ui).hidden, true); assert.equal(ui.get('draw-one').disabled, false);
  await ui.click('draw-many');
  // Enabling auto sort must place incoming cards at their final sorted slots before they fly in.
  assert.equal(ui.get('hand-track').dataset.autoSort, 'true');
  await ui.advance(490);
  assert.deepEqual(sortedHandIds(ui), [...sortedHandIds(ui)].sort());
  assert.deepEqual(ui.cards().filter(card => card.dataset.cardId === 'TS-0002').map(card => card.dataset.instanceId),
    ['hand-2', 'draw-0']);
  assert.equal(new Set(handIds(ui)).size, 11);
  await ui.click('probe-hand-2'); await ui.click('discard-selected'); await ui.advance(250);
  assert.deepEqual(sortedHandIds(ui), [...sortedHandIds(ui)].sort());
  await ui.count(18); assert.equal(ui.get('auto-sort-hand').checked, true);
  assert.deepEqual(sortedHandIds(ui), [...sortedHandIds(ui)].sort());
  await ui.click('reset-demo'); assert.equal(ui.get('auto-sort-hand').checked, true);
  assert.deepEqual(handIds(ui), ['hand-1', 'hand-2', 'hand-3', 'hand-4', 'hand-0', 'hand-5']);
  await ui.autoSort(false); ui.down('probe-hand-1'); ui.pointer('pointerup', 10000); await ui.advance(160);
  assert.equal(ui.cards().at(-1).dataset.instanceId, 'hand-1');
  await ui.click('draw-one'); await ui.advance(250);
  assert.equal(ui.cards().at(-1).dataset.instanceId, 'draw-0');
});

test('auto sort and dragging cannot race a deal, modal browser or another active drag', async () => {
  const ui = await page({animationsEnabled: true}); await ui.click('draw-many');
  await ui.autoSort(true); assert.equal(ui.get('auto-sort-hand').checked, false);
  ui.down(); ui.pointer('pointermove', 10000); assert.equal(dropSlot(ui).hidden, true);
  await ui.advance(490);
  pileTop(ui, 'draw-pile').fire('click'); await settle(); ui.down(); ui.pointer('pointermove', 10000);
  assert.equal(dropSlot(ui).hidden, true); ui.key('Escape');
  ui.down(); ui.pointer('pointermove', 10000);
  await ui.autoSort(true); assert.equal(ui.get('auto-sort-hand').checked, false);
  ui.pointer('pointerup', 10000); await ui.advance(160);
  assert.equal(ui.cards().at(-1).id, 'probe-card');
});

test('non-primary, modified, empty and single-card gestures do not reorder; reduced motion settles immediately', async () => {
  const ui = await page();
  for (const fields of [{button: 2}, {isPrimary: false}, {altKey: true}]) {
    ui.down('probe-card', fields); ui.pointer('pointermove', 10000); ui.pointer('pointerup', 10000);
    assert.equal(dropSlot(ui).hidden, true);
  }
  await ui.count(1); ui.down(); ui.pointer('pointerup', 10000);
  assert.equal(ui.get('draw-one').disabled, false); assert.equal(ui.timers.size, 0);
  await ui.count(0); await ui.autoSort(true); assert.equal(ui.cards().length, 0);
  const reduced = await page({reducedMotion: true});
  reduced.down(); reduced.pointer('pointerup', 10000);
  assert.equal(reduced.cards().at(-1).id, 'probe-card'); assert.equal(reduced.timers.size, 0);
  assert.equal(reduced.get('draw-one').disabled, false);
  await reduced.autoSort(true); assert.equal(reduced.timers.size, 0);
  assert.deepEqual(sortedHandIds(reduced), [...sortedHandIds(reduced)].sort());
});

test('cursor drag marker activates only after moving a card and clears on release before the settling animation', async () => {
  const ui = await page(), card = ui.get('probe-card');
  const dragging = () => ui.cards().some(item => item.dataset.dragging === 'true');
  ui.enter(); ui.key('e'); assert.equal(dragging(), false); ui.release();
  ui.window.fire('pointerdown', {target: ui.get('probe-table'), buttons: 1});
  assert.equal(dragging(), false);
  const first = ui.down(); assert.equal(dragging(), false);
  ui.pointer('pointermove', first.clientX + 3, {buttons: 1}); assert.equal(dragging(), false);
  ui.pointer('pointerup', first.clientX + 3); card.fire('click');
  assert.equal(card.dataset.selected, 'true'); assert.equal(dragging(), false);
  const second = ui.down(); ui.pointer('pointermove', second.clientX + 6, {buttons: 1});
  assert.equal(dragging(), true);
  ui.pointer('pointerup', second.clientX + 6);
  assert.equal(card.dataset.dropping, 'true'); assert.equal(dragging(), false);
  await ui.advance(160); assert.equal(dragging(), false);
  await ui.autoSort(true); assert.equal(dragging(), false);
  await ui.advance(160);
  ui.down(); ui.pointer('pointermove', 10000, {buttons: 1}); assert.equal(dragging(), false);
  ui.pointer('pointerup', 10000); assert.equal(dragging(), false);
});
