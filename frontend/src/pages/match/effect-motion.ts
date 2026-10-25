import type {DeckMotionStep, MatchView} from '../../shared/api/types.js';
import type {CardFlightOrigin, DeckAnimationStep, PlayerDeckCard, PlayerDeckState} from '../../shared/components/player-deck-area/index.js';
import {withoutDeckCards} from '../../shared/components/player-deck-area/model.js';

/** Translate committed own-card movements. No rules, RNG, or hidden pile order. */
export function effectMotion(current: PlayerDeckState, step: DeckMotionStep, view: MatchView,
  origin?: CardFlightOrigin | null): {state: PlayerDeckState; animation?: DeckAnimationStep} | null {
  const all = [...current.hand, ...current.draw, ...current.discard, ...current.treasures ?? [], ...current.aside ?? [], ...current.revealed ?? []];
  const card = (record: {instance_id: string; card_id: string}): PlayerDeckCard =>
    all.find(item => item.id === record.instance_id) ?? {id: record.instance_id, cardId: record.card_id,
      name: view.cards[record.card_id]?.name ?? record.card_id};
  if (step.kind === 'shuffle') {
    if (current.draw.length || !current.discard.length) return null;
    const state = {...current, discard: [], draw: [...current.discard].sort((a, b) => a.cardId.localeCompare(b.cardId) || a.id.localeCompare(b.id))};
    return {state, animation: {kind: 'shuffle', state}};
  }
  if (step.kind === 'upgrade') {
    if (!current.hand.some(item => item.id === step.source_card.instance_id) || all.some(item => item.id === step.target_card.instance_id)) return null;
    const state = {...current, hand: current.hand.filter(item => item.id !== step.source_card.instance_id), discard: [...current.discard, card(step.target_card)]};
    return {state, animation: {kind: 'upgrade', sourceInstanceId: step.source_card.instance_id, targetInstanceId: step.target_card.instance_id, state}};
  }
  const items = step.cards.map(card), ids = items.map(item => item.id);
  if (!ids.length || new Set(ids).size !== ids.length) return null;
  if (step.kind === 'destroy') {
    if (ids.some(id => !all.some(card => card.id === id))) return null;
    const state = withoutDeckCards(current, new Set(ids));
    return {state, animation: {kind: 'destroy', instanceIds: ids, state}};
  }
  if (step.kind === 'move') {
    if (step.source === step.destination || ids.some(id => !current[step.source]?.some(item => item.id === id))) return null;
    const state = {...current, [step.source]: current[step.source]!.filter(item => !ids.includes(item.id)),
      [step.destination]: [...current[step.destination] ?? [], ...items]};
    return {state, animation: {kind: 'transfer', source: step.source, destination: step.destination, instanceIds: ids, state}};
  }
  if (all.some(item => ids.includes(item.id))) return null;
  const state = {...current, [step.destination]: [...current[step.destination] ?? [], ...items]};
  const validOrigin = origin && [origin.left, origin.top, origin.width, origin.height].every(Number.isFinite) && origin.width > 0 && origin.height > 0;
  if (!validOrigin || !['hand', 'draw', 'discard'].includes(step.destination)) return {state};
  return {state, animation: {kind: 'gain', destination: step.destination as 'hand' | 'draw' | 'discard', instanceIds: ids,
    origins: Object.fromEntries(ids.map(id => [id, origin])), state}};
}
