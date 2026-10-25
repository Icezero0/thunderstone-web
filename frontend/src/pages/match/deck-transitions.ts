import type {MatchView} from '../../shared/api/types.js';
import type {CardFlightOrigin, DeckAnimationStep, PlayerDeckState} from '../../shared/components/player-deck-area/index.js';
import {withoutDeckCards} from '../../shared/components/player-deck-area/model.js';

/** Effect gains animate only when the engine names a public supply origin. */
export function supplyGainDestination(event: MatchView['event_log'][number]): 'hand' | 'draw' | 'discard' | null {
  if (event.kind === 'card_bought') return 'discard';
  if (!['effect_card_gained', 'effect_purchase_completed'].includes(event.kind) || typeof event.source !== 'string'
    || !/^(basic_supply|village_supply|hero_supply):/.test(event.source)) return null;
  return ['hand', 'draw', 'discard'].includes(event.destination as string) ? event.destination as 'hand' | 'draw' | 'discard' : null;
}

/** Reconstruct presentation stages from known inventories and committed outcomes, never hidden deck order. */
export function deckTransitions(previous: PlayerDeckState, final: PlayerDeckState,
  events: MatchView['event_log'], viewer: string, origins: Readonly<Record<string, CardFlightOrigin>> = {}): DeckAnimationStep[] {
  const own = events.filter(event => event.player_id === viewer);
  const steps: DeckAnimationStep[] = []; let current = previous;
  const add = (step: DeckAnimationStep) => {steps.push(step); current = step.state;};
  const finalOwned = new Set([...final.hand, ...final.draw, ...final.discard, ...final.treasures ?? [], ...final.aside ?? []].map(card => card.id));
  const previousOwned = new Set([...previous.hand, ...previous.draw, ...previous.discard,
    ...previous.treasures ?? [], ...previous.aside ?? []].map(card => card.id));
  const upgradeSources = new Set<string>(), upgradeTargets = new Set<string>();
  for (const event of own.filter(event => event.kind === 'hero_upgraded')) {
    const sources = previous.hand.filter(card => card.cardId === event.source_card_id && !finalOwned.has(card.id) && !upgradeSources.has(card.id));
    const targets = final.discard.filter(card => card.cardId === event.target_card_id && !previousOwned.has(card.id) && !upgradeTargets.has(card.id));
    if (sources.length !== 1 || targets.length !== 1) return []; // No guessed upgrade identities.
    const source = sources[0], target = targets[0]; upgradeSources.add(source.id); upgradeTargets.add(target.id);
    add({kind: 'upgrade', sourceInstanceId: source.id, targetInstanceId: target.id,
      state: {...current, hand: current.hand.filter(card => card.id !== source.id), discard: [...current.discard, target]}});
  }
  const destruction = own.filter(event => event.kind === 'card_destroyed' || event.kind === 'rest_card_destroyed');
  const destroyed = [...previous.hand, ...previous.draw, ...previous.discard, ...previous.treasures ?? [], ...previous.aside ?? []]
    .filter(card => !finalOwned.has(card.id) && !upgradeSources.has(card.id) && destruction.some(event => event.card_id === card.cardId));
  for (const cardId of new Set(destroyed.map(card => card.cardId))) {
    const explicit = destruction.filter(event => event.kind === 'card_destroyed' && event.card_id === cardId);
    const count = explicit.length || destruction.filter(event => event.kind === 'rest_card_destroyed' && event.card_id === cardId).length;
    if (destroyed.filter(card => card.cardId === cardId).length > count) return []; // Ambiguous identical-card removals: snap instead.
  }
  if (destroyed.length) add({kind: 'destroy', instanceIds: destroyed.map(card => card.id),
    state: withoutDeckCards(current, new Set(destroyed.map(card => card.id)))});

  for (const destination of ['hand', 'draw', 'discard'] as const) {
    const bought = own.filter(event => supplyGainDestination(event) === destination);
    const purchases = final[destination].filter(card => !previousOwned.has(card.id) && !upgradeTargets.has(card.id) && bought.some(event => event.card_id === card.cardId));
    if (!purchases.length) continue;
    // Do not guess which of several identical gains was the paid purchase.
    for (const cardId of new Set(purchases.map(card => card.cardId)))
      if (purchases.filter(card => card.cardId === cardId).length !== bought.filter(event => event.card_id === cardId).length) return [];
    if (purchases.some(card => !origins[card.cardId])) return [];
    add({kind: 'gain', destination, instanceIds: purchases.map(card => card.id),
      origins: Object.fromEntries(purchases.map(card => {const rect = origins[card.cardId];
        return [card.id, {left: rect.left, top: rect.top, width: rect.width, height: rect.height}];})),
      state: {...current, [destination]: [...current[destination], ...purchases]}});
  }

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
