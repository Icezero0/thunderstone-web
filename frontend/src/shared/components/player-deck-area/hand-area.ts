import type {PhysicalCard} from '../game-card/index.js';
import {handInsertionIndex, layoutHand, type HandLayout} from './hand-layout.js';

interface HandReordering {
  canDrag(): boolean;
  started(): void;
  committed(cards: readonly PhysicalCard[]): void;
  finished(): void;
}
interface Drag {
  card: PhysicalCard;
  pointerId: number;
  startX: number;
  offset: number;
  layout: HandLayout;
  index: number;
  preview: PhysicalCard[];
  active: boolean;
}
const SNAP_MS = 160;

/** Hand layout and bounded pointer gestures; instance order belongs to the controller. */
export class HandArea {
  private cards: readonly PhysicalCard[] = [];
  private attachments: readonly {card: PhysicalCard; hero: PhysicalCard; index: number}[] = [];
  private observer: ResizeObserver | null = null;
  private lastWidth = -1;
  private readonly bindings = new Map<PhysicalCard, () => void>();
  private readonly placeholder = document.createElement('span');
  private drag: Drag | null = null;
  private settling: PhysicalCard | null = null;
  private timer: number | null = null;
  private suppressClick: HTMLButtonElement | null = null;

  constructor(readonly track: HTMLElement, private empty: HTMLElement, private geometryChanged: () => void,
    private reorder: HandReordering) {
    this.placeholder.className = 'hand-drop-slot'; this.placeholder.hidden = true;
    this.placeholder.setAttribute('aria-hidden', 'true'); track.append(this.placeholder);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        if (track.clientWidth !== this.lastWidth) this.resize();
      });
      this.observer.observe(track);
    }
    window.addEventListener('resize', this.resize);
    window.addEventListener('pointermove', this.pointermove, {passive: false});
    window.addEventListener('pointerup', this.pointerup);
    window.addEventListener('pointercancel', this.pointercancel);
    window.addEventListener('keydown', this.keydown);
  }

  setCards(cards: readonly PhysicalCard[], animate = false): void {
    this.finish();
    const changed = cards.length === this.cards.length && cards.some((card, index) => card !== this.cards[index]);
    this.cards = cards;
    for (const card of cards) {
      this.track.append(card.elements.button); card.setFaceUp(true, false); card.setVisible(true);
      if (!this.bindings.has(card)) this.bindCard(card);
    }
    this.empty.hidden = cards.length > 0;
    if (animate && changed && !this.reducedMotion()) {
      this.reorder.started(); this.track.dataset.reordering = 'true';
      // Establish the current positions before changing left, so CSS can interpolate.
      this.track.getBoundingClientRect();
      this.timer = window.setTimeout(() => this.complete(), SNAP_MS);
    }
    this.layout();
  }

  private resize = (): void => {this.geometryChanged(); this.layout();};
  setAttachments(attachments: readonly {card: PhysicalCard; hero: PhysicalCard; index: number}[]): void {
    const remaining = new Set(attachments.map(({card}) => card));
    // setCards can lay out the previous attachments once more. Restore departed
    // cards here, before measuring the new row (the weapon may be its first card).
    for (const {card} of this.attachments) if (!remaining.has(card)) {
      card.elements.button.style.width = ''; card.elements.button.style.top = '';
    }
    this.attachments = attachments;
    for (const {card} of attachments) {this.track.append(card.elements.button); card.setFaceUp(true, false); card.setVisible(true);}
    this.layout();
  }
  layout(order = this.cards): void {
    const width = this.track.clientWidth, size = this.cards[0]?.elements.button.offsetWidth ?? 0;
    this.lastWidth = width;
    const layout = layoutHand(this.cards.length, width, size);
    this.track.dataset.overlapping = String(layout.overlap > 0);
    order.forEach((card, index) => {
      if (this.drag?.active && card === this.drag.card) return;
      card.elements.button.style.left = `${layout.positions[index]}px`;
      card.elements.button.style.zIndex = String(card === this.settling ? this.cards.length + 2 : index + 1);
    });
    for (const {card, hero, index} of this.attachments) {
      const button = card.elements.button, anchor = hero.elements.button;
      button.style.left = `${parseFloat(anchor.style.left || '0') + size * .03 + index * 10}px`;
      button.style.top = `${size * 704 / 504 * .44 - index * 12}px`; button.style.width = `${size * .55}px`;
      button.style.zIndex = String(100 + Number(anchor.style.zIndex || 0) + index);
    }
  }

  private bindCard(card: PhysicalCard): void {
    const button = card.elements.button;
    const down = (event: PointerEvent): void => {
      this.suppressClick = null;
      if (this.drag || this.timer !== null || !this.reorder.canDrag() || event.button !== 0 ||
        !event.isPrimary || event.altKey || this.cards.length < 2 || !this.cards.includes(card)) return;
      const rect = button.getBoundingClientRect();
      this.drag = {card, pointerId: event.pointerId, startX: event.clientX, offset: event.clientX - rect.left,
        layout: layoutHand(this.cards.length, this.track.clientWidth, button.offsetWidth),
        index: this.cards.indexOf(card), preview: [...this.cards], active: false};
      // Capture keeps the gesture alive beyond the hand, while movement stays clamped inside it.
      try {button.setPointerCapture(event.pointerId);} catch {this.drag = null;}
    };
    const lost = (event: PointerEvent): void => {
      if (this.drag?.pointerId === event.pointerId) this.finish();
    };
    const nativeDrag = (event: Event): void => event.preventDefault();
    button.addEventListener('pointerdown', down);
    button.addEventListener('lostpointercapture', lost);
    button.addEventListener('dragstart', nativeDrag);
    this.bindings.set(card, () => {
      button.removeEventListener('pointerdown', down);
      button.removeEventListener('lostpointercapture', lost);
      button.removeEventListener('dragstart', nativeDrag);
    });
  }

  private pointermove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.abs(event.clientX - drag.startX) < 5) return;
      drag.active = true; this.suppressClick = drag.card.elements.button;
      this.reorder.started(); this.track.dataset.reordering = 'true';
      drag.card.elements.button.dataset.dragging = 'true';
      drag.card.elements.button.style.zIndex = String(this.cards.length + 2);
      this.placeholder.hidden = false;
      this.placeholder.style.width = `${drag.card.elements.button.offsetWidth}px`;
    }
    event.preventDefault();
    const button = drag.card.elements.button;
    const left = Math.max(0, Math.min(this.track.clientWidth - button.offsetWidth,
      event.clientX - this.track.getBoundingClientRect().left - drag.offset));
    button.style.left = `${left}px`;
    drag.index = handInsertionIndex(left, drag.layout, drag.index);
    drag.preview = this.cards.filter(card => card !== drag.card);
    drag.preview.splice(drag.index, 0, drag.card);
    this.placeholder.style.left = `${drag.layout.positions[drag.index]}px`;
    this.layout(drag.preview);
  };

  private pointerup = (event: PointerEvent): void => {
    if (this.drag?.pointerId !== event.pointerId) return;
    // The last pointerup position can differ from the last pointermove.
    this.pointermove(event);
    const drag = this.release();
    if (!drag?.active) return;
    drag.card.elements.button.getBoundingClientRect();
    this.cards = drag.preview; this.settling = drag.card;
    drag.card.elements.button.dataset.dropping = 'true';
    this.placeholder.hidden = true;
    this.reorder.committed(this.cards); this.layout();
    if (this.reducedMotion()) this.complete();
    else this.timer = window.setTimeout(() => this.complete(), SNAP_MS);
  };
  private pointercancel = (event: PointerEvent): void => {
    if (this.drag?.pointerId === event.pointerId) this.finish();
  };
  private keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.drag) {event.preventDefault(); this.finish();}
  };
  private release(): Drag | null {
    const drag = this.drag; this.drag = null;
    if (drag) {
      drag.card.elements.button.dataset.dragging = 'false';
      try {drag.card.elements.button.releasePointerCapture(drag.pointerId);} catch {/* Already released by the browser. */}
    }
    return drag;
  }
  private reducedMotion(): boolean {return window.matchMedia('(prefers-reduced-motion: reduce)').matches;}

  /** A pointer drag must not also toggle the card's selected state via its trailing click. */
  consumeClick(button: HTMLButtonElement, event: MouseEvent): boolean {
    if (event.detail === 0 || this.suppressClick !== button) return false;
    this.suppressClick = null; event.preventDefault(); return true;
  }
  private complete(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (this.settling) this.settling.elements.button.dataset.dropping = 'false';
    this.settling = null; this.track.dataset.reordering = 'false'; this.placeholder.hidden = true;
    // Keep DOM/tab order aligned with visual order, without dropping keyboard focus.
    const focused = document.activeElement;
    for (const card of this.cards) this.track.append(card.elements.button);
    if (focused instanceof HTMLElement && this.track.contains(focused) && document.activeElement !== focused) {
      focused.focus({preventScroll: true});
    }
    this.layout(); this.reorder.finished();
  }
  /** Interrupted gestures revert; a released (committed) reorder keeps its new order. */
  finish(): void {
    const drag = this.release();
    if (drag?.active || this.timer !== null || this.settling) this.complete();
  }

  resetCards(): void {
    this.finish(); this.bindings.forEach(unbind => unbind()); this.bindings.clear();
    this.cards = []; this.attachments = []; this.layout();
  }
  dispose(): void {
    this.finish(); this.observer?.disconnect(); window.removeEventListener('resize', this.resize);
    window.removeEventListener('pointermove', this.pointermove);
    window.removeEventListener('pointerup', this.pointerup);
    window.removeEventListener('pointercancel', this.pointercancel);
    window.removeEventListener('keydown', this.keydown);
    this.bindings.forEach(unbind => unbind()); this.bindings.clear(); this.cards = []; this.placeholder.remove();
  }
}
