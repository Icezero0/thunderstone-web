import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture} from './support/catalog.mjs';

test('settlement adds unused XP 1:1 to every owned card, across all player zones', () => {
  const f = fixture(['TS-0605']);
  for (const zone of ['draw', 'discard', 'control', 'aside']) f.add('TS-0605', `player:alice:${zone}`);
  f.add('TS-0605', 'destroyed'); f.add('TS-0605', 'hall:main');
  f.state.players.alice.xp = 7;
  const input = {state: f.state, cards: f.cards, mechanics: []}, before = structuredClone(input);
  const result = server.scoreGame(input);
  assert.deepEqual(browser.scoreGame(input), result); assert.deepEqual(input, before);
  const score = result.players.alice;
  assert.equal(score.cards.length, 5);
  assert.equal(score.card_victory_points, 5 * Number(f.cards['TS-0605'].wiki_胜利点));
  assert.equal(score.experience_points, 7);
  assert.equal(score.victory_points, score.card_victory_points + 7);
});

test('total including XP determines winners; a stone breaks only equal totals, eliminating nobody from the report', () => {
  const f = fixture([]); f.add('TS-0707', 'player:alice:discard');
  const points = Number(f.cards['TS-0707'].wiki_胜利点);
  f.state.players.alice.xp = 2; f.state.players.bob.xp = points + 3;
  const input = {state: f.state, cards: f.cards, mechanics: []};
  assert.deepEqual(server.scoreGame(input).winner_ids, ['bob']);
  f.state.players.bob.xp--;
  assert.deepEqual(server.scoreGame(input).winner_ids, ['alice']);
  assert.equal(server.scoreGame(input).tie_break, 'thunderstone');
  f.add('TS-0707', 'player:bob:draw'); f.state.players.bob.xp = 2;
  assert.deepEqual(server.scoreGame(input).winner_ids, ['alice', 'bob']);
  f.state.players.alice.eliminated = true; f.state.players.alice.xp = 100;
  const result = server.scoreGame(input);
  assert.deepEqual(result.winner_ids, ['bob']); assert.equal(result.players.alice.experience_points, 100);
});

test('negative disease VP and card scoring effects remain part of the card subtotal', () => {
  const f = fixture(['TS-0719', 'TS-0616', 'TS-0617']); f.state.players.alice.xp = 1;
  const input = {state: f.state, cards: f.cards, mechanics: f.rules.mechanics};
  const result = server.scoreGame(input);
  assert.equal(result.players.alice.card_victory_points, -2 + 2 * 2);
  assert.equal(result.players.alice.victory_points, 3);
  assert.deepEqual(browser.scoreGame(input), result);
});
