import type {DungeonState, VillageOptions, VillageState} from '../table-areas/index.js';
import type {PlayerListPlayer} from '../player-list/types.js';
export type {PlayerBrowseZone, PublicPlayerCard, PublicPlayerHandCard, PublicPlayerCards,
  PlayerListPlayer as PublicTablePlayer} from '../player-list/types.js';

export type PublicTableTab = 'dungeon' | 'village';
/** Public presentation only. Dungeon decks contain counts, never hidden card order. */
export interface PublicTableState {
  readonly dungeon: DungeonState;
  readonly village: VillageState;
  readonly players?: readonly PlayerListPlayer[];
}
export interface PublicTableOptions extends VillageOptions {
  /** Defaults to unique, component-scoped IDs. Optional hook for existing integrations. */
  elementId?: (key: string) => string;
  initialTab?: PublicTableTab;
  onTabChange?: (tab: PublicTableTab) => void;
  onPlayerClick?: (playerId: string) => void;
  onCardTargetClick?: (instanceId: string) => void;
}
