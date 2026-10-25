import type {CardAttachment, CardImageSource} from './types.js';
import {createCardElements} from './card-elements.js';
import {createCardInspection} from './inspection-view.js';
import {CardInteractions} from './card-interaction.js';
import {node} from '../../dom/elements.js';

const labels: Record<string, string> = {weapon: '武器', cage: '囚禁', emerald: '翡翠之龙', sapphire: '蓝宝石龙',
  disease_before: '附着疾病', disease_after: '附着疾病'};

/** A presentation-only attachment stack, shared by owned cards and hall monsters. */
export class CardAttachments {
  private static opened = new Set<CardAttachments>();
  static closeAll(): void {for (const stack of [...this.opened]) stack.close(false);}
  readonly marker = node('span', 'card-attachments');
  private cards: readonly CardAttachment[] = [];
  private images!: CardImageSource;
  private pick?: (id: string) => void;
  private modal: HTMLElement | null = null;
  private closeDialog: (() => void) | null = null;
  private suspended = false;
  private signature = '';
  constructor(private host: HTMLElement) {
    this.marker.hidden = true; this.marker.tabIndex = 0; this.marker.setAttribute('role', 'button');
    host.append(this.marker);
    this.marker.addEventListener('pointerdown', event => event.stopPropagation());
    this.marker.addEventListener('click', event => {event.stopPropagation(); event.preventDefault(); this.open();});
    this.marker.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {event.stopPropagation(); event.preventDefault(); this.open();}
    });
  }
  set(cards: readonly CardAttachment[], images: CardImageSource, pick?: (id: string) => void): void {
    this.pick = pick; this.images = images;
    const signature = JSON.stringify(cards);
    if (signature === this.signature) return;
    const wasOpen = this.modal !== null; this.close(false);
    this.signature = signature; this.cards = cards; this.marker.textContent = '';
    this.marker.hidden = !cards.length;
    this.marker.setAttribute('aria-label', `查看 ${cards.length} 张附着牌`);
    for (const [i, card] of cards.slice(-3).entries()) {
      const image = node('img'); image.src = images.front(card.cardId); image.alt = ''; image.draggable = false;
      image.style.setProperty('--attachment-index', String(i)); this.marker.append(image);
    }
    this.marker.append(node('span', 'card-attachment-count', String(cards.length)));
    if (wasOpen && cards.length) this.open();
  }
  setSuspended(value: boolean): void {this.suspended = value; if (value) this.close(false);}
  private open(): void {
    if (this.modal || this.suspended || !this.cards.length || this.host.dataset.face === 'back') return;
    const overlay = node('section', 'browse-dialog attachment-browser game-cursor');
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', '附着牌');
    const panel = node('div', 'browse-dialog-panel panel'), header = node('header', 'browse-dialog-heading masthead');
    const close = node('button', 'button secondary browse-dialog-close', '关闭 ×'); close.type = 'button';
    header.append(node('h2', '', '附着牌'), close);
    const grid = node('div', 'attachment-browser-grid browse-dialog-body'); panel.append(header, grid); overlay.append(panel);
    const inspection = createCardInspection();
    const interactions = new CardInteractions(inspection.overlay, inspection.content);
    for (const item of this.cards) {
      const entry = node('article'), elements = createCardElements(item.cardId, this.images);
      elements.button.dataset.instanceId = item.id;
      entry.append(node('span', 'attachment-kind', labels[item.kind] ?? '附着'), elements.button); grid.append(entry);
      interactions.add(elements, item.name);
      if (this.pick) elements.button.addEventListener('click', () => {this.close(false); this.pick?.(item.id);});
    }
    const backgrounds = [...document.body.children].filter(element => element !== inspection.overlay) as HTMLElement[];
    const before = backgrounds.map(element => element.inert);
    backgrounds.forEach(element => {element.inert = true;}); document.body.append(overlay);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault(); this.close();}
      if (event.key === 'Tab') {
        const targets = [close, ...grid.querySelectorAll<HTMLButtonElement>('button')];
        const index = targets.indexOf(document.activeElement as HTMLButtonElement);
        if (event.shiftKey && index <= 0) {event.preventDefault(); targets.at(-1)!.focus();}
        else if (!event.shiftKey && (index < 0 || index === targets.length - 1)) {event.preventDefault(); close.focus();}
      }
    };
    window.addEventListener('keydown', keydown);
    close.addEventListener('click', () => this.close());
    overlay.addEventListener('click', event => {if (event.target === overlay) this.close();});
    this.modal = overlay; CardAttachments.opened.add(this); close.focus({preventScroll: true});
    this.closeDialog = () => {
      interactions.dispose(); inspection.dispose(); overlay.remove(); window.removeEventListener('keydown', keydown);
      backgrounds.forEach((element, i) => {element.inert = before[i];});
    };
  }
  close(restoreFocus = true): void {
    if (!this.modal) return;
    this.closeDialog?.(); this.closeDialog = null; this.modal = null; CardAttachments.opened.delete(this);
    if (restoreFocus && this.host.isConnected && !this.host.hidden) this.marker.focus({preventScroll: true});
  }
  dispose(): void {this.close(false); this.marker.remove();}
}
