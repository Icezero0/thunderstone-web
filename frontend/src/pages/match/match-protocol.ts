import type {MatchView} from '../../shared/api/types.js';

export function viewCursor(view: MatchView | null) {
  return view?.sync ? {sync: {epoch: view.history?.epoch ?? 0, after_event: view.sync.event_sequence,
    history_after: view.sync.history_loaded ? view.sync.history_after : null}} : {};
}
export function viewQuery(view: MatchView | null): string {
  const params = new URLSearchParams({compact: 'true'}), cursor = viewCursor(view).sync;
  if (cursor) for (const [key, value] of Object.entries(cursor)) if (value !== null) params.set(key, String(value));
  return `?${params}`;
}
/** Keep historical summaries locally; never concatenate old animation/event payloads. */
export function mergeMatchView(previous: MatchView | null, next: MatchView): MatchView {
  if (!next.sync || previous?.id !== next.id || !previous.sync?.history_loaded || !next.history) return next;
  const entries = new Map(previous.history?.entries.map(entry => [entry.step, entry]));
  for (const entry of next.history.entries) entries.set(entry.step, entry);
  return {...next, history: {...next.history, entries: [...entries.values()].sort((a, b) => a.step - b.step)},
    sync: {...next.sync, history_loaded: true, history_after: Math.max(previous.sync.history_after, next.sync.history_after)}};
}
