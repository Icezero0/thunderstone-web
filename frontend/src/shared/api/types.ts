import type {BattleDraft, PreviewContext} from '@thunderstone/engine';

export interface User {id: number; email: string; username: string | null; avatar_url?: string | null}
export interface Player {user_id: number; display_name: string; ready: boolean; avatar_url?: string | null}
export interface RulesConfig {
  mode: 'classic';
  counts: {village_groups: number; hero_groups: number; monster_groups: number};
  selection: {
    village: {fixed_randomizer_ids: string[]}; hero: {fixed_randomizer_ids: string[]};
    monster: {fixed_randomizer_ids: string[]}; dungeon_features: {mode: string};
    guardian: {random_count: number; fixed_card_ids: string[]};
    environment: {random_count: number; fixed_card_ids: string[]};
    trap: {random_count: number; fixed_group_ids: string[]};
    treasure: {random_count: number; fixed_group_ids: string[]};
    thunderstone: {fixed_card_ids: string[]};
  };
  instance_multipliers: {village: number; hero: number; monster: number};
}
export interface RoomSummary {
  is_public: boolean;
  id: string; name: string; host_user_id: number; host_name: string;
  status: 'waiting' | 'playing' | 'closed'; version: number; config_version: number;
  active_match_id: string | null;
  player_count: number; created_at: string;
}
export interface Room extends RoomSummary {players: Player[]; config: RulesConfig; all_ready: boolean}
export interface Catalog {card_names: Record<string, string>}

export interface MatchCard {
  card_id: string; name: string; card_type: string; subcategory: string; tags: string[];
  effects: string; image_url: string; stats: Record<string, string>;
}
export interface MatchCardInstance {instance_id: string; card_id: string}
export interface MatchPlayer {
  avatar_url?: string | null;
  user_id: number; player_id: string; display_name: string; is_you: boolean; is_active: boolean; eliminated?: boolean;
  xp: number; hand_count: number; draw_count: number; discard_count: number; control: MatchCardInstance[];
  cards?: {hand: {instance_id: string; card_id?: string; revealed: boolean}[]; draw: MatchCardInstance[]; discard: MatchCardInstance[]};
}
export interface MatchSupply {
  name?: string;
  zone_id: string; kind: 'basic' | 'village' | 'hero'; top_card_id: string | null;
  remaining: number | null; infinite: boolean; cards: {card_id: string; count: number | null}[];
}
export interface MatchView {
  id: string; room_id: string; status: 'setup_pending' | 'active' | 'cancelled' | 'finished'; version: number;
  host_user_id: number; viewer_player_id: string; can_resolve_setup: boolean; created_at: string;
  players: MatchPlayer[];
  turn: null | {number: number; round: number; active_player_id: string; first_player_id: string; phase: string; subphase: string;
    chosen_action?: 'village' | 'dungeon' | 'rest' | null; timing_window?: string | null; resolving_event?: string | null};
  hand: MatchCardInstance[]; draw?: MatchCardInstance[]; discard: MatchCardInstance[]; aside?: MatchCardInstance[]; supplies: MatchSupply[];
  dungeons: {id: 'main' | 'a' | 'b'; deck_count: number; rank_count?: number; hall: {rank: number; instance_id: string; card_id: string}[]}[];
  settings: MatchCardInstance[];
  disease_supply: null | {mode: 'normal' | 'special'; infinite: true; cards: {card_id: string; weight: number}[]};
  setup_choice: null | {kind: 'two_dungeons'; group_ids: string[]; feature_ids: string[]; group_a_count: number};
  cards: Record<string, MatchCard>;
  actor_player_id: string | null;
  legal_commands: LegalCommand[];
  pending_choice: null | {kind: string; player_id: string; can_resolve: boolean; ability_id?: string;
    source_instance_id?: string; stage?: string; value_kind?: string; event?: string};
  command_instances: Record<string, MatchCardInstance & {owner_player_id?: string | null}>;
  abilities: Record<string, {source_card_id: string; source_line: string}>;
  battle_preparation: null | {context: PreviewContext; draft: BattleDraft;
    options: {hero_instance_ids: string[]; support_instance_ids: string[]; weapon_instance_ids: string[];
      mandatory_instance_ids: string[]; target_instance_ids: string[]}};
  viewer_resources: {xp: number; temporary_gold: number; purchases_remaining: number; extra_basic_purchases: number};
  event_log: Array<{sequence: number; kind: string; [key: string]: unknown}>;
  unavailable_reason?: string | null;
  result: null | {players: Record<string, {victory_points: number; thunderstones: number; eliminated: boolean}>;
    winner_ids: string[]; tie_break: string | null};
}

export interface CommandOption {
  ability_id?: string; source_instance_id?: string; target_card_id?: string; xp_cost?: number;
  card_id?: string; price?: number; budget?: number; action?: string;
  hero_instance_id?: string; weapon_instance_id?: string;
}
export interface LegalCommand {
  type: string; player_id?: string; actions?: string[]; options?: Array<CommandOption | string | number | boolean>;
  card_ids?: string[]; instance_ids?: string[]; ability_ids?: string[]; hero_instance_ids?: string[];
  min_count?: number; max_count?: number; highest_by?: string | null;
  constraints?: {filter: Record<string, unknown>; maximum: number}[];
  stage?: string; may_decline?: boolean; may_skip?: boolean; ability_id?: string;
  effects?: {effect_id: string; ability_id: string; source_instance_id: string}[];
  penalties?: {instance_id: string; hero_instance_id: string | null; amount: number}[];
  attack_types?: string[]; target_instance_ids?: string[];
}
export type GameCommand = {type: string} & Record<string, unknown>;
