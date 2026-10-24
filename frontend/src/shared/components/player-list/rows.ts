import {node, reconcile} from '../../dom/elements.js';
import type {PlayerListPlayer} from './types.js';
import {PlayerAvatar} from '../player-avatar/index.js';

interface PlayerView {root: HTMLElement; button: HTMLButtonElement; avatar: PlayerAvatar; name: HTMLElement; you: HTMLElement; turn: HTMLElement; open(): void;}
export class PlayerRows {
  private readonly entries = new Map<string, PlayerView>();
  constructor(private list: HTMLElement, private onOpen: (id: string) => void, private browserId: string) {}
  trigger(id: string): HTMLElement | undefined {return this.entries.get(id)?.button;}
  anchor(id: string): HTMLElement | undefined {return this.entries.get(id)?.root;}
  render(players: readonly PlayerListPlayer[]): void {
    const present = new Set(players.map(player => player.id));
    for (const [id, view] of this.entries) if (!present.has(id)) {
      view.avatar.dispose(); view.button.removeEventListener('click', view.open); this.entries.delete(id);
    }
    reconcile(this.list, players.map(player => {
      let view = this.entries.get(player.id);
      if (!view) {
        const root = node('li', 'public-player'), avatar = new PlayerAvatar(), button = node('button', 'public-player-button'); button.type = 'button';
        root.dataset.playerId = player.id;
        const detail = node('div'), label = node('span', 'player-name'), name = node('span'), you = node('small', '', '你');
        const turn = node('span', 'player-turn', '当前回合'); label.append(name, you); detail.append(label, turn); button.append(avatar.root, detail); root.append(button);
        const open = () => {if (!button.disabled) this.onOpen(player.id);}; button.addEventListener('click', open);
        view = {root, button, avatar, name, you, turn, open}; this.entries.set(player.id, view);
      }
      view.avatar.setSource(player.avatarUrl); view.name.textContent = player.name;
      view.button.disabled = !!player.isYou;
      view.button.setAttribute('aria-label', player.isYou ? `${player.name}，你` : `${player.name}，查看牌区`);
      if (player.isYou) {
        view.button.removeAttribute('aria-haspopup'); view.button.removeAttribute('aria-controls');
      } else {
        view.button.setAttribute('aria-haspopup', 'dialog'); view.button.setAttribute('aria-controls', this.browserId);
      }
      view.you.hidden = !player.isYou; view.turn.hidden = !player.isActive && !player.eliminated;
      view.turn.textContent = player.eliminated ? '已淘汰' : '当前回合';
      if (player.isActive) view.root.setAttribute('aria-current', 'true'); else view.root.removeAttribute('aria-current');
      return view.root;
    }));
  }
  dispose(): void {
    for (const view of this.entries.values()) {view.avatar.dispose(); view.button.removeEventListener('click', view.open);}
    this.entries.clear();
  }
}
