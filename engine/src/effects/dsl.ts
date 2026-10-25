import type {CalculationInput, CalculationState, Instance} from '../types.js';

/** JSON DSL contracts shared by validation, the interpreter and browser tools. */
export type Expression = number | {count: Query} | {sum: {query: Query; field: string}}
  | {maximum: {query: Query; field: string}} | {stat: {var: string; field: string}}
  | {resource: 'xp'|'temporary_gold'} | {context: 'rank'|'price'} | {players: 'all'|'others'}
  | {combat: 'attack'|'magic_attack'|'light'} | {value: string}
  | {[K in 'add'|'sub'|'mul'|'div'|'min'|'max']: {[P in K]: [Expression, Expression]}}['add'|'sub'|'mul'|'div'|'min'|'max'];
export interface Query {
  zone: string; var?: string; collection?: string;
  compare_stat?: {field: string; op: 'le'|'lt'|'eq'|'ge'|'gt'; value: Expression};
  [key: string]: unknown;
}
export type Condition = {all: Condition[]} | {any: Condition[]} | {not: Condition} | {exists: Query}
  | {compare: {left: Expression; op: 'eq'|'ne'|'lt'|'le'|'gt'|'ge'; right: Expression}}
  | {action_in: string[]} | {setting_active: string} | {choice_is: {var: string; option: string}}
  | {subject_is_active: boolean};
export interface EffectNode {op: string; [key: string]: unknown}
export interface Ability {
  id: string; source_card_id: string; kind: string; source_zone: string; usage: string;
  actions: string[]; event: string|null; conditions: Condition[]; body: EffectNode;
  /** Only card text explicitly granting ordering uses a player choice. */
  resolution_order?: 'player';
}
export type Bindings = Record<string, unknown>;
/** Server evaluation may inspect private zones. Never send this snapshot to a client. */
export interface EvaluationState extends CalculationState {
  player_order: string[];
  players: Record<string, {xp: number; temporary_gold?: number; eliminated?: boolean}>;
  instances: Record<string, Instance & {flags?: Record<string, unknown>}>;
  chosen_action?: string|null;
  used_cards?: string[];
  event_context?: Record<string, string|number|boolean|null>;
  turn_defeated_monsters?: string[];
  effect_collections?: Record<string, string[]>;
}
export interface EvaluationInput extends CalculationInput {state: EvaluationState}
