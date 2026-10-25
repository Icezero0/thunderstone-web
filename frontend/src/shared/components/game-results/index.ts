import {node} from '../../dom/elements.js';
import {PlayerAvatar} from '../player-avatar/index.js';
import {resultRows, type GameResultPlayer} from './model.js';
import '../../styles/browse-dialog.css';
import '../../styles/game-cursor.css';
import './style.css';

export type {GameResultPlayer} from './model.js';

let sequence = 0;

/** Shared end-of-game presentation. Scores and winner decisions come from the rules engine. */
export class GameResultsDialog {
  private readonly overlay = node('section', 'game-results browse-dialog game-cursor');
  private readonly body = node('div', 'game-results-body browse-dialog-body');
  private readonly closeButton = node('button', 'button secondary browse-dialog-close', '关闭 ×');
  private readonly returnButton = node('button', 'button primary game-results-return', '返回房间');
  private readonly summary = node('p', 'game-results-summary');
  private avatars: PlayerAvatar[] = [];
  private inertBefore: boolean[] = [];
  private returnFocus: HTMLElement | null = null;

  constructor(host: HTMLElement, private background: HTMLElement[], private onReturn: () => void) {
    this.overlay.hidden = true; this.overlay.setAttribute('role', 'dialog'); this.overlay.setAttribute('aria-modal', 'true');
    const panel = node('div', 'browse-dialog-panel panel'), header = node('header', 'browse-dialog-heading');
    const title = node('h2', '', '冒险结束', `game-results-title-${++sequence}`);
    this.overlay.setAttribute('aria-labelledby', title.id); this.closeButton.type = 'button';
    const footer = node('footer', 'game-results-footer'); this.returnButton.type = 'button'; footer.append(this.returnButton);
    header.append(title, this.closeButton); panel.append(header, this.summary, this.body, footer);
    this.overlay.append(panel); host.append(this.overlay);
    this.closeButton.addEventListener('click', this.close);
    this.returnButton.addEventListener('click', this.returnToRoom);
    this.overlay.addEventListener('click', this.backdrop);
    document.addEventListener('keydown', this.keydown);
  }
  get isOpen(): boolean {return !this.overlay.hidden;}
  show(players: readonly GameResultPlayer[]): void {
    this.avatars.forEach(avatar => avatar.dispose()); this.avatars = []; this.body.replaceChildren();
    const winners = players.filter(player => player.winner).map(player => player.name);
    this.summary.textContent = winners.length ? `${winners.join('、')}获胜` : '冒险结束';
    const list = node('ol', 'game-results-chart'); list.setAttribute('aria-label', '最终得分，从高到低');
    for (const player of resultRows(players)) {
      const row = node('li', 'game-results-row'); row.dataset.playerId = player.id; row.dataset.winner = String(player.winner);
      const identity = node('div', 'game-results-identity'), portrait = node('span', 'game-results-portrait'), avatar = new PlayerAvatar();
      avatar.setSource(player.avatarUrl); portrait.append(avatar.root); this.avatars.push(avatar);
      if (player.winner) {
        const crown = node('span', 'game-results-crown'); crown.setAttribute('role', 'img'); crown.setAttribute('aria-label', '获胜者');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'currentColor'); svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M3 5l5 4 4-7 4 7 5-4-2 13H5L3 5zm2 15h14v2H5z'); svg.append(path); crown.append(svg); portrait.append(crown);
      }
      const name = node('div', 'game-results-name'); name.append(node('strong', '', player.name));
      const details = [player.eliminated ? '已淘汰' : '', player.thunderstones ? `雷霆之石 ×${player.thunderstones}` : ''].filter(Boolean);
      if (details.length) name.append(node('small', '', details.join(' · ')));
      identity.append(node('span', 'game-results-rank', String(player.rank).padStart(2, '0')), portrait, name);
      const metric = node('div', 'game-results-metric'), label = node('div', 'game-results-score');
      if (player.cardPoints !== undefined && player.experiencePoints !== undefined)
        label.append(node('span', '', `卡牌 ${player.cardPoints} + XP ${player.experiencePoints}`));
      label.append(node('strong', '', String(player.total)));
      const line = node('div', 'game-results-line'); line.setAttribute('aria-hidden', 'true');
      line.style.setProperty('--score-start', `${player.start}%`); line.style.setProperty('--score-length', `${player.length}%`);
      line.style.setProperty('--score-point', `${player.point}%`); line.style.setProperty('--score-zero', `${player.zero}%`);
      line.append(node('span', 'game-results-zero'), node('span', 'game-results-value'), node('span', 'game-results-point'));
      metric.append(label, line); row.append(identity, metric); list.append(row);
    }
    this.body.append(list);
    if (!this.isOpen) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.inertBefore = this.background.map(element => element.inert); this.background.forEach(element => {element.inert = true;});
      this.overlay.hidden = false; this.closeButton.focus({preventScroll: true});
    }
  }
  close = (): void => {
    if (!this.isOpen) return;
    this.overlay.hidden = true; this.background.forEach((element, index) => {element.inert = this.inertBefore[index];});
    if (this.returnFocus?.isConnected) this.returnFocus.focus({preventScroll: true}); this.returnFocus = null;
  };
  private backdrop = (event: MouseEvent): void => {if (event.target === this.overlay) this.close();};
  private returnToRoom = (): void => {this.close(); this.onReturn();};
  private keydown = (event: KeyboardEvent): void => {
    if (!this.isOpen || event.isComposing) return;
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); this.close();}
    else if (event.key === 'Tab') {
      event.preventDefault();
      const controls = [this.closeButton, this.returnButton], current = controls.indexOf(document.activeElement as HTMLButtonElement);
      const next = current < 0 ? event.shiftKey ? 1 : 0 : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[next].focus({preventScroll: true});
    }
  };
  dispose(): void {
    this.close(); document.removeEventListener('keydown', this.keydown);
    this.closeButton.removeEventListener('click', this.close); this.overlay.removeEventListener('click', this.backdrop);
    this.returnButton.removeEventListener('click', this.returnToRoom);
    this.avatars.forEach(avatar => avatar.dispose()); this.overlay.remove();
  }
}
