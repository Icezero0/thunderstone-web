import {predictAction} from '@thunderstone/engine';
import type {MatchView, GameCommand, MatchCardInstance, DeckMotionStep} from '../../shared/api/types.js';
import {isDestructionEvent} from './animation-events.js';

/** Presentation only: calculations and legality come from the shared engine. */
export function predictMatchAction(view: MatchView, command: GameCommand): MatchView | null {
  if (!view.action_prediction || !view.turn || view.actor_player_id !== view.viewer_player_id) return null;
  const result = predictAction(view.action_prediction, command);
  if (!result) return null;
  const {state, events} = result, player = view.viewer_player_id;
  const known = {...view.action_prediction.state.instances, ...state.instances};
  const previous = new Map([...view.hand, ...view.discard].map(card => [card.instance_id, card]));
  const card = (id: string): MatchCardInstance => ({...previous.get(id), instance_id: id, card_id: known[id].card_id});
  const hand = state.zones[`player:${player}:hand`].map(card), discard = state.zones[`player:${player}:discard`].map(card);
  const supplies = view.supplies.map(supply => {
    if (supply.infinite) return supply;
    const pile: string[] = state.zones[supply.zone_id] ?? [];
    return {...supply, remaining: pile.length, top_card_id: pile.length ? known[pile[0]].card_id : null,
      cards: supply.cards.map(row => ({...row, count: pile.filter(id => known[id].card_id === row.card_id).length}))};
  });
  const motions: NonNullable<MatchView['card_motion']> = [];
  const tableMotions: NonNullable<MatchView['table_motion']> = [];
  for (const event of events) {
    let steps: DeckMotionStep[] = [];
    if (event.kind === 'card_bought') steps = [{kind: 'gain', source: 'supply', destination: 'discard', cards: [card(event.instance_id)]}];
    if (event.kind === 'hero_upgraded') steps = [{kind: 'upgrade', source_card: card(event.source_instance_id), target_card: card(event.target_instance_id)}];
    if (event.kind === 'card_destroyed' && event.reason !== 'hero_upgrade') steps = [{kind: 'destroy', cards: [card(event.instance_id)]}];
    if (event.kind === 'destruction_returned_to_supply' && event.reason !== 'hero_upgrade') {
      const returned = card(event.instance_id);
      tableMotions.push({sequence: event.sequence, kind: 'table_card_motion', steps: [{
        source: {kind: 'owned', zone: 'hand'}, destination: {kind: 'supply', card_id: returned.card_id,
          zone_id: event.destination === 'basic_supply' ? `basic_supply:${returned.card_id}` : event.destination}, card: returned,
      }]});
    }
    if (steps.length) motions.push({sequence: event.sequence, kind: 'player_card_motion', player_id: player, steps});
  }
  const resources = state.players[player];
  // Match the server's public destruction semantics. Raw engine events use
  // `reason` and an owner encoded in `source`; the animation timeline reads
  // `cause` and `player_id`. In particular, upgrading owns its old card's exit.
  const eventLog = events.map(event => {
    if (!isDestructionEvent({kind: event.kind}) && event.kind !== 'card_destruction_replaced') return event;
    const owner = typeof event.source === 'string' && event.source.startsWith('player:') ? event.source.split(':')[1] : undefined;
    return {...event, cause: ['hero_upgrade', 'after_battle', 'trap_resolved'].includes(event.reason) ? event.reason : 'effect',
      ...(owner ? {player_id: owner} : {})};
  });
  return {...view, version: view.version + 1, action_prediction: result.context,
    turn: {...view.turn, subphase: state.subphase, timing_window: state.timing_window},
    hand, discard, supplies, players: view.players.map(row => row.player_id !== player ? row : {...row,
      xp: resources.xp, hand_count: hand.length, discard_count: discard.length,
      cards: {...row.cards, draw: row.cards?.draw ?? [], hand: hand.map((item: MatchCardInstance) => ({...item, revealed: !!state.turn_hand_public})),
        discard: [...discard].sort((a: MatchCardInstance, b: MatchCardInstance) => a.card_id.localeCompare(b.card_id) || a.instance_id.localeCompare(b.instance_id))}}),
    viewer_resources: {...view.viewer_resources, xp: resources.xp, temporary_gold: resources.temporary_gold,
      purchases_remaining: resources.purchases_remaining, extra_basic_purchases: resources.extra_basic_purchases ?? 0, gold_income_preview: null},
    legal_commands: result.legal_commands as MatchView['legal_commands'], command_instances: {}, pending_choice: null,
    event_log: eventLog as MatchView['event_log'], card_motion: motions, table_motion: tableMotions,
    ...(view.sync ? {sync: {...view.sync, reset: false, event_sequence: state.next_event_sequence - 1}} : {})};
}

/** Compare what the predicted commands actually change, independently of transport-only fields. */
export function predictionMatches(predicted: MatchView, actual: MatchView): boolean {
  const key = (view: MatchView) => JSON.stringify([view.id, view.version, view.history?.epoch, view.status,
    view.turn?.subphase, view.turn?.number, view.actor_player_id, view.pending_choice?.kind ?? null,
    view.legal_commands.map(command => command.type),
    [view.viewer_resources.xp, view.viewer_resources.temporary_gold, view.viewer_resources.purchases_remaining, view.viewer_resources.extra_basic_purchases],
    view.hand.map(c => [c.instance_id, c.card_id]), view.discard.map(c => [c.instance_id, c.card_id]),
    view.supplies.map(s => [s.zone_id, s.top_card_id, s.remaining, s.cards.map(c => [c.card_id, c.count])])]);
  return key(predicted) === key(actual);
}
