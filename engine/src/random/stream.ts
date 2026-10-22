import {RuleError} from '../types.js';
import {sha256, utf8} from './sha256.js';

export const RNG_VERSION = 'sha256-counter-v1';
/** Large integers use decimal strings at the JSON boundary, never rounded doubles. */
export type ExactInteger = number|string;
export interface RandomState {algorithm: typeof RNG_VERSION; seed: string; counter: ExactInteger}
export function exactInteger(value: ExactInteger|bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new RuleError('random integer must be exact');
}
export function wireInteger(value: bigint): ExactInteger {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
export class RandomStream {
  readonly seed: string;
  private readonly key: Uint8Array;
  private position = 0n;
  constructor(seed: string|number|bigint, counter: ExactInteger = 0) {
    if (!(typeof seed === 'string' && seed.length > 0 || typeof seed === 'number' && Number.isSafeInteger(seed) || typeof seed === 'bigint')) throw new RuleError('rng_seed must be a nonempty string or integer');
    this.seed = String(seed);
    this.key = sha256(utf8(this.seed));
    this.counter = counter;
  }
  get counter(): ExactInteger {return wireInteger(this.position);}
  set counter(value: ExactInteger) {
    const counter = exactInteger(value);
    if (counter < 0n || counter >= 1n << 128n) throw new RuleError('invalid random counter');
    this.position = counter;
  }
  snapshot(): RandomState {return {algorithm: RNG_VERSION, seed: this.seed, counter: this.counter};}
  randbelow(size: number): number;
  randbelow(size: bigint): bigint;
  randbelow(size: number|bigint): number|bigint {
    const bound = exactInteger(size);
    if (bound < 1n) throw new RuleError('random candidate pool is empty');
    if (bound > 1n << 256n) throw new RuleError('random candidate pool exceeds 256 bits');
    const limit = (1n << 256n) - ((1n << 256n) % bound), block = new Uint8Array(48);
    block.set(this.key);
    while (true) {
      if (this.position >= 1n << 128n) throw new RuleError('random counter exhausted');
      let counter = this.position++;
      for (let i = 47; i >= 32; i--) {block[i] = Number(counter & 255n); counter >>= 8n;}
      let value = 0n;
      for (const byte of sha256(block)) value = (value << 8n) | BigInt(byte);
      if (value < limit) return typeof size === 'bigint' ? value % bound : Number(value % bound);
    }
  }
  shuffle<T>(values: T[]): void {
    for (let index = values.length - 1; index > 0; index--) {
      const other = this.randbelow(index + 1);
      [values[index], values[other]] = [values[other], values[index]];
    }
  }
}
