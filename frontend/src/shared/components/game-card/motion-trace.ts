type TraceWindow = Window & {__traceCardMotion?: boolean; __cardMotionTrace?: Record<string, unknown>[]};
/** Opt-in diagnostics only; no snapshots, screenshots, network calls or game secrets. */
export function traceCardMotion(step: string, detail: Record<string, unknown> = {}): void {
  const target = window as TraceWindow;
  if (!target.__traceCardMotion) return;
  const rows = target.__cardMotionTrace ??= [];
  rows.push({step, ...detail}); if (rows.length > 150) rows.splice(0, rows.length - 150);
  console.info('[card-motion]', rows[rows.length - 1]);
}
