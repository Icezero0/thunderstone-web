export interface User {id: number; email: string; username: string | null}
export interface Player {user_id: number; display_name: string; ready: boolean}
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
  id: string; name: string; host_user_id: number; host_name: string;
  status: 'waiting' | 'closed'; version: number; config_version: number;
  player_count: number; created_at: string;
}
export interface Room extends RoomSummary {players: Player[]; config: RulesConfig; all_ready: boolean}
export interface Catalog {card_names: Record<string, string>}
