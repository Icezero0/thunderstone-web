import {createCardInspection} from '../game-card/index.js';
import {node} from '../../dom/elements.js';
import {PlayerAvatar} from '../player-avatar/index.js';
import type {PlayerBrowseZone} from './types.js';

export function createPlayerBrowserView(host: HTMLElement, id: (key: string) => string) {
  const overlay = node('section', 'player-browser-overlay browse-dialog game-cursor', undefined, id('player-browser')); overlay.hidden = true;
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
  const panel = node('div', 'player-browser-panel browse-dialog-panel panel'), header = node('header', 'player-browser-heading browse-dialog-heading masthead');
  const identity = node('div', 'player-browser-identity browse-dialog-heading-group'), avatar = new PlayerAvatar();
  const title = node('h2', '', undefined, id('player-browser-title')); identity.append(avatar.root, title);
  overlay.setAttribute('aria-labelledby', title.id);
  const close = node('button', 'button secondary browse-dialog-close', '关闭 ×', id('player-browser-close')); close.type = 'button';
  header.append(identity, close); panel.append(header);
  const tablist = node('div', 'player-browser-tabs'); tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', '玩家牌区');
  const tabs = {} as Record<PlayerBrowseZone, HTMLButtonElement>, counts = {} as Record<PlayerBrowseZone, HTMLElement>;
  for (const [zone, label] of [['hand', '手牌'], ['draw', '抽牌堆'], ['discard', '弃牌堆']] as const) {
    const tab = node('button', 'player-browser-tab', undefined, id(`player-browser-${zone}-tab`)); tab.type = 'button';
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', id('player-browser-grid'));
    const count = node('span', 'player-browser-zone-count'); tab.append(node('span', '', label), count);
    tabs[zone] = tab; counts[zone] = count; tablist.append(tab);
  }
  const grid = node('div', 'player-browser-grid browse-dialog-body browse-dialog-grid', undefined, id('player-browser-grid')); grid.setAttribute('role', 'tabpanel');
  const empty = node('p', 'player-browser-empty browse-dialog-empty', '暂无卡牌', id('player-browser-empty')); grid.append(empty);
  const notice = node('p', 'player-browser-notice'); notice.setAttribute('role', 'status');
  panel.append(tablist, grid, notice); overlay.append(panel); host.append(overlay);
  const inspection = createCardInspection(host, {overlay: id('player-browser-inspect'), content: id('player-browser-inspect-content')});
  return {overlay, title, close, avatar, tabs, counts, grid, empty, notice, inspection,
    dispose: () => {avatar.dispose(); overlay.remove(); inspection.dispose();}};
}
