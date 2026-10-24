export interface HandLayout {
  positions: number[];
  step: number;
  overlap: number;
}

/** Compress the n-1 intervals, preserving both outside card edges. */
export function layoutHand(count: number, availableWidth: number, cardWidth: number, gap = 14): HandLayout {
  if (count <= 0) return {positions: [], step: 0, overlap: 0};
  const width = Math.max(0, availableWidth), size = Math.max(0, Math.min(cardWidth, width));
  const step = count === 1 ? 0 : Math.min(size + gap, Math.max(0, (width - size) / (count - 1)));
  const start = Math.max(0, (width - (size + step * (count - 1))) / 2);
  return {positions: Array.from({length: count}, (_, index) => start + index * step),
    step, overlap: count > 1 ? Math.max(0, size - step) : 0};
}

/** Pick an insertion slot using the dragged card's left edge, including overlapped hands. */
export function handInsertionIndex(left: number, layout: HandLayout, previous: number): number {
  if (layout.step <= 0 || !layout.positions.length) return previous;
  return Math.max(0, Math.min(layout.positions.length - 1,
    Math.round((left - layout.positions[0]) / layout.step)));
}
