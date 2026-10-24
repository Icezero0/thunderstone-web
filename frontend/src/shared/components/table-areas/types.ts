import type {CardImageSource} from '../game-card/index.js';

export interface TableCard {readonly id: string; readonly cardId: string; readonly name: string;}
export interface DungeonLane {
  readonly id: string;
  readonly name: string;
  readonly deckCount: number;
  readonly hall: readonly {readonly rank: number; readonly card: TableCard | null}[];
}
export interface DungeonState {
  /** One game-wide environment, also shared by games with two dungeons. */
  readonly environment?: TableCard | null;
  readonly dungeons: readonly DungeonLane[];
}
export interface SupplyCard {
  readonly cardId: string; readonly name: string; readonly count: number | null; readonly level?: number;
  readonly tags?: readonly string[];
}
export interface SupplyPile {
  readonly id: string;
  readonly name: string;
  readonly kind: 'hero' | 'village' | 'basic';
  /** All levels, including sold-out ones, in one supply. Village heroes also use this structure. */
  readonly cards: readonly SupplyCard[];
}
export interface VillageState {readonly piles: readonly SupplyPile[];}
export interface TableAreaOptions {
  onHallCardClick?: (card: TableCard) => void;
  overlayRoot?: HTMLElement;
  background?: readonly HTMLElement[];
  images?: Partial<CardImageSource>;
  idPrefix?: string;
}
export interface SupplySelection {
  readonly pileId: string; readonly cardId: string; readonly name: string;
  readonly level?: number; readonly infinite: boolean;
}
export interface VillageOptions extends TableAreaOptions {
  /** Return true to consume a top-card click instead of opening its hero preview. */
  onSupplyClick?: (selection: SupplySelection) => boolean | void;
  /** Host decides costs, creates instances and supplies the resulting snapshot. */
  onTakeTop?: (selection: SupplySelection) => void;
  takeLabel?: string;
}
