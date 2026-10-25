/** A visible card instance. id identifies the instance; cardId selects its catalog image. */
import type {CardStatus, CardAttachment} from '../game-card/types.js';
export interface PlayerDeckCard {readonly id: string; readonly cardId: string; readonly name: string; readonly statuses?: readonly CardStatus[]; readonly attachments?: readonly CardAttachment[];}
export interface PlayerAuxiliaryCard extends PlayerDeckCard {readonly faceUp?: boolean;}
export type PlayerCardTab = 'hand' | 'treasures' | 'aside' | 'revealed';
export interface PlayerResources {readonly xp: number; readonly gold?: number; readonly goldIncomePreview?: number;}
export interface HandBattleDisplay {
  readonly mandatoryIds: readonly string[];
  readonly equipment: Readonly<Record<string, readonly string[]>>;
}

/** Presentation data supplied by the host. Draw top is first; discard top is last. */
export interface PlayerDeckState {
  readonly hand: readonly PlayerDeckCard[];
  readonly draw: readonly PlayerDeckCard[];
  readonly discard: readonly PlayerDeckCard[];
  readonly treasures?: readonly PlayerAuxiliaryCard[];
  readonly aside?: readonly PlayerAuxiliaryCard[];
  readonly revealed?: readonly PlayerAuxiliaryCard[];
}

/** The host supplies phase text and optional choices, and explicitly clears or replaces the display. */
export interface PlayerResponseChoice {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
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
  readonly error?: string;
  readonly battlePreview?: {readonly outcome: 'win' | 'loss' | 'cannot_attack' | 'unknown'; readonly rank: number; readonly total: number};
  readonly combat?: {readonly attack: number; readonly magicAttack: number; readonly light: number;
    readonly versusTarget?: {readonly attack: number; readonly magicAttack: number; readonly light: number}};
}

export interface DeckTransition {kind: 'draw' | 'discard'; instanceIds: readonly string[];}
/** Captured screen-space bounds, including public desktop pan/zoom. */
export interface CardFlightOrigin {readonly left: number; readonly top: number; readonly width: number; readonly height: number;}
/** Intermediate snapshots are supplied by the host; animations never decide game outcomes. */
export type DeckAnimationStep = {state: PlayerDeckState} & (
  {kind: 'draw' | 'discard' | 'destroy'; instanceIds: readonly string[]}
  | {kind: 'transfer'; instanceIds: readonly string[]; source: keyof PlayerDeckState; destination: keyof PlayerDeckState; fast?: boolean}
  | {kind: 'upgrade'; sourceInstanceId: string; targetInstanceId: string}
  | {kind: 'gain'; instanceIds: readonly string[]; origins: Readonly<Record<string, CardFlightOrigin>>; destination?: 'hand' | 'draw' | 'discard'}
  | {kind: 'shuffle'});

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
  /** Cards in their original auxiliary area or draw/discard browser. */
  onCardTargetClick?: (instanceId: string) => void;
  onHandOrderChange?: (instanceIds: readonly string[]) => void;
  onAutoSortChange?: (enabled: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onResponse?: (responseId: string, choiceId: string) => void;
}
import type {CardImageSource} from '../game-card/types.js';
export type {CardImageSource} from '../game-card/types.js';

