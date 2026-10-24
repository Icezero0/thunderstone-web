import type {Card, Instance} from '../types.js';
import type {RandomState} from '../random/stream.js';

export type GroupKind = 'village'|'hero'|'monster';
export type FeatureKind = 'guardian'|'environment'|'trap'|'treasure';
export type GroupCounts = Record<'village_groups'|'hero_groups'|'monster_groups', number>;
export interface RulesConfig {
  mode: 'classic'; counts: GroupCounts;
  selection: Record<GroupKind, {fixed_randomizer_ids: string[]}>
    & Record<'guardian'|'environment', {random_count: number; fixed_card_ids: string[]}>
    & Record<'trap'|'treasure', {random_count: number; fixed_group_ids: string[]}>
    & {dungeon_features: {mode: 'classic_random'|'manual'}; thunderstone: {fixed_card_ids: string[]}};
  instance_multipliers: Record<GroupKind, number>;
}
export interface SetupRequest {
  match_id: string; player_ids: string[]; rng_seed: string|number;
  config: RulesConfig; first_player?: {mode: 'random'|'fixed'; player_id?: string};
  scenario_choices?: {two_dungeons?: {group_a_ids?: string[]; group_a_feature_ids?: string[]}};
  catalog_version?: string; ruleset_version?: string;
}
export interface CatalogGroup {randomizer_id: string; kind: GroupKind; members: string[]}
export interface DungeonFeature {
  feature_id: string; kind: 'trap_group'|'treasure_group'|'draw_guardian'|'draw_environment'|'draw_features';
  members?: string[]; count?: number;
}
export interface SetupIndex {
  cards_csv_sha256: string; groups: CatalogGroup[]; dungeon_features: DungeonFeature[];
  randomizer_pools: Record<'hero'|'village'|'monster_or_feature', string[]>;
  dungeon_feature_entry: {randomizer_id: string; draw_feature_count: number};
  other_pools: Record<'guardian'|'environment'|'thunderstone'|'disease', string[]>;
}
export interface PanelCatalog {
  catalog_hash: string;
  groups: Record<GroupKind, {id: string}[]>;
  dungeon_cards: Record<'guardian'|'environment', {id: string; name: string}[]>;
  dungeon_groups: Record<'trap'|'treasure', {id: string}[]>;
  thunderstones: {id: string}[];
}
export interface SetupInput {
  request: unknown; cards: Record<string, Card>; index: SetupIndex; panel: PanelCatalog;
  /** Adapter-owned artifact identity, using the pre-migration canonical JSON format. */
  frozen_config_id: string; effects_version: string;
}
export interface SetupInstance extends Instance {owner_player_id: string|null; origin: string; flags: Record<string, unknown>}
export interface SetupEvent {sequence: number; kind: string; [key: string]: unknown}
export interface SetupState {
  match_id: string; game_version: number; catalog_version: string; ruleset_version: string;
  effects_version: string; frozen_config_id: string; frozen_config: RulesConfig;
  player_order: string[]; first_player_id: string; active_player_id: string;
  turn_number: number; round_number: number; phase: string; subphase: string; timing_window: string;
  /** The current player's whole hand is public until end-of-turn refill begins. */
  turn_hand_public: boolean;
  chosen_action: null; players: Record<string, {xp: number; temporary_gold: number; purchases_remaining: number}>;
  zones: Record<string, string[]>; instances: Record<string, SetupInstance>;
  selected_groups: Record<GroupKind, string[]>; selected_features: Record<FeatureKind, string[]>;
  selected_thunderstones: string[]; active_settings: string[];
  supply_rules: {basic_card_ids: string[]; basic_infinite: boolean; disease_mode: string;
    disease_card_ids: string[]; disease_weights: Record<string, number>; disease_infinite: boolean};
  continuous_effects: []; registered_triggers: []; scheduled_effects: [];
  battle_context: null; pending_choice: null; resolution_frames: []; end_condition: null;
  rng_state: RandomState; next_instance_sequence: number; next_event_sequence: number;
}
export interface SetupResult {state: SetupState; events: SetupEvent[]}
