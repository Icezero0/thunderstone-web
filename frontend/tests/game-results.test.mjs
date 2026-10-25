import test from 'node:test';
import assert from 'node:assert/strict';
import {resultRows} from '../.test-dist/game-results-model.js';
import {page} from './support/player-deck-dom.mjs';

const descendants = node => [node, ...node.children.flatMap(descendants)];

test('result lines sort totals descending and prioritize stone possession, with shared ranks and negative scores', () => {
  const players = [
    {id: 'low', total: -3, thunderstones: 0}, {id: 'plain', total: 10, thunderstones: 0},
    {id: 'stone', total: 10, thunderstones: 1}, {id: 'two-stones', total: 10, thunderstones: 2},
    {id: 'highest', total: 12, thunderstones: 0},
  ];
  const before = structuredClone(players), rows = resultRows(players);
  assert.deepEqual(players, before);
  assert.deepEqual(rows.map(row => row.id), ['highest', 'stone', 'two-stones', 'plain', 'low']);
  assert.deepEqual(rows.map(row => row.rank), [1, 2, 2, 4, 5]);
  for (const row of rows) {
    assert.ok([row.zero, row.point, row.start, row.length].every(value => Number.isFinite(value) && value >= 0 && value <= 100));
  }
  assert.equal(resultRows([{id: 'zero', total: 0, thunderstones: 0}])[0].length, 0);
  assert.deepEqual(resultRows([]), []);
});

test('probe result dialog uses player identity, XP subtotal, stone tiebreak and modal close behavior', async () => {
  const ui = await page(); await ui.click('demo-game-results');
  const find = cls => descendants(ui.get('player-deck-overlays')).find(node => node.className.split(' ').includes(cls));
  const dialog = find('game-results');
  assert.equal(dialog.hidden, false); assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(ui.get('probe-shell').inert, true);
  let rows = find('game-results-chart').children;
  assert.deepEqual(rows.map(row => row.dataset.playerId), ['player-2', 'player-1', 'player-3']);
  assert.deepEqual(rows.map(row => row.dataset.winner), ['true', 'false', 'false']);
  assert.match(rows[0].textContent, /卡牌 24 \+ XP 4/);
  assert.equal(descendants(dialog).filter(node => node.className === 'game-results-crown').length, 1);
  descendants(dialog).find(node => node.className.split(' ').includes('browse-dialog-close')).fire('click');
  assert.equal(dialog.hidden, true); assert.equal(ui.get('probe-shell').inert, false);
  ui.get('demo-xp').value = '3'; await ui.click('demo-game-results');
  rows = find('game-results-chart').children;
  assert.equal(rows[0].dataset.playerId, 'player-1'); assert.equal(rows[0].dataset.winner, 'true');
  assert.match(rows[0].textContent, /卡牌 28 \+ XP 3/);
  ui.document.fire('keydown', {key: 'Escape'}); assert.equal(dialog.hidden, true); ui.window.fire('pagehide', {persisted: false});
});
