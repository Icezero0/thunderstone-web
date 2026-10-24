import type {PlayerDeckCard, PlayerDeckState} from './types.js';

/** Stable for repeated copies; sorting the display never changes a pile's order. */
export function sortHandByCardId(hand: readonly PlayerDeckCard[]): PlayerDeckCard[] {
  return [...hand].sort((a, b) => a.cardId.localeCompare(b.cardId, 'en', {numeric: true}));
}

export function copyDeckState(state: PlayerDeckState): PlayerDeckState {
  const cards = allDeckCards(state);
  if (cards.some(card => typeof card.id !== 'string' || !card.id || typeof card.cardId !== 'string' || !card.cardId ||
    typeof card.name !== 'string') || new Set(cards.map(card => card.id)).size !== cards.length) {
    throw new Error('PlayerDeckArea requires a unique, nonempty instance id for each card.');
  }
  if ([...(state.treasures ?? []), ...(state.aside ?? [])].some(card => card.faceUp !== undefined && typeof card.faceUp !== 'boolean')) {
    throw new Error('Auxiliary card faceUp must be boolean.');
  }
  // Copy the small records too: the component must not retain mutable host state.
  const copy = (items: readonly PlayerDeckCard[]) => items.map(card => ({...card}));
  return {hand: copy(state.hand), draw: copy(state.draw), discard: copy(state.discard),
    ...(state.treasures === undefined ? {} : {treasures: copy(state.treasures)}),
    ...(state.aside === undefined ? {} : {aside: copy(state.aside)})};
}

export function allDeckCards(state: PlayerDeckState): readonly PlayerDeckCard[] {
  return [...state.hand, ...state.draw, ...state.discard, ...(state.treasures ?? []), ...(state.aside ?? [])];
}
