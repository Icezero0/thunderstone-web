import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';

const source = await readFile(new URL('../.test-dist/card-dissolve.js', import.meta.url), 'utf8');
const html = '<html><body><div id="host"></div><button id="card"></button><img id="image"></body></html>';
const bounds = {left: 200, top: 100, width: 180, height: 250};
async function fixture(contextAvailable = true) {
  const calls = [];
  const context = Object.fromEntries(['scale', 'beginPath', 'roundRect', 'clip', 'drawImage'].map(name => [name, (...args) => calls.push([name, ...args])]));
  const ui = await page({html, source, globals: {AbortController}, canvasContext: () => contextAvailable ? context : null});
  ui.window.devicePixelRatio = 3;
  const button = ui.get('card'), image = ui.get('image'); image.naturalWidth = 504; image.naturalHeight = 704;
  const card = {elements: {button, frontImage: image, surface: button}};
  return {ui, calls, card, run: ui.evaluate('CardDissolvePackage.playCardDissolve')};
}

test('GPU handoff uses the decoded image, clips rounded corners, bounds DPI and releases resources after completion', async () => {
  const {ui, calls, card, run} = await fixture();
  let finish, capture, cancels = 0, disposals = 0, cleanups = 0;
  const rendererDone = new Promise(resolve => {finish = resolve;}), visual = ui.document.createElement('canvas');
  const playback = run(card, ui.get('host'), bounds, context => {
    capture = context; context.addCleanup(() => cleanups++);
    assert.notEqual(card.elements.button.style.opacity, '0');
    return {element: visual, finished: rendererDone, cancel: () => cancels++, dispose: () => disposals++};
  });
  assert.ok(playback); assert.equal(visual.parentElement, ui.get('host')); assert.equal(card.elements.button.style.opacity, '0');
  assert.equal(capture.snapshot.width, 360); assert.equal(capture.snapshot.height, 500);
  assert.equal(calls.find(call => call[0] === 'drawImage')[1], card.elements.frontImage);
  assert.ok(calls.some(call => call[0] === 'roundRect')); assert.deepEqual(ui.requests, []);
  finish(); await playback.finished;
  assert.equal(capture.snapshot.width, 0); assert.equal(visual.isConnected, false);
  assert.equal(capture.signal.aborted, true); assert.deepEqual([cancels, disposals, cleanups], [1, 1, 1]);
});

test('particle cancellation resolves immediately and late renderer completion does not resurrect the effect', async () => {
  const {ui, card, run} = await fixture(); let finish, disposals = 0;
  const rendererDone = new Promise(resolve => {finish = resolve;}), visual = ui.document.createElement('canvas');
  const playback = run(card, ui.get('host'), bounds, () => ({element: visual, finished: rendererDone, dispose: () => disposals++}));
  playback.cancel(); await playback.finished; assert.equal(visual.isConnected, false);
  finish(); await settle(); playback.cancel(); assert.equal(disposals, 1); assert.equal(ui.get('host').children.length, 0);
});

test('missing Canvas/WebGL or renderer failures leave the original visible for the fragment fallback', async () => {
  for (const available of [false, true]) for (const failure of ['missing', 'throw']) {
    const {ui, card, run} = await fixture(available); let captured;
    const playback = run(card, ui.get('host'), bounds, context => {
      captured = context; if (failure === 'throw') throw new Error('GPU unavailable'); return null;
    });
    assert.equal(playback, null); assert.notEqual(card.elements.button.style.opacity, '0');
    assert.equal(ui.get('host').children.length, 0); if (captured) assert.equal(captured.snapshot.width, 0);
  }
});

test('GPU cleanup failure still releases the canvas and unblocks the game animation', async () => {
  const {ui, card, run} = await fixture(); let snapshot;
  const visual = ui.document.createElement('canvas');
  const playback = run(card, ui.get('host'), bounds, context => {
    snapshot = context.snapshot;
    return {element: visual, finished: new Promise(() => {}), cancel: () => {throw new Error('context lost');}};
  });
  playback.cancel(); await playback.finished;
  assert.equal(snapshot.width, 0); assert.equal(visual.isConnected, false);
});
