import {RuleError, type CardFilter, type CombatTrace} from '../types.js';
import {isHero, isMonster, isVillage, matches, monsterFamily, stat, tags} from '../catalog/cards.js';
import {canEquipWeapon, combatValues, effectiveWeight, equipmentCapacity, monsterHealth} from '../battle/combat.js';
import {Calculation, equipmentPairs} from './context.js';
import {printedGold} from './economy.js';
import {immuneToSource} from './immunity.js';
import type {Bindings, Condition, EvaluationInput, Expression, Query} from './dsl.js';

export const MAX_QUERY_RESULTS = 200;
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const ids = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];

/** One evaluation owns local memoization only; the caller's snapshot is never written. */
export class EffectEvaluation extends Calculation {
  constructor(readonly input: EvaluationInput) {super(input);}
  /** Target selection applies immunity; counting/remembering cards does not. */
  effectTargets(spec: Query, bindings: Bindings = {}): string[] {
    return this.query(spec, bindings).filter(id => !immuneToSource(this, bindings.source, id));
  }
  private traces = new Map<string, CombatTrace>();
  get evaluationState() {return this.input.state;}
  private activePlayers(): string[] {
    return this.evaluationState.player_order.filter(player => !this.evaluationState.players[player].eliminated);
  }
  private zone(part: string, player = this.playerId): string[] {
    const name = `player:${player}:${part}`;
    const pile = this.state.zones[name];
    if (!pile) throw new RuleError(`effect query requires zone: ${name}`);
    return pile;
  }
  private location(instance: unknown): string|undefined {
    return Object.entries(this.state.zones).find(([, pile]) => pile.includes(string(instance)))?.[0];
  }
  private trace(rank = 1, targetId?: string): CombatTrace {
    targetId ??= this.context.target_instance_id;
    const key = `${rank}:${targetId ?? ''}`;
    if (!this.traces.has(key)) this.traces.set(key, combatValues(this.input, rank, targetId ? this.card(targetId) : null));
    return this.traces.get(key)!;
  }
  private bound(bindings: Bindings, name: string): string {
    const value = bindings[name];
    if (typeof value !== 'string') throw new RuleError(`unbound card target: ${name}`);
    return value;
  }
  private effectiveStat(instance: string, field: string): number {
    const card = this.card(instance);
    if (field === 'weight') return effectiveWeight(this.input, card);
    if (field === 'gold') return printedGold(this, card);
    if (field === 'strength' && this.state.battle_context) return this.trace().hero_strength[instance] ?? stat(card, field);
    return stat(card, field);
  }
  query(spec: Query, bindings: Bindings = {}): string[] {
    const state = this.evaluationState, subject = string(bindings._subject) || this.playerId;
    const event = state.event_context ?? {}, zone = spec.zone;
    const supply = (prefix: string): string[] => Object.keys(state.zones).sort()
      .filter(name => name.startsWith(prefix) && state.zones[name].length > 0).map(name => state.zones[name][0]);
    let candidates: string[];
    switch (zone) {
      case 'active_hand': candidates = [...this.zone('hand')]; break;
      case 'active_draw': candidates = [...this.zone('draw')]; break;
      case 'active_hand_or_village_top': candidates = [...this.zone('hand'), ...supply('village_supply:')]; break;
      case 'active_control': candidates = [...this.zone('control')]; break;
      case 'subject_control': candidates = [...this.zone('control', subject)]; break;
      case 'other_hand': case 'other_discard': case 'other_control':
        candidates = this.activePlayers().filter(player => player !== this.playerId).flatMap(player => this.zone(zone.slice(6), player)); break;
      case 'event_source': case 'event_hero': case 'defeated_monster': {
        const key = {event_source: 'source_instance_id', event_hero: 'hero_instance_id', defeated_monster: 'defeated_instance_id'}[zone];
        const value = string(event[key]);
        candidates = own(state.instances, value) ? [value] : []; break;
      }
      case 'defeated_this_turn': candidates = [...(state.turn_defeated_monsters ?? [])]; break;
      case 'all_hand': case 'all_discard': candidates = this.activePlayers().flatMap(player => this.zone(zone.slice(4), player)); break;
      case 'reveal_zone': candidates = [...(state.zones[string(bindings._reveal_zone)] ?? [])]; break;
      case 'collection': candidates = [...(state.effect_collections?.[`${bindings._ability_id ?? 'None'}:${bindings.source ?? 'None'}:${spec.collection}`] ?? [])]; break;
      case 'event_supply_top': candidates = (state.zones[string(event.supply_zone)] ?? []).slice(0, 1); break;
      case 'subject_hand': case 'active_discard': case 'subject_discard':
        candidates = [...this.zone(zone.endsWith('discard') ? 'discard' : 'hand', zone === 'active_discard' ? this.playerId : subject)]; break;
      case 'bound': candidates = ids(bindings[spec.var!]); break;
      case 'hall': candidates = Object.entries(state.zones).filter(([name]) => name.startsWith('hall:')).flatMap(([, pile]) => pile); break;
      case 'hero_supply_top': candidates = supply('hero_supply:'); break;
      case 'village_supply_top': candidates = supply('village_supply:'); break;
      default: throw new RuleError(`unsupported query zone: ${zone}`);
    }
    const pairs = equipmentPairs(this.context), used = state.used_cards ?? [];
    let result = candidates.filter(instance => {
      if (!own(state.instances, instance)) return false;
      const card = this.card(instance), place = this.location(instance);
      if (own(spec, 'exclude_var') && ids(bindings[string(spec.exclude_var)]).includes(instance)) return false;
      for (const field of ['name_in_var', 'same_name_as_var']) {
        if (own(spec, field) && !ids(bindings[string(spec[field])]).some(id => own(state.instances, id) && this.card(id).name === card.name)) return false;
      }
      if (own(spec, 'semantic_type')) {
        const identities: Record<string, boolean> = {hero: isHero(card), monster: isMonster(card), village: isVillage(card)};
        if (!identities[String(spec.semantic_type)]) return false;
      }
      if (own(spec, 'without_weapon_tag') && pairs.some(([hero, weapon]) => hero === instance && this.hand().includes(weapon) && tags(this.card(weapon)).includes(string(spec.without_weapon_tag)))) return false;
      if (own(spec, 'in_hand') && this.zone('hand', subject).includes(instance) !== spec.in_hand) return false;
      if (spec.in_selected_dungeon && place !== string(bindings._dungeon).replace('dungeon:', 'hall:')) return false;
      if (own(spec, 'adjacent_to_var')) {
        const first = bindings[string(spec.adjacent_to_var)];
        if (!place?.startsWith('hall:') || place.endsWith(':rank0') || this.location(first) !== place || Math.abs(state.zones[place].indexOf(string(first)) - state.zones[place].indexOf(instance)) !== 1) return false;
      }
      if (spec.compare_stat) {
        const comparison = spec.compare_stat;
        const actual = comparison.field === 'health' && state.battle_context
          ? monsterHealth(this.input, card, 1, instance) : this.effectiveStat(instance, comparison.field);
        if (!compare(actual, comparison.op, this.expression(comparison.value, bindings))) return false;
      }
      if (own(spec, 'movable')) {
        const movable = !this.mechanics.some(rule => rule.op === 'immovable' && rule.source_card_id === card.card_id) && !this.hallRules('hall_movement_lock').length;
        if (movable !== spec.movable) return false;
      }
      if (spec.revealed_only && !place?.includes(':revealed_')) return false;
      if (own(spec, 'exclude_pile_var') && place === this.location(bindings[string(spec.exclude_pile_var)])) return false;
      if (own(spec, 'rank') && (!place?.startsWith('hall:') || (place.endsWith(':rank0') ? 0 : state.zones[place].indexOf(instance) + 1) !== spec.rank)) return false;
      const staticSpec = {...spec}; delete staticSpec.weight_min; delete staticSpec.weight_max;
      if (!matches(card, staticSpec as CardFilter) || spec.exclude_source && instance === bindings.source) return false;
      const weight = effectiveWeight(this.input, card);
      if (weight < Number(spec.weight_min ?? -Infinity) || weight > Number(spec.weight_max ?? Infinity)) return false;
      if (own(spec, 'strength_min') || own(spec, 'strength_max')) {
        const strength = state.battle_context ? this.trace().hero_strength[instance] ?? stat(card, 'strength') : stat(card, 'strength');
        if (strength < Number(spec.strength_min ?? -100) || strength > Number(spec.strength_max ?? 100)) return false;
      }
      if (spec.duplicate_names && candidates.filter(id => this.card(id).name === card.name).length < 2) return false;
      if (spec.unmarked && state.instances[instance].flags?.pending_after_battle_destruction) return false;
      if (own(spec, 'equipped') && pairs.some(pair => pair.includes(instance)) !== spec.equipped) return false;
      if (own(spec, 'equipper_tags_any') && !pairs.some(([hero, weapon]) => weapon === instance && tags(this.card(hero)).some(tag => ids(spec.equipper_tags_any).includes(tag)))) return false;
      if (own(spec, 'equipper_card_id') && !pairs.some(([hero, weapon]) => weapon === instance && this.card(hero).card_id === spec.equipper_card_id)) return false;
      if (spec.unused && used.includes(instance) || own(spec, 'used') && used.includes(instance) !== spec.used) return false;
      if (own(spec, 'in_discard') && Boolean(place?.endsWith(':discard')) !== spec.in_discard) return false;
      if (spec.equipment_space && pairs.filter(([hero]) => hero === instance).length >= equipmentCapacity(this.input, instance)) return false;
      if (spec.equippable_by_var && !canEquipWeapon(this.input, this.bound(bindings, String(spec.equippable_by_var)), instance)) return false;
      if (spec.same_family_as_event) {
        const source = string(event.source_instance_id);
        if (!own(state.instances, source) || JSON.stringify(monsterFamily(card)) !== JSON.stringify(monsterFamily(this.card(source)))) return false;
      }
      if (own(spec, 'participating') && state.battle_context) {
        const target = state.battle_context.target_instance_id;
        const included = !this.trace(state.battle_context.target_rank ?? 1, target && own(state.instances, target) ? target : undefined).excluded_instance_ids.includes(instance);
        if (included !== spec.participating) return false;
      }
      return true;
    });
    if (result.length > MAX_QUERY_RESULTS) throw new RuleError('effect query has too many candidates');
    const field = spec.max_by ?? spec.min_by;
    if (field && result.length) {
      const key = field === 'purchase_cost' ? 'cost' : string(field);
      const values = result.map(instance => {
        if (key === 'pile_size') return state.zones[this.location(instance)!].length;
        if (key === 'strength' && state.battle_context) return this.trace().hero_strength[instance] ?? stat(this.card(instance), key);
        if (key === 'attack' && state.battle_context) {
          const trace = this.trace();
          const amounts = new Map(trace.components.map(row => [row.instance_id, row.attack + row.magic_attack]));
          return (amounts.get(instance) ?? 0) + trace.equipped_pairs.filter(([hero]) => hero === instance).reduce((sum, [, weapon]) => sum + (amounts.get(weapon) ?? 0), 0);
        }
        return this.effectiveStat(instance, key);
      });
      const extreme = own(spec, 'max_by') ? Math.max(...values) : Math.min(...values);
      result = result.filter((_, index) => values[index] === extreme);
    }
    return result;
  }
  expression(value: Expression, bindings: Bindings = {}): number {
    if (typeof value === 'number') return value;
    if ('count' in value) return this.query(value.count, bindings).length;
    if ('sum' in value || 'maximum' in value) {
      const operand = 'sum' in value ? value.sum : value.maximum;
      const values = this.query(operand.query, bindings).map(id => this.effectiveStat(id, operand.field));
      return 'sum' in value ? values.reduce((a, b) => a + b, 0) : values.length ? Math.max(...values) : 0;
    }
    if ('stat' in value) {
      return this.effectiveStat(this.bound(bindings, value.stat.var), value.stat.field);
    }
    if ('resource' in value) {
      const player = this.evaluationState.players[string(bindings._subject) || this.playerId];
      const amount = player?.[value.resource];
      if (typeof amount !== 'number') throw new RuleError(`missing player resource: ${value.resource}`);
      return amount;
    }
    if ('context' in value) return Number(this.evaluationState.event_context?.[value.context] ?? 0);
    if ('players' in value) return this.activePlayers().length - Number(value.players === 'others');
    if ('combat' in value) {
      if (this.state.battle_context === null) throw new RuleError('combat value needs a dungeon action');
      return this.trace(this.context.target_rank ?? 1)[value.combat];
    }
    if ('value' in value) {
      const amount = bindings[value.value];
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < -10000 || amount > 10000) throw new RuleError(`unbound numeric variable: ${value.value}`);
      return amount;
    }
    const [op, operands] = Object.entries(value)[0] as [string, [Expression, Expression]];
    const left = this.expression(operands[0], bindings), right = this.expression(operands[1], bindings);
    if (op === 'div' && right === 0) throw new RuleError('effect division by zero');
    const amount = op === 'add' ? left + right : op === 'sub' ? left - right : op === 'mul' ? left * right : op === 'div' ? Math.floor(left / right) : op === 'min' ? Math.min(left, right) : Math.max(left, right);
    if (amount < -10000 || amount > 10000) throw new RuleError('effect expression exceeds numeric bounds');
    return amount === 0 ? 0 : amount;
  }
  condition(spec: Condition, bindings: Bindings = {}): boolean {
    if ('all' in spec) return spec.all.every(child => this.condition(child, bindings));
    if ('any' in spec) return spec.any.some(child => this.condition(child, bindings));
    if ('not' in spec) return !this.condition(spec.not, bindings);
    if ('exists' in spec) return this.query(spec.exists, bindings).length > 0;
    if ('action_in' in spec) return spec.action_in.includes(this.evaluationState.chosen_action ?? '');
    if ('setting_active' in spec) return this.state.active_settings.includes(spec.setting_active);
    if ('choice_is' in spec) return bindings[spec.choice_is.var] === spec.choice_is.option;
    if ('subject_is_active' in spec) return ((bindings._subject ?? this.playerId) === this.playerId) === spec.subject_is_active;
    return compare(this.expression(spec.compare.left, bindings), spec.compare.op, this.expression(spec.compare.right, bindings));
  }
}
function compare(left: number, op: string, right: number): boolean {
  return op === 'eq' ? left === right : op === 'ne' ? left !== right : op === 'lt' ? left < right : op === 'le' ? left <= right : op === 'gt' ? left > right : left >= right;
}
