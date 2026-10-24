import type {Card, Mechanic} from '../types.js';
import {EffectCompileError, has, keys} from './validation.js';

const words = (value: string): string[] => value ? value.split(' ') : [];
export const MECHANIC_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(Object.entries({
  response: 'action once_per_turn attack', return_destroyed_to_supply: '', refill_empty_supply: '',
  replace_monster: 'reserve_card_id', repeat_battle: 'extra', dungeon_deck_lock: '', draw_attack: 'amount', replace_disease: 'action',
  rank_bonus: 'minimum maximum attack magic_attack light scale',
  equipment_bonus: 'hero_tag hero_card_id weapon_tag weight_max strength_min attack magic_attack light strength level_scale minimum_rank target_tags_any',
  hand_bonus: 'filter metric divisor minimum absent flat exclude_source attack magic_attack light strength',
  target_bonus: 'tag minimum_rank maximum_rank attack magic_attack light ignore_darkness same_family',
  no_magic_bonus: 'attack',
  excess_light_magic: 'amount', card_aura: 'filters_any attack magic_attack light', ignore_darkness: 'minimum_rank tag', double_magic: '',
  hero_aura: 'filter exclude_source equipped attack magic_attack strength light', weapon_aura: 'attack magic_attack light', rank_restriction: 'forbidden allowed',
  battle_aura: 'light strength',
  target_restriction: 'exclude_tags strength_min equipped_only immune_unarmed immune_spells immune_weapon_tag magic_required half_magic half_attack_no_magic half_attack_no_weapon min_heroes no_darkness forbid_used_spell forbid_equipment requires_used_spell_or_item half_no_element',
  target_health: 'filter metric multiplier minimum flat gold_below_double other_tag amount hall_filter',
  hall_target_restriction: 'protected_tag', hall_movement_lock: '',
  hall_aura: 'light strength health rank0_only disease_attack strength_per_spell double_darkness', light_requirement: 'ranks irreducible', immovable: '',
  extra_equipment: 'capacity extra_capacity', equipment_discount: 'hero_tag amount', disease_strength: 'amount single',
  economy: 'monster_gold_zero hero_discount hero_surcharge all_surcharge one_purchase scope', scoring: 'group maximum other_stones fewest_monsters_bonus',
}).map(([key, value]) => [key, words(value)]));
const BOOLEAN_FILTERS = words('gold_present cost_present vp_present equipped unused participating unmarked duplicate_names revealed_only movable in_hand in_selected_dungeon used equipment_space same_family_as_event in_discard');
const STRING_FILTERS = words('tag card_id card_type subcategory name exclude_card_id exclude_card_type exclude_var name_in_var equipper_card_id same_name_as_var without_weapon_tag semantic_type adjacent_to_var equippable_by_var');
const LIST_FILTERS = words('tags_any tags_none equipper_tags_any');
const NUMBER_FILTERS = words('gold_min light_min level_min level_max magic_min strength_min strength_max weight_min weight_max gold_max vp_min vp_max rank magic_max');
export const FILTER_KEYS = [...BOOLEAN_FILTERS, ...STRING_FILTERS, ...LIST_FILTERS, ...NUMBER_FILTERS];
export function validateFilter(value: unknown): void {
  const filter = keys(value, [], FILTER_KEYS, 'card filter');
  for (const [key, item] of Object.entries(filter)) {
    const valid = BOOLEAN_FILTERS.includes(key) ? typeof item === 'boolean'
      : STRING_FILTERS.includes(key) ? typeof item === 'string' && item.length > 0
      : LIST_FILTERS.includes(key) ? Array.isArray(item) && item.every(tag => typeof tag === 'string' && tag.length > 0) && new Set(item).size === item.length
      : typeof item === 'number' && Number.isInteger(item) && item >= -100 && item <= 10000;
    if (!valid) throw new EffectCompileError(`invalid filter value: ${key}`);
  }
}
export function compileMechanics(raw: unknown, cards: Record<string, Card>): Mechanic[] {
  if (!Array.isArray(raw)) throw new EffectCompileError('mechanics must be a list');
  const seen = new Set();
  return raw.map(value => {
    const item = keys(value, ['id', 'source_card_id', 'source_line', 'op', 'params'], [], 'mechanic');
    const {source_card_id: card, id, op} = item;
    if (typeof card !== 'string' || !has(cards, card) || typeof id !== 'string' || !id.startsWith(`${card}-A`)
        || seen.has(id) || typeof op !== 'string' || !has(MECHANIC_PARAMETERS, op)
        || !cards[card].effect_text.split(/\r?\n/).includes(item.source_line as string)) throw new EffectCompileError(`invalid mechanic source: ${id}`);
    const params = keys(item.params, [], [...MECHANIC_PARAMETERS[op]], `invalid parameters: ${id}`);
    if (op === 'economy' && has(params, 'scope') && !['hand', 'hall'].includes(params.scope as string)) throw new EffectCompileError(`invalid economy scope: ${id}`);
    if (op === 'replace_disease' && !['destroy','redirect'].includes(params.action as string)) throw new EffectCompileError(`invalid disease replacement action: ${id}`);
    if (op === 'response' && !['ignore_trap','redirect_trap','redirect_opponent','ignore_battle','prevent_destroy'].includes(params.action as string)) throw new EffectCompileError(`invalid response action: ${id}`);
    for (const [key, value] of Object.entries(params)) {
      if (key === 'filter' || key === 'hall_filter') validateFilter(value);
      else if (key === 'filters_any') {
        if (!Array.isArray(value) || !value.length) throw new EffectCompileError('expected nonempty filter list');
        value.forEach(validateFilter);
      } else if (key === 'ranks') {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([rank, amount]) => !/^\d+$/.test(rank) || !(typeof amount === 'boolean' || typeof amount === 'number' && Number.isInteger(amount)) || Number(amount) < 0 || Number(amount) > 100)) throw new EffectCompileError(`invalid rank values: ${id}`);
      } else if (!['string','number','boolean'].includes(typeof value) && !Array.isArray(value)) throw new EffectCompileError(`invalid parameter value: ${id}.${key}`);
      else if (typeof value === 'number' && (!Number.isInteger(value) || value < -100 || value > 100)) throw new EffectCompileError(`mechanic parameter out of bounds: ${id}.${key}`);
    }
    seen.add(id);
    return item as unknown as Mechanic;
  });
}
