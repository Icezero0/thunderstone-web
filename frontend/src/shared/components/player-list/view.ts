import {node} from '../../dom/elements.js';
import type {PlayerListOptions} from './types.js';

let sequence = 0;
export function createPlayerListView(host: HTMLElement, options: PlayerListOptions) {
  const prefix = options.idPrefix ?? `player-list-${++sequence}`;
  const id = options.elementId ?? ((key: string) => `${prefix}-${key}`);
  const root = node('aside', 'player-list-area public-player-list game-cursor', undefined, id('players')); root.hidden = true;
  const title = node('h2', '', '玩家', id('players-heading'));
  root.setAttribute('aria-labelledby', title.id);
  const list = node('ul'); root.append(title, list); host.append(root);
  const overlays = node('div', 'player-list-overlays', undefined, id('player-overlays'));
  (options.overlayRoot ?? document.body).append(overlays);
  return {root, list, overlays, id, dispose: () => {root.remove(); overlays.remove();}};
}
