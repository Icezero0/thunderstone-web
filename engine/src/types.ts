/** Plain JSON contracts. This package owns no database, transport or match. */
export type Card = Record<string, string>;
export type Stat = 'attack' | 'magic_attack' | 'light' | 'strength';
export type Stats = Record<Stat, number>;
export type CardFilter = Record<string, string | number | boolean | string[]>;
export interface MechanicParams extends Partial<Stats> {
  filter?: CardFilter; hall_filter?: CardFilter; filters_any?: CardFilter[];
  metric?: string; divisor?: number; minimum?: number; maximum?: number;
  absent?: boolean; flat?: boolean; exclude_source?: boolean; equipped?: boolean;
  scale?: boolean; tag?: string; minimum_rank?: number; maximum_rank?: number;
  same_family?: boolean; hero_tag?: string; hero_card_id?: string; weapon_tag?: string;
  weight_max?: number; strength_min?: number; level_scale?: boolean; target_tags_any?: string[];
  strength_per_spell?: boolean; disease_attack?: number; rank0_only?: boolean;
  double_darkness?: boolean; capacity?: number; extra_capacity?: number; amount?: number;
  forbidden?: number[]; allowed?: number[]; exclude_tags?: string[]; equipped_only?: boolean;
  immune_spells?: boolean; immune_unarmed?: boolean; immune_weapon_tag?: string;
  ranks?: Record<string, number>; irreducible?: boolean; half_magic?: boolean;
  half_attack_no_magic?: boolean; half_attack_no_weapon?: boolean; magic_required?: boolean;
  min_heroes?: number; forbid_used_spell?: boolean; forbid_equipment?: boolean;
  requires_used_spell_or_item?: boolean; half_no_element?: boolean; no_darkness?: boolean;
  gold_below_double?: number; multiplier?: number; other_tag?: string; single?: boolean;
  protected_tag?: string; ignore_darkness?: boolean; health?: number;
  extra?: number;
  action?: 'destroy'|'redirect'|'prevent_destroy'|'ignore_trap'|'redirect_trap'|'ignore_battle'|'redirect_opponent';
  once_per_turn?: boolean;
  monster_gold_zero?: boolean; all_surcharge?: number; hero_surcharge?: number;
  hero_discount?: number; one_purchase?: boolean;
  scope?: 'hand'|'hall';
  group?: string; other_stones?: number; fewest_monsters_bonus?: number;
}
export interface Mechanic {
  id: string; source_card_id: string; source_line: string; op: string; params: MechanicParams;
}
export interface Instance {card_id: string; owner_player_id?: string | null}
export type Equipment = Record<string, string | string[]>;
export interface BattleTeam {
  hero_instance_ids: string[];
  support_instance_ids: string[];
}
export interface BattleContext {
  battle_team?: BattleTeam;
  equipped_weapon_by_hero?: Equipment;
  card_modifiers?: Record<string, Partial<Stats>>;
  strength_penalty_assignments?: Record<string, string>;
  hero_battle_modifiers?: Partial<Stats>;
  equipment_draw_counts?: Record<string, number>;
  spell_cast_counts?: Record<string, number>;
  damage_divisor?: number;
  zero_weapon_weight?: boolean;
  flag_sources?: Record<string, string>;
  excluded_participants?: string[];
  convert_all_magic?: boolean; convert_equipped_magic?: boolean; convert_card_magic?: string[];
  modifiers?: Partial<Stats>;
  modifier_sources?: {source_instance_id: string|null; source_card_id?: string; field: Stat; amount: number}[];
  disease_order?: string[];
  disease_penalty_assignments?: Record<string, string>;
  cannot_defeat?: boolean; used_card_tags?: string[];
  target_instance_id?: string; target_rank?: number;
  health_modifier?: number; monster_health_modifiers?: Record<string, number>;
}
export interface CalculationState {
  active_player_id: string;
  zones: Record<string, string[]>;
  instances: Record<string, Instance>;
  players: Record<string, {xp: number}>;
  active_settings: string[];
  battle_context: BattleContext | null;
  copied_heroes?: Record<string, {card_ids: string[]; full_card?: boolean; preserve_attack: boolean}>;
  continuous_effects?: {kind: string; scope: string; player_id: string; amount: number; source_card_id?: string;
    source_instance_id?: string; until?: string; created_turn?: number}[];
  attachments?: Record<string, {kind: string}[]>;
}
export interface CalculationInput {
  cards: Record<string, Card>; mechanics: Mechanic[]; state: CalculationState;
}
export interface CombatTrace {
  components: ({instance_id: string; card_id: string} & Pick<Stats, 'attack'|'magic_attack'|'light'>)[];
  modifiers: Partial<Stats>;
  attack: number; magic_attack: number; light: number; light_requirement: number;
  darkness: number; darkness_penalty: number; effective_attack: number;
  restrictions: string[]; can_defeat: boolean; can_attack: boolean;
  hero_strength: Record<string, number>; equipped_pairs: [string, string][];
  excluded_instance_ids: string[];
  disease_penalties: {instance_id: string; attack_type: string | null; amount: number}[];
  strength_penalties: {instance_id: string; hero_instance_id: string | null; amount: number}[];
}
export class RuleError extends Error {
  constructor(message: string) {super(message); this.name = 'RuleError';}
}
