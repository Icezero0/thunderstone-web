import type {GameCommand, MatchCard, MatchView} from '../../shared/api/types.js';
import {allocation, cardImageUrl, matchHeading, phaseLabel, type SetupSelection} from './model.js';
import {$, el} from './dom.js';
import {MatchTable} from './table.js';
import {renderMatchStatus} from './status-view.js';

export class MatchPage {
  private readonly table: MatchTable;
  constructor(private inspect: (id: string) => void, private select: (kind: 'groupA' | 'featureA', id: string, checked: boolean) => void,
    send: (command: GameCommand) => void, onAutoSortChange?: (enabled: boolean) => void) {
    this.table = new MatchTable(send, onAutoSortChange);
  }
  setAutoSort(enabled: boolean): void {this.table.setAutoSort(enabled);}
  setCommandError(message = ''): void {this.table.setError(message);}
  controls(view: MatchView, busy: boolean): void {renderMatchStatus(view); this.table.controls(view, busy);}
  setSelected(ids: readonly string[]): void {this.table.setSelected(ids);}
  finish(): void {this.table.finish();}
  closeBrowsers(): void {this.table.closeBrowsers();}
  dispose(): void {this.table.dispose();}

  tile(view: MatchView, id: string, caption = '', className = ''): HTMLElement {
    const card = view.cards[id], tile = el('button', `card-tile ${className}`);
    tile.type = 'button'; tile.setAttribute('aria-label', `${card?.name ?? id}${caption ? `，${caption}` : ''}，查看详情`);
    const picture = el('span', 'card-picture'), src = card && cardImageUrl(card.image_url);
    picture.append(el('span', 'card-fallback', card?.name ?? id));
    if (src) {
      const img = el('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('error', () => img.remove(), {once: true}); picture.append(img);
    }
    tile.append(picture, el('strong', 'card-name', card?.name ?? id));
    if (caption) tile.append(el('span', 'card-caption', caption));
    tile.addEventListener('click', () => this.inspect(id)); return tile;
  }

  render(view: MatchView, selection: SetupSelection, busy: boolean): void {
    const ownPlayer = view.players.find(player => player.is_you);
    if (ownPlayer) $('#account-name').textContent = ownPlayer.display_name;
    $('#empty-view').hidden = true; $('#match-content').hidden = false;
    if (view.status === 'cancelled') {
      $('#match-content').hidden = true; $('#empty-view').hidden = false; $('#turn-marker').hidden = true;
      $('#empty-title').textContent = '本局已取消'; $('#empty-description').textContent = '房主已结束这次开局。返回房间后可以重新配置和准备。';
      $('#match-title').textContent = '等待下一场冒险'; $('#match-subtitle').textContent = '本局已取消，伙伴们可以返回房间重新准备。';
      $('#page-state').textContent = '本局已取消。'; return;
    }
    const heading = matchHeading(view);
    $('#match-title').textContent = heading.title; $('#match-subtitle').textContent = heading.detail;
    $('#turn-marker').hidden = false; $('#phase-label').textContent = phaseLabel(view.turn?.subphase);
    $('#match-id').textContent = `对局 ${view.id.slice(0, 8)}`;
    $('#page-state').textContent = view.status === 'setup_pending' ? '分配确认后将生成初始牌组与地下城大厅。' : '鼠标悬停卡牌时，按住 E 检视大图。';
    $('#setup-panel').hidden = view.status !== 'setup_pending'; $('#active-table').hidden = !['active', 'finished'].includes(view.status);
    if (view.status === 'setup_pending') {this.table.finish(); this.table.closeBrowsers(); this.renderSetup(view, selection, busy);}
    else this.table.receive(view);
  }

  renderSetup(view: MatchView, selection: SetupSelection, busy: boolean): void {
    const choice = view.setup_choice, summary = allocation(view, selection);
    $('#setup-description').textContent = `选择 ${choice?.group_a_count ?? 2} 组怪物放入地下城 A，其余进入地下城 B。点击卡图可查看内容。`;
    const active = document.activeElement instanceof HTMLInputElement ? document.activeElement.dataset.choice : null;
    const renderOptions = (target: HTMLElement, ids: string[], kind: 'groupA' | 'featureA') => {
      target.replaceChildren();
      for (const id of ids) {
        const selected = selection[kind].includes(id), box = el('article', `allocation-option${selected ? ' selected' : ''}`);
        box.append(this.tile(view, id));
        const label = el('label', 'allocation-toggle'), input = el('input'); input.type = 'checkbox'; input.checked = selected;
        input.dataset.choice = `${kind}:${id}`;
        input.disabled = busy || !view.can_resolve_setup || (kind === 'groupA' && !selected && summary.groupA.length >= (choice?.group_a_count ?? 2));
        input.addEventListener('change', () => this.select(kind, id, input.checked));
        label.append(input, el('span', '', selected ? '地下城 A' : '地下城 B'));
        box.append(label); target.append(box);
        if (active === input.dataset.choice) queueMicrotask(() => input.focus());
      }
    };
    renderOptions($('#setup-monsters'), choice?.group_ids ?? [], 'groupA');
    renderOptions($('#setup-features'), choice?.feature_ids ?? [], 'featureA');
    $('#setup-features-section').hidden = !choice?.feature_ids.length;
    $('#allocation-progress').textContent = `地下城 A · 已选 ${summary.groupA.length} / ${choice?.group_a_count ?? 2} 组`;
    const overview = $('#allocation-summary'); overview.replaceChildren();
    for (const [title, groups, features] of [['地下城 A', summary.groupA, summary.featureA], ['地下城 B', summary.groupB, summary.featureB]] as const) {
      const column = el('div'); column.append(el('h3', '', title));
      column.append(el('p', '', groups.map(id => view.cards[id]?.name ?? id).join('、') || '尚未分配怪物'));
      if (features.length) column.append(el('small', 'muted', features.map(id => view.cards[id]?.name ?? id).join('、')));
      overview.append(column);
    }
    const confirm = $<HTMLButtonElement>('#confirm-setup'); confirm.hidden = !view.can_resolve_setup;
    confirm.disabled = busy || !summary.valid; confirm.textContent = busy ? '正在生成牌桌…' : '确认分配，进入牌桌';
    $('#setup-hint').textContent = view.can_resolve_setup ? (summary.valid ? '分配完成后，两座地下城会分别洗牌并补齐大厅。' : '先为地下城 A 选齐怪物组。') : '等待房主确认分配；完成后本页会自动更新。';
  }

  detail(card: MatchCard): void {
    const detail = $('#card-detail'), picture = el('div', 'detail-picture'), src = cardImageUrl(card.image_url);
    if (src) {const image = el('img'); image.src = src; image.alt = card.name; picture.append(image);}
    const body = el('div', 'detail-body'), name = el('h2', '', card.name); name.id = 'card-detail-name';
    body.append(el('p', 'eyebrow', card.card_id), name, el('p', 'muted', [card.card_type, card.subcategory].filter(Boolean).join(' · ')));
    const stats = el('dl', 'detail-stats');
    for (const [label, value] of Object.entries(card.stats)) {
      if (value === '') continue;
      const pair = el('div'); pair.append(el('dt', '', label), el('dd', '', value)); stats.append(pair);
    }
    if (stats.childElementCount) body.append(stats);
    const effects = el('div', 'detail-effects');
    if (card.effects) for (const line of card.effects.split(/\r?\n/).filter(Boolean)) effects.append(el('p', '', line));
    else effects.append(el('p', 'muted', '无额外效果描述。'));
    body.append(effects); detail.replaceChildren(picture, body);
    const dialog = $<HTMLDialogElement>('#card-dialog'); if (!dialog.open) dialog.showModal();
  }
}
