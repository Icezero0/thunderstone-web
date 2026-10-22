import {RuleError} from '../types.js';
import {RandomStream, RNG_VERSION, type RandomState} from '../random/stream.js';

/** Refill only on demand. The returned order is also the shuffle event payload. */
export function refillDrawPile(draw: string[], discard: string[], rng: RandomStream): string[] | null {
  if (draw.length || !discard.length) return null;
  draw.push(...discard);
  discard.length = 0;
  rng.shuffle(draw);
  return [...draw];
}

/** One player draw step. Inputs are copied so a caller can retry a failed command. */
export interface DrawCardsInput {
  draw: string[];
  discard: string[];
  hand: string[];
  count: number;
  rng: RandomState;
}

export interface DrawCardsResult {
  draw: string[];
  discard: string[];
  hand: string[];
  taken: string[];
  shuffle_orders: string[][];
  counter: number | string;
}

export function drawCards(input: DrawCardsInput): DrawCardsResult {
  if (!Number.isSafeInteger(input.count)) throw new RuleError('draw count must be an exact integer');
  if (input.rng.algorithm !== RNG_VERSION) throw new RuleError('unsupported random state');
  for (const pile of [input.draw, input.discard, input.hand]) {
    if (!Array.isArray(pile) || pile.some(id => typeof id !== 'string')) {
      throw new RuleError('draw zones must contain instance IDs');
    }
  }
  const draw = [...input.draw], discard = [...input.discard], hand = [...input.hand];
  const rng = new RandomStream(input.rng.seed, input.rng.counter);
  const taken: string[] = [], shuffle_orders: string[][] = [];
  while (taken.length < input.count) {
    const shuffled = refillDrawPile(draw, discard, rng);
    if (shuffled) shuffle_orders.push(shuffled);
    if (!draw.length) break;
    const item = draw.shift()!;
    hand.push(item);
    taken.push(item);
  }
  return {draw, discard, hand, taken, shuffle_orders, counter: rng.counter};
}
