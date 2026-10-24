/** A visible card instance. id identifies the instance; cardId selects its catalog image. */
export interface PlayerDeckCard {readonly id: string; readonly cardId: string; readonly name: string;}
export interface PlayerAuxiliaryCard extends PlayerDeckCard {readonly faceUp?: boolean;}
export type PlayerCardTab = 'hand' | 'treasures' | 'aside';

/** Presentation data supplied by the host. Draw top is first; discard top is last. */
export interface PlayerDeckState {
  readonly hand: readonly PlayerDeckCard[];
  readonly draw: readonly PlayerDeckCard[];
  readonly discard: readonly PlayerDeckCard[];
  readonly treasures?: readonly PlayerAuxiliaryCard[];
  readonly aside?: readonly PlayerAuxiliaryCard[];
}

/** The host supplies phase text and optional choices, and explicitly clears or replaces the display. */
export interface PlayerResponseChoice {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: 'gold' | 'violet' | 'blue' | 'red';
}
export interface PlayerResponse {
  readonly id: string;
  readonly prompt: string;
  readonly choices?: readonly PlayerResponseChoice[];
  readonly isCurrentTurn?: boolean;
  /** Read-only action/stage text supplied by the host, beside the turn marker. */
  readonly progress?: {readonly action: string; readonly stage: string; readonly step: number; readonly total: number};
  readonly selectedId?: string;
  readonly disabled?: boolean;
}

export interface DeckTransition {kind: 'draw' | 'discard'; instanceIds: readonly string[];}
/** Intermediate snapshots are supplied by the host; animations never decide game outcomes. */
export type DeckAnimationStep = {state: PlayerDeckState} & (
  {kind: 'draw' | 'discard' | 'destroy'; instanceIds: readonly string[]} | {kind: 'shuffle'});

export interface PlayerDeckOptions {
  /** Keep overlays outside any parent that becomes inert when browsing. Defaults to document.body. */
  overlayRoot?: HTMLElement;
  /** Page regions disabled while the pile browser is open. Defaults to the component root. */
  background?: readonly HTMLElement[];
  images?: Partial<CardImageSource>;
  /** Defaults to a unique prefix. elementId is an optional integration hook for existing DOM IDs. */
  idPrefix?: string;
  elementId?: (key: string) => string;
  descriptionId?: string;
  notice?: HTMLElement;
  onSelectionChange?: (instanceIds: readonly string[]) => void;
  /** Return true to consume a click instead of toggling the ordinary selection. */
  onHandCardClick?: (instanceId: string) => boolean | void;
  onHandOrderChange?: (instanceIds: readonly string[]) => void;
  onAutoSortChange?: (enabled: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onResponse?: (responseId: string, choiceId: string) => void;
}
import type {CardImageSource} from '../game-card/types.js';
export type {CardImageSource} from '../game-card/types.js';

