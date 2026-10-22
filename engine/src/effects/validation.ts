import {RuleError} from '../types.js';

export class EffectCompileError extends RuleError {
  constructor(message: string) {super(message); this.name = 'EffectCompileError';}
}
export type ObjectValue = Record<string, unknown>;
export const has = (object: object, key: string): boolean => Object.hasOwn(object, key);
export function keys(value: unknown, required: string[], optional: string[], place: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || required.some(key => !has(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new EffectCompileError(`${place}: invalid or missing keys`);
  }
  return value as ObjectValue;
}
export function integer(value: unknown, place: string, min = -10000, max = 10000): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new EffectCompileError(`${place}: expected bounded integer`);
}
export function nonempty(value: unknown, place: string): asserts value is string {
  if (typeof value !== 'string' || !value) throw new EffectCompileError(`${place}: expected nonempty string`);
}
export function allowed(value: unknown, values: readonly unknown[], place: string, message: string): void {
  if (!values.includes(value)) throw new EffectCompileError(`${place}: ${message}`);
}
export function boolean(value: unknown, place: string, message = 'expected boolean'): void {
  if (typeof value !== 'boolean') throw new EffectCompileError(`${place}: ${message}`);
}
export function list(value: unknown, place: string, message: string, min = 0, max = Infinity): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new EffectCompileError(`${place}: ${message}`);
  return value;
}
