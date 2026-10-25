/** Keep existing probe DOM hooks while the component defaults to unique, scoped IDs. */
export function probeElementId(key: string): string {
  if (key === 'first-card') return 'probe-card';
  const match = /^card-((?:hand|draw|discard)-\d+)$/.exec(key);
  if (!match) return key;
  return match[1] === 'draw-0' ? 'draw-pile-card'
    : match[1] === 'discard-7' ? 'discard-pile-card' : `probe-${match[1]}`;
}

/** Preserve the existing public board hooks while its DOM is now component-owned. */
export function probePublicElementId(key: string): string {
  const legacy: Record<string, string> = {
    viewport: 'public-table-viewport', 'dungeon-desktop': 'public-desktop', 'village-desktop': 'village-desktop',
    'dungeon-host': 'dungeon-area', 'village-host': 'village-area', 'dungeon-cards': 'dungeon-probe', 'village-cards': 'village-probe',
    'reset-view': 'reset-public-view', players: 'probe-player-list', 'players-heading': 'player-list-heading',
    'dungeon-tab': 'dungeon-tab', 'village-tab': 'village-tab', 'dungeon-panel': 'dungeon-panel', 'village-panel': 'village-panel',
  };
  return legacy[key] ?? `public-probe-${key}`;
}
