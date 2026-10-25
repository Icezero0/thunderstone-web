let sequence = 0;

/** Mount outside modal backgrounds so cards in any game region can inspect the same way. */
export function createCardInspection(host: HTMLElement = document.body,
  ids: {overlay?: string; content?: string} = {}): {overlay: HTMLElement; content: HTMLElement; dispose(): void} {
  const prefix = `game-card-inspection-${++sequence}`;
  const overlay = document.createElement('section');
  overlay.id = ids.overlay ?? prefix; overlay.className = 'inspect-overlay game-card-inspection game-cursor'; overlay.hidden = true;
  overlay.setAttribute('aria-label', '卡牌大图');
  const content = document.createElement('div'); content.className = 'inspect-content';
  content.id = ids.content ?? `${prefix}-content`;
  overlay.append(content); host.append(overlay);
  return {overlay, content, dispose: () => overlay.remove()};
}
