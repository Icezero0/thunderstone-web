import {isHero} from '../catalog/cards.js';
import {RuleError, type Card} from '../types.js';

export interface TurnBuff {
  buff: 'discard_instead_of_destroy';
  expires_after_turn: number;
  ability_id: string;
  source_instance_id: string;
}

interface BuffInstance {
  owner_player_id: string | null;
  flags: Record<string, unknown>;
}

export function validateTurnBuffs(turnNumber: number, instance: BuffInstance, card: Card): void {
  const buffs = instance.flags.turn_buffs === undefined ? [] : instance.flags.turn_buffs;
  if (!Array.isArray(buffs) || (buffs.length > 0 && !isHero(card))) {
    throw new RuleError('invalid hero turn buffs');
  }
  for (const value of buffs) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join('|') !== 'ability_id|buff|expires_after_turn|source_instance_id' ||
        value.buff !== 'discard_instead_of_destroy' ||
        !Number.isSafeInteger(value.expires_after_turn) || value.expires_after_turn !== turnNumber ||
        typeof value.ability_id !== 'string' || !value.ability_id ||
        typeof value.source_instance_id !== 'string' || !value.source_instance_id) {
      throw new RuleError('invalid hero turn buff');
    }
  }
}

export interface GrantTurnBuffInput {
  instance: BuffInstance | null;
  card: Card | null;
  in_active_hand: boolean;
  turn_number: number;
  buff: string;
  ability_id: string;
  source_instance_id: string;
}
export interface GrantTurnBuffResult {
  turn_buffs: TurnBuff[];
  granted: TurnBuff | null;
}

export function grantTurnBuff(input: GrantTurnBuffInput): GrantTurnBuffResult {
  if (input.buff !== 'discard_instead_of_destroy' || input.instance === null ||
      input.card === null || !isHero(input.card) || !input.in_active_hand) {
    throw new RuleError("turn buff needs a hero in the active player's hand");
  }
  const value: TurnBuff = {buff: input.buff, expires_after_turn: input.turn_number,
    ability_id: input.ability_id, source_instance_id: input.source_instance_id};
  const prior = (input.instance.flags.turn_buffs ?? []) as TurnBuff[];
  if (prior.some(item => Object.keys(value).every(key => item[key as keyof TurnBuff] === value[key as keyof TurnBuff]))) {
    return {turn_buffs: [...prior], granted: null};
  }
  return {turn_buffs: [...prior, value], granted: value};
}

export function destructionReplacement(instance: BuffInstance, card: Card, turnNumber: number): TurnBuff | null {
  if (instance.owner_player_id === null || !isHero(card)) return null;
  return ((instance.flags.turn_buffs ?? []) as TurnBuff[]).find(value =>
    value.buff === 'discard_instead_of_destroy' && value.expires_after_turn === turnNumber) ?? null;
}

export interface ExpiringBuffsInput {
  turn_number: number;
  instances: {instance_id: string; turn_buffs: TurnBuff[]}[];
}
export interface ExpiringBuffsResult {
  instance_id: string;
  expired: TurnBuff[];
  remaining: TurnBuff[];
}

export function expireTurnBuffs(input: ExpiringBuffsInput): ExpiringBuffsResult[] {
  const changes: ExpiringBuffsResult[] = [];
  for (const {instance_id, turn_buffs} of input.instances) {
    const expired = turn_buffs.filter(value => value.expires_after_turn <= input.turn_number);
    if (expired.length) changes.push({instance_id, expired,
      remaining: turn_buffs.filter(value => value.expires_after_turn > input.turn_number)});
  }
  return changes;
}
