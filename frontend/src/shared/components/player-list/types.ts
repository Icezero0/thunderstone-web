import type {CardImageSource, CardStatus} from '../game-card/index.js';

export type PlayerBrowseZone = 'hand' | 'draw' | 'discard';
export interface PublicPlayerCard {readonly id: string; readonly cardId: string; readonly name: string; readonly statuses?: readonly CardStatus[];}
/** Hidden opponents' cards need only an opaque instance ID and revealed:false. */
export interface PublicPlayerHandCard {
  readonly id: string; readonly revealed: boolean; readonly cardId?: string; readonly name?: string;
  readonly statuses?: readonly CardStatus[];
}
export interface PublicPlayerCards {
  readonly hand: readonly PublicPlayerHandCard[];
  /** Unordered inventories: neither list communicates the actual pile order. */
  readonly draw: readonly PublicPlayerCard[];
  readonly discard: readonly PublicPlayerCard[];
}
export interface PlayerListPlayer {
  readonly id: string;
  readonly name: string;
  readonly isYou?: boolean;
  readonly isActive?: boolean;
  readonly eliminated?: boolean;
  readonly avatarUrl?: string;
  readonly cards?: PublicPlayerCards;
}
export interface PlayerListOptions {
  overlayRoot?: HTMLElement;
  background?: readonly HTMLElement[];
  images?: Partial<CardImageSource>;
  idPrefix?: string;
  /** Optional ID mapping for existing page hooks. Defaults to unique scoped IDs. */
  elementId?: (key: string) => string;
  /** Host may close another modal or finish table gestures before opening. */
  onBeforeOpen?: (playerId: string, zone: PlayerBrowseZone) => void;
  /** Gameplay selection is handled by the host, independently of browsing. */
  onPlayerClick?: (playerId: string) => void;
  onCardTargetClick?: (instanceId: string) => void;
}
