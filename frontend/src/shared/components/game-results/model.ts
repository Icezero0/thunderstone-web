export interface GameResultPlayer {
  id: string; name: string; avatarUrl?: string | null;
  total: number; cardPoints?: number; experiencePoints?: number;
  thunderstones: number; winner: boolean; eliminated?: boolean;
}

/** Keep the server's totals and winners; presentation only determines row order and scale. */
export function resultRows(players: readonly GameResultPlayer[]) {
  const ordered = [...players].sort((a, b) => b.total - a.total
    || Number(b.thunderstones > 0) - Number(a.thunderstones > 0));
  const low = Math.min(0, ...ordered.map(player => player.total));
  const high = Math.max(0, ...ordered.map(player => player.total));
  const span = high - low || 1, zero = -low / span * 100;
  let rank = 1;
  return ordered.map((player, index) => {
    const previous = ordered[index - 1];
    if (previous && (previous.total !== player.total || (previous.thunderstones > 0) !== (player.thunderstones > 0))) rank = index + 1;
    const point = (player.total - low) / span * 100;
    return {...player, rank, zero, point, start: Math.min(zero, point), length: Math.abs(point - zero)};
  });
}
