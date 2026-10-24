import test from 'node:test';
import assert from 'node:assert/strict';
import {deckTransitions} from '../.test-dist/match-deck-transitions.js';

const card = id => ({id, cardId: 'TS-0001', name: id});
const event = kind => ({kind, player_id: 'alice', sequence: 1});
const state = (hand, draw, discard = []) => ({hand: hand.map(card), draw: draw.map(card), discard: discard.map(card)});
const cleanup = [event('turn_hand_discarded')], shuffle = event('player_deck_shuffled');

test('turn cleanup plays every discard before drawing, including cards redrawn from the shuffled hand', () => {
  const old = state(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], ['d1', 'd2'], ['x1', 'x2', 'x3']);
  const final = state(['d1', 'd2', 'h1', 'h2', 'x1', 'x2'], ['h3', 'h4', 'h5', 'h6', 'x3']);
  const before = structuredClone([old, final]);
  const plan = deckTransitions(old, final, [...cleanup, shuffle], 'alice');
  assert.deepEqual(plan.map(step => step.kind), ['discard', 'draw', 'shuffle', 'draw']);
  assert.deepEqual(plan[0].instanceIds, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  assert.deepEqual(plan[1].instanceIds, ['d1', 'd2']); assert.equal(plan[1].state.draw.length, 0);
  assert.equal(plan[2].state.discard.length, 0); assert.equal(plan[2].state.draw.length, 9);
  assert.deepEqual(plan[3].instanceIds, ['h1', 'h2', 'x1', 'x2']);
  assert.deepEqual([old, final], before);
});

for (const drawCount of [0, 6, 9]) test(`cleanup handles an initial draw inventory of ${drawCount} without assuming its order`, () => {
  const draws = Array.from({length: drawCount}, (_, i) => `d${i}`), hand = ['h1', 'h2'];
  const old = state(hand, [...draws].reverse());
  const final = drawCount ? state(draws.slice(0, 6), draws.slice(6), hand) : state(hand, []);
  const plan = deckTransitions(old, final, drawCount ? cleanup : [...cleanup, shuffle], 'alice');
  assert.deepEqual(plan.map(step => step.kind), drawCount ? ['discard', 'draw'] : ['discard', 'shuffle', 'draw']);
  assert.deepEqual(plan.at(-1).instanceIds, final.hand.map(card => card.id));
});

test('no invented cards when fewer than six exist; hand bonuses use the committed hand size', () => {
  const sparse = deckTransitions(state(['a'], ['b']), state(['b', 'a'], []), [...cleanup, shuffle], 'alice');
  assert.deepEqual(sparse.map(step => step.kind), ['discard', 'draw', 'shuffle', 'draw']);
  const ids = Array.from({length: 10}, (_, i) => `d${i}`);
  const bonus = deckTransitions(state([], ids), state(ids.slice(0, 8), ids.slice(8)), [], 'alice');
  assert.equal(bonus[0].instanceIds.length, 8);
});

test('rest destruction requires a matching committed event; a replaced destruction plays as discard', () => {
  const old = state(['a', 'b'], []), final = state(['b'], []);
  const destroyed = {...event('rest_card_destroyed'), card_id: 'TS-0001'};
  assert.deepEqual(deckTransitions(old, final, [destroyed], 'alice').map(step => step.kind), ['destroy']);
  assert.deepEqual(deckTransitions(old, final, [{...destroyed, kind: 'card_destroyed'}], 'alice').map(step => step.kind), ['destroy']);
  assert.deepEqual(deckTransitions(old, final, [], 'alice'), []);
  assert.deepEqual(deckTransitions(old, final, [{...destroyed, player_id: 'bob'}], 'alice'), []);
  assert.deepEqual(deckTransitions(old, state(['b'], [], ['a']), [destroyed], 'alice').map(step => step.kind), ['discard']);
  assert.deepEqual(deckTransitions(old, state([], []), [destroyed], 'alice'), []);
});

test('unreconstructible missed transitions fall back to a snapshot instead of faking draws or shuffles', () => {
  assert.deepEqual(deckTransitions(state(['a'], ['d']), state(['unknown'], []), [...cleanup, shuffle], 'alice'), []);
  assert.deepEqual(deckTransitions(state([], ['still-in-deck'], ['x']), state(['x'], ['still-in-deck']), [shuffle], 'alice'), []);
});

test('a committed purchase gains the new discard instance from the quoted public source without moving the hand', () => {
  const old = state(['h'], ['d'], ['old']), final = state(['h'], ['d'], ['old', 'bought']);
  const bought = {...event('card_bought'), card_id: 'TS-0001'}, origin = {left: 250, top: 160, width: 156, height: 218};
  const before = structuredClone([old, final, origin]);
  const steps = deckTransitions(old, final, [bought], 'alice', {'TS-0001': origin});
  assert.deepEqual(steps.map(step => step.kind), ['gain']); assert.deepEqual(steps[0].instanceIds, ['bought']);
  assert.deepEqual(steps[0].origins.bought, origin); assert.deepEqual(steps[0].state, final);
  assert.deepEqual([old, final, origin], before); origin.left = 99; assert.equal(steps[0].origins.bought.left, 250);
});

test('unidentified, hidden or duplicate gains snap safely instead of assigning a purchase to the wrong instance', () => {
  const old = state(['h'], []), final = state(['h'], [], ['bought']);
  const bought = {...event('card_bought'), card_id: 'TS-0001'}, origins = {'TS-0001': {left: 50, top: 60, width: 144, height: 200}};
  assert.deepEqual(deckTransitions(old, final, [bought], 'alice'), []);
  assert.deepEqual(deckTransitions(old, final, [{...bought, player_id: 'bob'}], 'alice', origins), []);
  assert.deepEqual(deckTransitions(old, final, [], 'alice', origins), []);
  assert.deepEqual(deckTransitions(old, state(['h'], [], ['bought', 'bonus']), [bought], 'alice', origins), []);
});

test('an upgrade replaces destruction with an evolution of the exact removed and gained instances', () => {
  const source = {...card('old'), cardId: 'TS-0354'}, target = {...card('new'), cardId: 'TS-0355'};
  const old = {...state(['keep'], [], ['discard']), hand: [source, card('keep')]};
  const final = {...old, hand: [card('keep')], discard: [...old.discard, target]};
  const events = [{...event('card_destroyed'), card_id: source.cardId}, {...event('hero_upgraded'), source_card_id: source.cardId, target_card_id: target.cardId}];
  const before = structuredClone([old, final]); const plan = deckTransitions(old, final, events, 'alice');
  assert.deepEqual(plan.map(step => step.kind), ['upgrade']); assert.equal(plan[0].sourceInstanceId, 'old');
  assert.equal(plan[0].targetInstanceId, 'new'); assert.deepEqual(plan[0].state, final); assert.deepEqual([old, final], before);
  assert.deepEqual(deckTransitions(old, final, [{...events[1], player_id: 'bob'}], 'alice'), []);
});

test('ambiguous upgrade removals and non-discard destinations snap rather than evolving a guessed card', () => {
  const source = {...card('old'), cardId: 'TS-0354'}, target = {...card('new'), cardId: 'TS-0355'};
  const old = {hand: [source], draw: [], discard: []}, upgraded = {...event('hero_upgraded'), source_card_id: source.cardId, target_card_id: target.cardId};
  assert.deepEqual(deckTransitions(old, {hand: [target], draw: [], discard: []}, [upgraded], 'alice'), []);
  assert.deepEqual(deckTransitions({...old, hand: [source, {...source, id: 'same'}]}, {hand: [], draw: [], discard: [target]}, [upgraded], 'alice'), []);
  assert.deepEqual(deckTransitions(old, {hand: [], draw: [], discard: [target, {...target, id: 'same-target'}]}, [upgraded], 'alice'), []);
});
