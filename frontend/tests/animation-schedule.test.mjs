import test from 'node:test';
import assert from 'node:assert/strict';
import {animationSchedule} from '../.test-dist/animation-schedule.js';

const move = (sequence, source, destination, id) => ({sequence, kind: 'player_card_motion', player_id: 'alice',
  steps: [{kind: 'move', source, destination, cards: [{instance_id: id, card_id: 'TS-0001'}]}]});
const misses = (count, base = 0) => Array.from({length: count}, (_, i) => [move(base + i * 2, 'draw', 'revealed', `c${base + i}`),
  move(base + i * 2 + 1, 'revealed', 'discard', `c${base + i}`)]).flat();

test('six normal reveals precede bounded fast batches; destruction and shuffle remain barriers', () => {
  const hits = [{sequence: 20, kind: 'card_destroyed', card_id: 'TS-0001'},
    {sequence: 21, kind: 'player_card_motion', player_id: 'alice', steps: [{kind: 'shuffle'}]}];
  const input = [...misses(10), ...hits, ...misses(10, 22)], original = structuredClone(input);
  const result = animationSchedule(input);
  assert.deepEqual(result.slice(0, 12), input.slice(0, 12));
  assert.equal(result[12].fast, true); assert.equal(result[12].steps[0].cards.length, 4);
  assert.deepEqual(result.slice(14, 16), hits);
  assert.deepEqual(result.slice(16).map(row => row.steps[0].cards.length), [8, 8, 2, 2]);
  assert.deepEqual(input, original);
});

test('a revealed matching card never joins a miss batch and keeps its own destruction event', () => {
  const hit = [move(12, 'draw', 'revealed', 'hero'), {sequence: 13, kind: 'card_destroyed', card_id: 'hero'}];
  const result = animationSchedule([...misses(6), ...hit, ...misses(2, 14)]);
  assert.deepEqual(result.slice(12, 14), hit); assert.equal(result[14].steps[0].cards.length, 2);
});

test('other players public checks also batch after six reveals without crossing a shuffle', () => {
  const rows = Array.from({length: 9}, (_, i) => ['open', 'close'].map((kind, j) => ({sequence: i * 2 + j, kind: 'table_card_motion', steps: [{
    source: {kind: 'player', player_id: 'bob', zone: j ? 'revealed_10' : 'draw'},
    destination: {kind: 'player', player_id: 'bob', zone: j ? 'discard' : 'revealed_10'}, card: {instance_id: `opaque${i}-${j}`, card_id: 'TS-0001'},
  }]}))).flat();
  const result = animationSchedule(rows);
  assert.equal(result.length, 14); assert.equal(result[12].steps.length, 3); assert.equal(result[12].fast, true);
});
