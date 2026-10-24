import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoState, drawDemoCards, discardDemoCards} from '../.test-dist/probe-demo-state.js';
import {sortHandByCardId} from '../.test-dist/player-deck-model.js';

test('demo operations preserve card identities, total count and order without mutating their inputs', () => {
  const initial = createDemoState(), original = structuredClone(initial);
  const draw = drawDemoCards(initial, 5);
  assert.deepEqual(initial, original);
  assert.deepEqual(draw.moved.map(card => card.id), initial.draw.slice(0, 5).map(card => card.id));
  const discard = discardDemoCards(draw.state, new Set(['draw-3', 'hand-1', 'missing']));
  assert.deepEqual(discard.moved.map(card => card.id), ['hand-1', 'draw-3']);
  assert.equal(discard.state.discard.at(-1).id, 'draw-3');
  const all = [...discard.state.hand, ...discard.state.draw, ...discard.state.discard];
  assert.equal(all.length, 38); assert.equal(new Set(all.map(card => card.id)).size, 38);
  assert.equal(draw.state.hand.length, 11);
});

test('auto arrangement sorts numeric card IDs stably without changing identities or other piles', () => {
  const state = createDemoState(18), original = structuredClone(state);
  const sorted = sortHandByCardId(state.hand);
  assert.deepEqual(state, original);
  assert.notEqual(sorted, state.hand);
  assert.deepEqual(sorted.map(card => card.cardId), [...original.hand.map(card => card.cardId)].sort());
  assert.deepEqual(sorted.filter(card => card.cardId === 'TS-0001').map(card => card.id), ['hand-1', 'hand-7', 'hand-13']);
  assert.deepEqual(new Set(sorted.map(card => card.id)), new Set(original.hand.map(card => card.id)));
  const cards = ['TS-10', 'TS-2', 'TS-1'].map(cardId => ({id: cardId, cardId, name: cardId}));
  assert.deepEqual(sortHandByCardId(cards).map(card => card.id), ['TS-1', 'TS-2', 'TS-10']);
});

test('draw limits handle an empty pile, full hand and invalid batch quantities', () => {
  const empty = createDemoState(0), all = drawDemoCards(empty, 30);
  assert.equal(all.moved.length, 24); assert.equal(all.state.draw.length, 0);
  assert.equal(drawDemoCards(all.state, 5).moved.length, 0);
  assert.equal(drawDemoCards(createDemoState(29), 5).moved.length, 1);
  assert.equal(drawDemoCards(createDemoState(30), 1).moved.length, 0);
  for (const invalid of [-2, 0, NaN]) assert.equal(drawDemoCards(empty, invalid).moved.length, 0);
  assert.equal(discardDemoCards(empty, new Set()).moved.length, 0);
});
