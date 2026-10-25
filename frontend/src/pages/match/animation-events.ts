import type {MatchView} from '../../shared/api/types.js';

type Event = MatchView['event_log'][number];
/** Evolution owns the removal of its old card; it is not a separate dissolve. */
export function isUpgradeDestruction(event: Event, events: readonly Event[]): boolean {
  return event.kind === 'card_destroyed' && (event.cause === 'hero_upgrade' || event.cause === undefined
    && events.some(next => next.kind === 'hero_upgraded' && next.player_id === event.player_id && next.source_card_id === event.card_id));
}
/** Disease generation/replacement already owns the public removal animation. */
export function isDiseaseGainDestruction(event: Event, events: readonly Event[]): boolean {
  return event.kind === 'card_destroyed' && (event.cause === 'disease_gain' || event.cause === undefined
    && events.some(next => next.kind === 'disease_gain_destroyed' && next.card_id === event.card_id));
}
