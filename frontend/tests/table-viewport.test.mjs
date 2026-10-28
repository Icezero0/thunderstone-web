import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';

const source = await readFile(new URL('../.test-dist/table-viewport.js', import.meta.url), 'utf8');
const html = '<html><body><div id="camera"><div id="desktop"><section id="area"><button id="card"></button></section></div></div></body></html>';
const rect = (left, top, width, height) => ({left, top, width, height, right: left + width, bottom: top + height});
async function setup({observer = true, cameraOptions = {}} = {}) {
  const ui = await page({html, source, observer}), viewport = ui.get('camera'), desktop = ui.get('desktop');
  const size = {width: 300, height: 180, desktopWidth: 900, desktopHeight: 600}, changes = [];
  Object.defineProperties(viewport, {clientWidth: {get: () => size.width}, clientHeight: {get: () => size.height}});
  Object.defineProperties(desktop, {scrollWidth: {get: () => size.desktopWidth}, scrollHeight: {get: () => size.desktopHeight}});
  viewport.getBoundingClientRect = () => rect(10, 20, size.width, size.height);
  const Controller = ui.evaluate('ViewportPackage.TableViewport');
  const camera = new Controller(viewport, desktop, {...cameraOptions, onPanningChange: value => changes.push(value)});
  const position = () => ({...camera.position});
  ui.get('area').getBoundingClientRect = () => rect(10 + camera.position.x + 650 * camera.zoom, 20 + camera.position.y + 320 * camera.zoom, 180 * camera.zoom, 120 * camera.zoom);
  return {ui, viewport, desktop, camera, size, changes, position,
    down(fields = {}) {return viewport.fire('pointerdown', {clientX: 100, clientY: 100, buttons: 1, ...fields});},
    move(x, y, fields = {}) {return ui.window.fire('pointermove', {clientX: x, clientY: y, buttons: 1, ...fields});},
    up(fields = {}) {return ui.window.fire('pointerup', fields);}};
}

test('camera bounds make every desktop edge reachable and clamp after viewport or content resizing', async () => {
  const {camera, size, desktop, ui, position} = await setup();
  camera.panTo(-10000, -10000); assert.deepEqual(position(), {x: -600, y: -420});
  assert.equal(desktop.style.transform, 'translate(-600px, -420px)');
  camera.panTo(500, 500); assert.deepEqual(position(), {x: 0, y: 0});
  camera.panTo(-123.4, -90.8); assert.deepEqual(position(), {x: -123, y: -91});
  camera.focusArea(ui.get('area')); assert.deepEqual(position(), {x: -600, y: -296});
  size.width = 1000; size.height = 700; ui.observers[0].callback();
  assert.deepEqual(position(), {x: 0, y: 0});
  size.width = 300; size.height = 180; camera.refresh(); camera.panTo(-600, -420);
  size.desktopWidth = 400; size.desktopHeight = 200; camera.refresh();
  assert.deepEqual(position(), {x: -100, y: -20}); camera.dispose();
});

test('authoritative layout can refresh an inert desktop without enabling player pan or zoom', async () => {
  const {camera, size, viewport, ui, down, move, position} = await setup({cameraOptions: {centerContent: true}});
  size.width = 1000; size.height = 700; camera.refresh();
  assert.deepEqual(position(), {x: 50, y: 50});
  viewport.inert = true; size.desktopWidth = 600; camera.refresh();
  assert.deepEqual(position(), {x: 200, y: 50});
  down(); move(0, 0); camera.panTo(0, 0);
  assert.deepEqual(position(), {x: 200, y: 50}); assert.equal(camera.isPanning, false);
  camera.dispose();
});

test('dragging starts after a threshold, translates both axes and suppresses the resulting click', async () => {
  const {camera, down, move, up, viewport, changes, position} = await setup();
  camera.panTo(-100, -100); down(); move(98, 98);
  assert.equal(camera.isPanning, false); assert.deepEqual(position(), {x: -100, y: -100});
  move(40, 55); assert.equal(camera.isPanning, true); assert.deepEqual(position(), {x: -160, y: -145});
  assert.equal(viewport.dataset.panning, 'true'); assert.equal(viewport.captured.has(1), true);
  move(-5000, -5000); assert.deepEqual(position(), {x: -600, y: -420});
  up(); assert.equal(viewport.dataset.panning, 'false'); assert.equal(viewport.captured.size, 0);
  assert.deepEqual(changes, [true, false]);
  const click = viewport.fire('click'); assert.equal(click.defaultPrevented, true); assert.equal(click.propagationStopped, true);
  down(); up(); assert.equal(viewport.fire('click').defaultPrevented, false); camera.dispose();
});

test('left clicks on cards remain card interactions; the middle button can drag from a card and modifiers cannot start panning', async () => {
  const {ui, camera, down, move, up, position} = await setup(), card = ui.get('card');
  down({target: card}); move(0, 0); assert.deepEqual(position(), {x: 0, y: 0}); assert.equal(camera.isPanning, false);
  for (const fields of [{altKey: true}, {ctrlKey: true}, {metaKey: true}, {isPrimary: false}, {button: 2}]) {
    down(fields); move(-100, -100); assert.equal(camera.isPanning, false);
  }
  const middle = down({target: card, button: 1, buttons: 4}); assert.equal(middle.defaultPrevented, true);
  move(0, 0, {buttons: 4}); assert.deepEqual(position(), {x: -100, y: -100}); assert.equal(camera.isPanning, true);
  up();
  down({target: card}); assert.equal(ui.get('camera').fire('click', {target: card}).defaultPrevented, false);
  camera.dispose();
});

test('opted-in card controls keep their click target until a drag starts and suppress only the drag click', async () => {
  const {ui, camera, viewport, down, move, up, position} = await setup(), card = ui.get('card');
  card.setAttribute('data-pan-start', '');
  const image = ui.document.createElement('img'); card.append(image);
  camera.panTo(-100, -100);
  down({target: image}); assert.equal(viewport.captured.size, 0);
  move(98, 98); up();
  assert.deepEqual(position(), {x: -100, y: -100});
  assert.equal(viewport.fire('click', {target: image}).defaultPrevented, false);
  down({target: image}); move(40, 55);
  assert.equal(viewport.captured.has(1), true); assert.equal(camera.isPanning, true);
  assert.deepEqual(position(), {x: -160, y: -145});
  // Descendant capture loss can bubble while the camera takes over a touch drag.
  viewport.fire('lostpointercapture', {target: card}); assert.equal(camera.isPanning, true);
  up(); const click = viewport.fire('click', {target: image});
  assert.equal(click.defaultPrevented, true); assert.equal(click.propagationStopped, true);
  down({target: image}); up(); assert.equal(viewport.fire('click', {target: image}).defaultPrevented, false);
  ui.get('area').setAttribute('data-no-pan', '');
  down({target: image}); move(-100, -100); up();
  assert.equal(camera.isPanning, false); assert.deepEqual(position(), {x: -160, y: -145}); camera.dispose();
});

test('capture loss, blur, Escape, cancellation and an inert modal background stop panning without undoing the view', async () => {
  for (const stop of ['blur', 'cancel', 'lost', 'escape', 'hidden', 'inert', 'released']) {
    const {ui, camera, viewport, down, move, position, changes} = await setup();
    down(); move(40, 60); const committed = position();
    if (stop === 'blur') ui.window.fire('blur');
    if (stop === 'cancel') ui.window.fire('pointercancel');
    if (stop === 'lost') viewport.releasePointerCapture(1);
    if (stop === 'escape') viewport.fire('keydown', {key: 'Escape'});
    if (stop === 'hidden') {ui.document.hidden = true; ui.document.fire('visibilitychange');}
    if (stop === 'inert') {viewport.inert = true; move(-200, -200);}
    if (stop === 'released') move(-200, -200, {buttons: 0});
    assert.equal(camera.isPanning, false, stop); assert.deepEqual(changes, [true, false], stop);
    move(-400, -400); assert.deepEqual(position(), committed, stop); camera.dispose();
  }
});

test('keyboard panning and focus reveal reach clipped cards without consuming the cards own keys', async () => {
  const {ui, camera, viewport, position} = await setup();
  viewport.fire('keydown', {key: 'ArrowRight'}); assert.deepEqual(position(), {x: -40, y: 0});
  viewport.fire('keydown', {key: 'ArrowDown', shiftKey: true}); assert.deepEqual(position(), {x: -40, y: -100});
  assert.equal(viewport.fire('keydown', {key: 'ArrowLeft', altKey: true}).defaultPrevented, false);
  assert.equal(viewport.fire('keydown', {target: ui.get('card'), key: 'ArrowRight'}).defaultPrevented, false);
  viewport.fire('keydown', {key: 'Home'}); assert.deepEqual(position(), {x: 0, y: 0});
  const card = ui.get('card');
  card.getBoundingClientRect = () => rect(10 + camera.position.x + 700, 20 + camera.position.y + 400, 100, 120);
  card.focus(); assert.deepEqual(position(), {x: -518, y: -358});
  camera.dispose();
});

test('resize fallback and disposal release observers, capture and listeners and ignore late callbacks', async () => {
  for (const observer of [true, false]) {
    const {ui, camera, viewport, desktop, size, down, move, changes} = await setup({observer});
    camera.panTo(-600, -420); size.width = 800; ui.window.fire('resize');
    assert.equal(camera.position.x, -100);
    down(); move(50, 50); camera.dispose(); camera.dispose();
    const committed = desktop.style.transform;
    move(-500, -500); viewport.fire('keydown', {key: 'Home'}); ui.window.fire('resize');
    for (const item of ui.observers) {assert.equal(item.disconnected, true); item.callback();}
    assert.equal(desktop.style.transform, committed); assert.equal(viewport.captured.size, 0);
    assert.deepEqual(changes, [true, false]); assert.throws(() => camera.panTo(0, 0), /disposed/);
  }
});

test('browser cancellation that already released capture still resumes card interactions', async () => {
  const {camera, viewport, down, move, changes} = await setup();
  down(); move(20, 20);
  viewport.releasePointerCapture = () => {throw new Error('Pointer is no longer active');};
  camera.finish(); assert.equal(viewport.dataset.panning, 'false'); assert.deepEqual(changes, [true, false]);
  camera.dispose();
});

test('the probe keeps every adjustment/test control outside the game and its supply browser only previews cards', async () => {
  const ui = await page(), table = ui.get('probe-table'), controls = ui.get('probe-debug-controls');
  for (const id of ['hand-count', 'fewer-cards', 'more-cards', 'draw-one', 'draw-many', 'draw-quantity', 'discard-selected', 'discard-all',
    'shuffle-demo', 'reset-demo', 'test-draw-sync', 'test-discard-sync', 'dungeon-demo-layout', 'show-rank-zero', 'show-rank-four',
    'take-supply-id', 'take-supply-top', 'reset-supplies', 'demo-treasures', 'demo-aside',
    'demo-response-action', 'demo-response-rest', 'demo-response-phase', 'demo-response-clear', 'test-player-reveal']) {
    assert.equal(table.contains(ui.get(id)), false, id); assert.equal(controls.contains(ui.get(id)), true, id);
  }
  assert.equal(controls.getAttribute('open'), null);
  assert.equal(ui.get('dungeon-panel').contains(ui.get('public-desktop')), true);
  assert.equal(ui.get('village-panel').contains(ui.get('village-desktop')), true);
  assert.equal(ui.get('public-desktop').contains(ui.get('village-area')), false);
  assert.equal(ui.get('public-desktop').contains(ui.get('village-tab')), false);
  await ui.click('village-tab');
  const pile = ui.get('village-probe-amazon-slot').children.find(node => node.className === 'physical-card');
  pile.fire('click'); await settle(); assert.equal(ui.get('village-probe-browser').hidden, false);
  assert.equal(ui.all.some(node => node.id === 'village-probe-browser-take' && node.isConnected), false);
});

test('panning the probe clears public hover/inspection, leaves the hand fixed and resumes Space afterward', async () => {
  const ui = await page({width: 600}), viewport = ui.get('dungeon-panel'), desktop = ui.get('public-desktop');
  const monster = ui.get('dungeon-probe-main-rank-1').children[1].children[0], hand = ui.get('probe-card');
  const handLeft = hand.style.left;
  monster.fire('pointerenter'); ui.key(' '); assert.equal(ui.get('dungeon-probe-inspect').hidden, false); ui.release();
  viewport.fire('pointerdown', {target: monster, button: 1, buttons: 4, clientX: 200, clientY: 200});
  ui.window.fire('pointermove', {buttons: 4, clientX: 80, clientY: 120});
  assert.equal(viewport.dataset.panning, 'true'); assert.equal(monster.dataset.active, 'false');
  ui.key(' '); assert.equal(ui.get('dungeon-probe-inspect').hidden, true);
  assert.equal(desktop.style.transform, 'translate(-120px, -80px) scale(1.5)'); assert.equal(hand.style.left, handLeft);
  ui.window.fire('pointerup'); assert.equal(viewport.dataset.panning, 'false');
  monster.fire('pointerenter'); assert.equal(ui.get('dungeon-probe-inspect').hidden, false);
  ui.release(); ui.window.fire('pagehide', {persisted: false});
  const committed = desktop.style.transform; ui.window.fire('pointermove', {buttons: 4, clientX: -100, clientY: -100});
  assert.equal(desktop.style.transform, committed);
});

test('hidden desktop resize callbacks preserve its camera, and reactivation clamps only against the new visible size', async () => {
  const {camera, viewport, desktop, size, ui, position} = await setup();
  camera.panTo(-500, -350); viewport.hidden = true;
  size.width = 0; size.height = 0; size.desktopWidth = 0; size.desktopHeight = 0;
  ui.observers[0].callback(); camera.panTo(0, 0);
  assert.deepEqual(position(), {x: -500, y: -350});
  assert.equal(desktop.style.transform, 'translate(-500px, -350px)');
  viewport.hidden = false; size.width = 500; size.height = 300; size.desktopWidth = 900; size.desktopHeight = 600;
  camera.refresh(); assert.deepEqual(position(), {x: -400, y: -300}); camera.dispose();
});

test('each public desktop remembers its own pan across tab changes and resize; the player list stays outside both surfaces', async () => {
  const ui = await page({width: 400}), dungeon = ui.get('dungeon-panel'), village = ui.get('village-panel');
  const drag = (view, dx, dy) => {
    view.fire('pointerdown', {buttons: 1, clientX: 200, clientY: 200});
    ui.window.fire('pointermove', {buttons: 1, clientX: 200 + dx, clientY: 200 + dy});
    ui.window.fire('pointerup');
  };
  drag(dungeon, -150, -100);
  await ui.click('village-tab'); drag(village, -70, -260);
  const dungeonPosition = ui.get('public-desktop').style.transform, villagePosition = ui.get('village-desktop').style.transform;
  for (let iteration = 0; iteration < 3; iteration++) {
    await ui.click('dungeon-tab'); ui.resize(400);
    assert.equal(ui.get('public-desktop').style.transform, dungeonPosition);
    assert.equal(village.hidden, true); assert.equal(ui.get('dungeon-tab').getAttribute('aria-selected'), 'true');
    await ui.click('village-tab'); ui.resize(400);
    assert.equal(ui.get('village-desktop').style.transform, villagePosition); assert.equal(dungeon.hidden, true);
  }
  assert.notEqual(dungeonPosition, villagePosition);
  const players = ui.get('probe-player-list'); assert.equal(players.children[1].children.length, 3);
  for (const id of ['public-desktop', 'village-desktop']) assert.equal(ui.get(id).contains(players), false);
  assert.equal(ui.get('probe-table').contains(players), true);
  ui.window.fire('pagehide', {persisted: false});
});

test('centered framing leaves draggable space on every side even when the entire desktop fits', async () => {
  const {camera, size, position, down, move, up, viewport} = await setup({cameraOptions: {centerContent: true, panPadding: 120}});
  size.width = 1000; size.height = 800; size.desktopWidth = 600; size.desktopHeight = 400;
  camera.refresh(); assert.deepEqual(position(), {x: 200, y: 200});
  down(); move(170, 60); up(); assert.deepEqual(position(), {x: 270, y: 160});
  camera.refresh(); assert.deepEqual(position(), {x: 270, y: 160}); // Refresh must not reset the user's framing.
  size.width = 1200; size.height = 900; camera.refresh();
  assert.deepEqual(position(), {x: 370, y: 210}); // Keep the same adjustment from the new center.
  viewport.fire('keydown', {key: 'Home'}); assert.deepEqual(position(), {x: 300, y: 250});
  camera.panTo(-10000, -10000); assert.deepEqual(position(), {x: -120, y: -120});
  camera.panTo(10000, 10000); assert.deepEqual(position(), {x: 720, y: 620});
  camera.dispose();
});

test('overflowing content retains its initial leading edge while extra pan room cannot lose the entire desktop', async () => {
  const {camera, size, position, viewport} = await setup({cameraOptions: {centerContent: true, panPadding: 240}});
  assert.deepEqual(position(), {x: 0, y: 0});
  camera.panTo(10000, 10000); assert.deepEqual(position(), {x: 236, y: 116});
  camera.panTo(-10000, -10000); assert.deepEqual(position(), {x: -836, y: -536});
  viewport.fire('keydown', {key: 'Home'}); assert.deepEqual(position(), {x: 0, y: 0});
  size.width = 1200; size.height = 1000; camera.refresh();
  assert.deepEqual(position(), {x: 150, y: 200});
  camera.dispose();
});

test('the public window centers fitting desktop axes and preserves manual framing through tab switches', async () => {
  const ui = await page(), dungeon = ui.get('dungeon-panel'), desktop = ui.get('public-desktop');
  Object.defineProperties(dungeon, {clientWidth: {get: () => 1400}, clientHeight: {get: () => 1000}});
  ui.resize(1400); assert.equal(desktop.style.transform, 'translate(25px, 20px) scale(1.5)');
  dungeon.fire('pointerdown', {buttons: 1, clientX: 200, clientY: 200});
  ui.window.fire('pointermove', {buttons: 1, clientX: 270, clientY: 260}); ui.window.fire('pointerup');
  assert.equal(desktop.style.transform, 'translate(95px, 80px) scale(1.5)');
  await ui.click('village-tab'); ui.resize(1400); await ui.click('dungeon-tab');
  assert.equal(desktop.style.transform, 'translate(95px, 80px) scale(1.5)');
  ui.window.fire('pagehide', {persisted: false});
});

test('zoom preserves the world point under the cursor, updates scaled bounds and pans in screen pixels', async () => {
  const zooms = [], {camera, viewport, desktop, position, down, move, up} = await setup({cameraOptions: {
    centerContent: true, panPadding: 240, zoom: {min: .5, max: 2}, onZoomChange: zoom => zooms.push(zoom),
  }});
  camera.panTo(-100, -80); camera.setZoom(2, 120, 70);
  assert.equal(camera.zoom, 2); assert.deepEqual(position(), {x: -320, y: -230});
  assert.equal((120 - camera.position.x) / camera.zoom, 220);
  assert.equal((70 - camera.position.y) / camera.zoom, 150);
  assert.equal(desktop.style.transform, 'translate(-320px, -230px) scale(2)');
  down(); move(140, 135); up(); assert.deepEqual(position(), {x: -280, y: -195});
  camera.panTo(-10000, -10000); assert.deepEqual(position(), {x: -1736, y: -1136});
  camera.reset(); assert.equal(camera.zoom, 1); assert.deepEqual(position(), {x: 0, y: 0});
  camera.setZoom(.1); assert.equal(camera.zoom, .5);
  camera.setZoom(10); assert.equal(camera.zoom, 2);
  viewport.fire('keydown', {key: 'Home'}); assert.equal(camera.zoom, 1);
  assert.equal(desktop.style.transform, 'translate(0px, 0px)');
  assert.deepEqual(zooms, [2, 1, .5, 2, 1]); camera.dispose();
});

test('configured initial zoom controls framing and reset while min/max bound wheel and direct zoom', async () => {
  const {camera, viewport, desktop, size, ui, position} = await setup({cameraOptions: {
    centerContent: true, panPadding: 240, zoom: {min: .8, max: 2.5, initial: 1.5},
  }});
  assert.equal(camera.zoom, 1.5); assert.equal(desktop.style.transform, 'translate(0px, 0px) scale(1.5)');
  for (let index = 0; index < 20; index++) viewport.fire('wheel', {deltaY: -200});
  assert.equal(camera.zoom, 2.5);
  for (let index = 0; index < 20; index++) viewport.fire('wheel', {deltaY: 200});
  assert.equal(camera.zoom, .8);
  camera.setZoom(100); assert.equal(camera.zoom, 2.5);
  camera.setZoom(.1); assert.equal(camera.zoom, .8);
  size.width = 1500; size.height = 1100; camera.refresh();
  camera.reset(); assert.equal(camera.zoom, 1.5); assert.deepEqual(position(), {x: 75, y: 100});
  camera.setZoom(2); viewport.fire('keydown', {key: 'Home'});
  assert.equal(camera.zoom, 1.5); assert.deepEqual(position(), {x: 75, y: 100}); camera.dispose();
  for (const zoom of [{min: .8, max: 2.5, initial: 0}, {min: 1.6, max: 2.5, initial: 1.5},
    {min: .8, max: 1.4, initial: 1.5}, {min: .8, max: 2.5, initial: NaN}]) {
    await assert.rejects(setup({cameraOptions: {zoom}}), /include the initial scale/);
  }
});

test('wheel zoom handles pixel, line and page deltas, respects modifiers and editable/modal boundaries and cleans up on disposal', async () => {
  const disabled = await setup(); assert.equal(disabled.viewport.fire('wheel', {deltaY: -100}).defaultPrevented, false); disabled.camera.dispose();
  const {camera, viewport, ui, down, move, changes} = await setup({cameraOptions: {zoom: {min: .5, max: 2}}});
  const wheel = (fields = {}) => viewport.fire('wheel', {deltaY: -100, clientX: 160, clientY: 110, ...fields});
  for (const fields of [{altKey: true}, {ctrlKey: true}, {metaKey: true}, {deltaY: 0}, {deltaY: NaN}, {target: new ui.Element('input')}]) {
    assert.equal(wheel(fields).defaultPrevented, false); assert.equal(camera.zoom, 1);
  }
  viewport.hidden = true; assert.equal(wheel().defaultPrevented, false); viewport.hidden = false;
  viewport.inert = true; assert.equal(wheel().defaultPrevented, false); viewport.inert = false;
  assert.equal(wheel().defaultPrevented, true); assert.ok(camera.zoom > 1);
  camera.reset(); wheel({deltaY: -6.25, deltaMode: 1}); assert.ok(Math.abs(camera.zoom - Math.exp(.15)) < 1e-10);
  camera.reset(); wheel({deltaY: -100 / 180, deltaMode: 2}); assert.ok(Math.abs(camera.zoom - Math.exp(.15)) < 1e-10);
  down(); move(40, 60); assert.equal(camera.isPanning, true);
  wheel(); assert.equal(camera.isPanning, false); assert.equal(viewport.captured.size, 0); assert.deepEqual(changes, [true, false]);
  const zoom = camera.zoom; camera.dispose(); assert.equal(wheel().defaultPrevented, false); assert.equal(camera.zoom, zoom);
  assert.throws(() => camera.reset(), /disposed/); assert.throws(() => camera.setZoom(1), /disposed/);
});

test('reset restores fitting content to its centered initial view and keyboard focus still reveals cards after zooming', async () => {
  const {camera, viewport, size, position, ui} = await setup({cameraOptions: {centerContent: true, panPadding: 240, zoom: {min: .5, max: 2}}});
  camera.setZoom(2); camera.panTo(0, 0); ui.get('area').focus();
  assert.deepEqual(position(), {x: -1378, y: -718});
  size.width = 1000; size.height = 800; size.desktopWidth = 600; size.desktopHeight = 400;
  camera.refresh(); camera.reset(); assert.deepEqual(position(), {x: 200, y: 200}); assert.equal(camera.zoom, 1);
  camera.setZoom(2); viewport.fire('keydown', {key: 'Home'});
  assert.deepEqual(position(), {x: 200, y: 200}); assert.equal(camera.zoom, 1); camera.dispose();
});

test('the fixed reset button affects only the active tab, whose pan and zoom persist independently', async () => {
  const ui = await page({width: 400}), dungeon = ui.get('dungeon-panel'), village = ui.get('village-panel');
  const button = ui.get('reset-public-view'), dungeonDesktop = ui.get('public-desktop'), villageDesktop = ui.get('village-desktop');
  assert.equal(button.children.length, 1); assert.equal(button.children[0].tagName, 'svg');
  assert.ok(button.getAttribute('aria-label')); assert.ok(button.getAttribute('title'));
  assert.equal(button.parentElement, ui.get('public-table-viewport'));
  assert.equal(dungeon.contains(button), false); assert.equal(village.contains(button), false);
  const handLeft = ui.get('probe-card').style.left;
  dungeon.fire('wheel', {deltaY: -100, clientX: 200, clientY: 220});
  const dungeonView = dungeonDesktop.style.transform; assert.match(dungeonView, /scale\(/);
  await ui.click('village-tab'); village.fire('wheel', {deltaY: 100, clientX: 180, clientY: 220});
  const villageView = villageDesktop.style.transform; assert.match(villageView, /scale\(/);
  await ui.click('dungeon-tab'); assert.equal(dungeonDesktop.style.transform, dungeonView);
  assert.equal(button.getAttribute('aria-controls'), 'dungeon-panel');
  await ui.click('reset-public-view'); assert.equal(dungeonDesktop.style.transform, 'translate(0px, 0px) scale(1.5)');
  assert.equal(villageDesktop.style.transform, villageView);
  await ui.click('village-tab'); assert.equal(villageDesktop.style.transform, villageView);
  assert.equal(button.getAttribute('aria-controls'), 'village-panel');
  await ui.click('reset-public-view'); assert.equal(villageDesktop.style.transform, 'translate(0px, 0px) scale(1.5)');
  assert.equal(ui.get('probe-card').style.left, handLeft);
  ui.window.fire('pagehide', {persisted: false});
  const committed = villageDesktop.style.transform; village.fire('wheel', {deltaY: -100}); button.fire('click');
  assert.equal(villageDesktop.style.transform, committed);
});

test('zooming a public desktop clears stale inspection and allows fresh original-size Space inspection', async () => {
  const ui = await page(), viewport = ui.get('dungeon-panel');
  const monster = ui.get('dungeon-probe-main-rank-1').children[1].children[0];
  monster.fire('pointerenter'); ui.key(' '); assert.equal(ui.get('dungeon-probe-inspect').hidden, false); ui.release();
  viewport.fire('wheel', {deltaY: -100, clientX: 200, clientY: 220});
  assert.equal(ui.get('dungeon-probe-inspect').hidden, true); assert.equal(monster.dataset.active, 'false');
  monster.fire('pointerenter'); ui.key(' '); assert.equal(ui.get('dungeon-probe-inspect').hidden, false);
  const large = ui.get('dungeon-probe-inspect-content').children.find(node => !node.hidden).children[0];
  assert.equal(large.width, 504); assert.equal(large.height, 704);
  ui.window.fire('pagehide', {persisted: false});
});
