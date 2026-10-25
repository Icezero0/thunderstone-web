import type {DeckMotionStep, MatchView, TableMotionStep} from '../../shared/api/types.js';
type Event = MatchView['event_log'][number];

/** Only combine adjacent misses. Hits, replacements, shuffles and choices are barriers. */
export function animationSchedule(events: readonly Event[]): Event[] {
  const result: Event[] = []; let revealed = 0;
  const move = (event?: Event) => {
    const steps = event?.kind === 'player_card_motion' ? event.steps as DeckMotionStep[] : [];
    return steps.length === 1 && steps[0].kind === 'move' ? steps[0] : null;
  };
  const miss = (index: number) => {
    const reveal = move(events[index]), discard = move(events[index + 1]);
    return reveal && discard && reveal.source === 'draw' && reveal.destination === 'revealed'
      && discard.source === 'revealed' && discard.destination === 'discard' && reveal.cards.length === 1
      && discard.cards.length === 1 && reveal.cards[0].instance_id === discard.cards[0].instance_id
      && events[index].player_id === events[index + 1].player_id;
  };
  const table = (event?: Event) => event?.kind === 'table_card_motion' && (event.steps as TableMotionStep[]).length === 1
    ? (event.steps as TableMotionStep[])[0] : null;
  const tableReveal = (event?: Event) => {
    const step = table(event);
    return step?.source.kind === 'player' && step.source.zone === 'draw'
      && (step.destination.kind === 'owned' && step.destination.zone === 'revealed'
        || step.destination.kind === 'player' && step.destination.zone.startsWith('revealed_') && step.source.player_id === step.destination.player_id) ? step : null;
  };
  const tableMiss = (index: number) => {
    const reveal = tableReveal(events[index]), discard = table(events[index + 1]);
    return reveal?.source.kind === 'player' && discard && discard.destination.kind === 'player'
      && (discard.source.kind === 'owned' && discard.source.zone === 'revealed'
        || discard.source.kind === 'player' && discard.source.zone.startsWith('revealed_')) && discard.destination.zone === 'discard'
      && reveal.source.player_id === discard.destination.player_id && reveal.card.card_id === discard.card.card_id;
  };
  for (let i = 0; i < events.length; i++) {
    if (revealed >= 6 && tableMiss(i)) {
      const opening: TableMotionStep[] = [], closing: TableMotionStep[] = [], start = i;
      const player = (table(events[i])!.source as {player_id: string}).player_id;
      while (i < events.length && opening.length < 8 && tableMiss(i)
        && (table(events[i])!.source as {player_id: string}).player_id === player) {
        opening.push(table(events[i])!); closing.push(table(events[i + 1])!); i += 2;
      }
      result.push({...events[start], fast: true, steps: opening}, {...events[i - 1], fast: true, steps: closing});
      revealed += opening.length; i--; continue;
    }
    if (revealed >= 6 && miss(i)) {
      const cards = [], player = events[i].player_id, start = i;
      while (i < events.length && cards.length < 8 && miss(i) && events[i].player_id === player) {
        cards.push(...move(events[i])!.cards); i += 2;
      }
      result.push({...events[start], fast: true, steps: [{kind: 'move', source: 'draw', destination: 'revealed', cards}]},
        {...events[i - 1], fast: true, steps: [{kind: 'move', source: 'revealed', destination: 'discard', cards}]});
      revealed += cards.length; i--; continue;
    }
    const step = move(events[i]);
    if (step?.source === 'draw' && step.destination === 'revealed') revealed += step.cards.length;
    if (tableReveal(events[i])) revealed++;
    result.push(events[i]);
  }
  return result;
}
