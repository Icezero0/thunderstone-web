import type {MatchView} from '../../shared/api/types.js';
import type {DeckAnimationStep, PlayerDeckState} from '../../shared/components/player-deck-area/index.js';

/** Reconstruct presentation stages from known inventories and committed outcomes, never hidden deck order. */
export function deckTransitions(previous: PlayerDeckState, final: PlayerDeckState,
  events: MatchView['event_log'], viewer: string): DeckAnimationStep[] {
  const own = events.filter(event => event.player_id === viewer);
  const steps: DeckAnimationStep[] = []; let current = previous;
  const add = (step: DeckAnimationStep) => {steps.push(step); current = step.state;};
  const finalOwned = new Set([...final.hand, ...final.draw, ...final.discard, ...final.treasures ?? [], ...final.aside ?? []].map(card => card.id));
  const destruction = own.filter(event => event.kind === 'card_destroyed' || event.kind === 'rest_card_destroyed');
  const destroyed = previous.hand.filter(card => !finalOwned.has(card.id) && destruction.some(event => event.card_id === card.cardId));
  for (const cardId of new Set(destroyed.map(card => card.cardId))) {
    const explicit = destruction.filter(event => event.kind === 'card_destroyed' && event.card_id === cardId);
    const count = explicit.length || destruction.filter(event => event.kind === 'rest_card_destroyed' && event.card_id === cardId).length;
    if (destroyed.filter(card => card.cardId === cardId).length > count) return []; // Ambiguous identical-card removals: snap instead.
  }
  if (destroyed.length) add({kind: 'destroy', instanceIds: destroyed.map(card => card.id),
    state: {...current, hand: current.hand.filter(card => !destroyed.some(victim => victim.id === card.id))}});

  const cleanup = own.some(event => event.kind === 'turn_hand_discarded');
  const discarded = cleanup ? [...current.hand] : final.discard.filter(card => current.hand.some(old => old.id === card.id));
  if (discarded.length) add({kind: 'discard', instanceIds: discarded.map(card => card.id), state: {...current,
    hand: current.hand.filter(card => !discarded.some(moved => moved.id === card.id)), discard: [...current.discard, ...discarded]}});

  const drawn = final.hand.filter(card => !current.hand.some(old => old.id === card.id));
  const draw = (cards: typeof drawn): boolean => {
    if (!cards.length) return true;
    if (cards.some(card => !current.draw.some(old => old.id === card.id))) return false;
    add({kind: 'draw', instanceIds: cards.map(card => card.id), state: {...current, hand: [...current.hand, ...cards],
      draw: current.draw.filter(card => !cards.some(moved => moved.id === card.id))}});
    return true;
  };
  const beforeShuffle = drawn.filter(card => current.draw.some(old => old.id === card.id));
  if (!draw(beforeShuffle)) return [];
  if (own.some(event => event.kind === 'player_deck_shuffled')) {
    // Known remaining cards are drawn first; the shuffled inventory is deliberately unordered.
    if (current.draw.length || !current.discard.length) return [];
    add({kind: 'shuffle', state: {...current, discard: [], draw: [...current.discard].sort((a, b) => a.cardId.localeCompare(b.cardId) || a.id.localeCompare(b.id))}});
  }
  if (!draw(drawn.filter(card => !beforeShuffle.some(old => old.id === card.id)))) return [];
  // Multiple missed operations or effect continuations may not be reconstructible. Snap safely instead of inventing movements.
  const ids = (cards: PlayerDeckState['hand']) => cards.map(card => `${card.id}:${card.cardId}`).sort().join('|');
  return (['hand', 'draw', 'discard'] as const).every(zone => ids(current[zone]) === ids(final[zone])) ? steps : [];
}
