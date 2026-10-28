import type {MatchView} from '../../shared/api/types.js';
import {$, el} from './dom.js';
import './history.css';

/** The timeline shows summaries; a separate explicit download exports the full snapshot. */
export class MatchHistoryPanel {
  private open = false;
  private latest: {view: MatchView; busy: boolean; downloading: boolean} | null = null;
  private outsidePointer = (event: PointerEvent): void => {
    if (this.open && !$('#history-panel').contains(event.target as Node | null)) this.setOpen(false, false);
  };
  constructor(private restore: (step?: number) => void, download: () => void, private opened: () => void = () => {}) {
    document.addEventListener('pointerdown', this.outsidePointer, true);
    $('#history-toggle').addEventListener('click', () => this.setOpen(!this.open));
    $('#history-panel').addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.open) {event.preventDefault(); event.stopPropagation(); this.setOpen(false);}
    });
    $('#history-undo').addEventListener('click', () => this.restore());
    $('#history-download').addEventListener('click', download);
    this.setOpen(false);
  }
  dispose(): void {document.removeEventListener('pointerdown', this.outsidePointer, true);}
  private setOpen(open: boolean, restoreFocus = true): void {
    this.open = open;
    const body = $('#history-body'), toggle = $('#history-toggle');
    if (!open && restoreFocus && body.contains(document.activeElement)) toggle.focus();
    $('#history-panel').dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '收起操作历史' : '展开操作历史');
    body.inert = !open; body.setAttribute('aria-hidden', String(!open));
    if (open) {
      this.opened();
      if (this.latest) this.render(this.latest.view, this.latest.busy, this.latest.downloading);
    }
  }
  render(view: MatchView, busy: boolean, downloading = false): void {
    this.latest = {view, busy, downloading};
    const history = view.history;
    if (view.status === 'cancelled') this.setOpen(false);
    $('#history-panel').hidden = view.status === 'cancelled';
    $<HTMLButtonElement>('#history-undo').disabled = busy || !history?.can_undo;
    const download = $<HTMLButtonElement>('#history-download');
    download.disabled = busy || downloading || view.status === 'cancelled';
    download.textContent = downloading ? '正在下载…' : '下载当前对局';
    if (!this.open) return;
    const list = $('#history-entries'); list.replaceChildren();
    const path = new Set<number>(), entries = new Map(history?.entries.map(row => [row.step, row]));
    let cursor = history?.cursor;
    while (cursor && !path.has(cursor)) {path.add(cursor); cursor = entries.get(cursor)?.parent_step;}
    for (const row of [...history?.entries ?? []].reverse()) {
      const current = row.step === history?.cursor;
      const item = el('li', `history-entry${current ? ' current' : ''}${path.has(row.step) ? '' : ' alternate'}`);
      const actor = view.players.find(player => player.user_id === row.user_id)?.display_name ?? '';
      const heading = el('div', 'history-entry-heading');
      heading.append(el('strong', '', row.label), el('small', '', current ? '当前' : `#${row.step}`));
      item.append(heading, el('p', '', [actor, row.turn_number ? `回合 ${row.turn_number}` : '游戏设置',
        new Date(row.created_at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})].filter(Boolean).join(' · ')));
      if (history?.can_jump && !current) {
        const jump = el('button', 'text-button', '恢复到此处'); jump.type = 'button'; jump.disabled = busy;
        jump.dataset.historyStep = String(row.step); jump.addEventListener('click', () => this.restore(row.step)); item.append(jump);
      }
      list.append(item);
    }
    if (!history?.entries.length) list.append(el('li', 'muted', view.sync && !view.sync.history_loaded ? '正在加载操作历史…' : '尚无可恢复的历史记录。'));
  }
}
