import {FaceFlip} from './face-flip.js';
import {CardStatusMarkers} from './card-status-markers.js';
import {CardAttachments} from './card-attachments.js';
import type {CardStatus, CardAttachment, CardImageSource} from './types.js';

export interface CardElements {
  button: HTMLButtonElement;
  surface: HTMLElement;
  front: HTMLElement;
  back: HTMLElement;
  frontImage: HTMLImageElement;
  backImage: HTMLImageElement;
  inspection: HTMLElement;
  largeFront: HTMLImageElement;
  largeBack: HTMLImageElement;
  statusPanel: HTMLElement;
}

/** Local card presentation, independent of the rules and authoritative state. */
export class PhysicalCard {
  private faceUp: boolean;
  private active = false;
  private disposed = false;
  private readonly flip: FaceFlip;
  private readonly images: HTMLImageElement[];
  private readonly statuses: CardStatusMarkers;
  private currentStatuses: readonly CardStatus[] = [];
  private attachments: CardAttachments | null = null;
  readonly prepared: Promise<void>;
  ready = false;
  failed = false;
  visible = true;

  constructor(readonly elements: CardElements, public name: string, faceUp: boolean,
    private readonly changed: () => void) {
    this.faceUp = faceUp;
    this.statuses = new CardStatusMarkers(elements.button, elements.surface.parentElement!);
    this.images = [elements.frontImage, elements.backImage, elements.largeFront, elements.largeBack];
    this.flip = new FaceFlip(elements.surface, value => {
      this.faceUp = value; this.render(); this.changed();
    }, () => window.matchMedia('(prefers-reduced-motion: reduce)').matches, faceUp);
    for (const image of this.images) image.addEventListener('error', this.imageError);
    this.render();
    this.prepared = this.prepareImages();
  }

  private async prepareImages(): Promise<void> {
    try {
      await Promise.all(this.images.map(image => image.decode()));
      if (this.disposed || this.failed) return;
      for (const image of [this.elements.largeFront, this.elements.largeBack]) {
        image.width = image.naturalWidth; image.height = image.naturalHeight;
      }
      this.ready = true; this.render(); this.changed();
    } catch {if (!this.disposed) this.imageError();}
  }

  private imageError = (): void => {
    this.failed = true; this.ready = false; this.flip.settle(); this.render(); this.changed();
  };

  /** The display controller chooses orientation; there is no player flip action. */
  setFaceUp(faceUp: boolean, animate = true): void {
    if (!this.disposed) this.flip.setFaceUp(faceUp, animate && this.ready);
  }
  setActive(active: boolean): void {this.active = active; this.render();}
  /** Effect target selection is independent of hover and battle participation. */
  setTargetSelected(selected: boolean): void {
    this.elements.button.dataset.targetSelected = String(selected);
  }
  /** Presentation hint shared by every card region; independent of hover and selection. */
  setGlow(glowing: boolean): void {if (!this.disposed) this.elements.button.dataset.glowing = String(glowing);}
  setStatuses(statuses: readonly CardStatus[] = []): void {
    if (this.disposed) return;
    this.statuses.set(statuses);
    if (JSON.stringify(statuses) === JSON.stringify(this.currentStatuses)) return;
    this.currentStatuses = statuses.map(status => ({...status}));
    const panel = this.elements.statusPanel; panel.textContent = '';
    for (const [kind, label] of [['buff', '增益'], ['debuff', '减益'], ['destroy', '摧毁标记']] as const) {
      const rows = this.currentStatuses.filter(status => status.kind === kind); if (!rows.length) continue;
      const group = document.createElement('section'); group.className = 'inspect-status-group'; group.dataset.kind = kind;
      const heading = document.createElement('h3'); heading.textContent = label; group.append(heading);
      for (const row of rows) {
        const item = document.createElement('div'); item.className = 'inspect-status-entry';
        const source = document.createElement('strong'); source.textContent = row.source_name;
        const description = document.createElement('span'); description.textContent = row.description; item.append(source, description); group.append(item);
      }
      panel.append(group);
    }
    this.inspect(!this.elements.inspection.hidden);
  }
  setAttachments(cards: readonly CardAttachment[], images: CardImageSource, pick?: (id: string) => void): void {
    if (!this.attachments && cards.length) this.attachments = new CardAttachments(this.elements.button);
    this.attachments?.set(cards, images, pick);
  }
  attachmentRect(): DOMRect | null {return this.attachments && !this.attachments.marker.hidden ? this.attachments.marker.getBoundingClientRect() : null;}
  setStatusSuspended(suspended: boolean): void {this.statuses.setSuspended(suspended); this.attachments?.setSuspended(suspended);}
  setName(name: string): void {if (name !== this.name) {this.name = name; this.render();}}
  setVisible(visible: boolean): void {
    this.visible = visible; this.elements.button.hidden = !visible;
    if (!visible) {this.attachments?.close(false); this.statuses.hide(); this.active = false; this.elements.inspection.hidden = true; this.flip.settle();}
    this.render();
  }
  settle(): void {this.statuses.hide(); this.flip.settle();}
  inspect(show: boolean): void {
    if (show) this.statuses.hide();
    this.elements.inspection.hidden = !show;
    this.elements.largeFront.hidden = !this.faceUp;
    this.elements.largeBack.hidden = this.faceUp;
    this.elements.statusPanel.hidden = !show || !this.faceUp || !this.currentStatuses.length;
    this.elements.statusPanel.style.height = `${this.elements.largeFront.height || 704}px`;
  }
  scrollStatuses(deltaY: number): boolean {
    const panel = this.elements.statusPanel;
    if (panel.hidden || !deltaY || panel.scrollHeight <= panel.clientHeight) return false;
    panel.scrollBy({top: deltaY}); return true;
  }
  get face(): string {return this.faceUp ? 'front' : 'back';}

  private render(): void {
    const {button, front, back} = this.elements;
    button.dataset.face = this.face;
    if (!this.faceUp) this.statuses.hide();
    button.dataset.active = String(this.active);
    button.dataset.flipping = String(this.flip.isAnimating);
    button.dataset.imagesReady = String(this.ready);
    button.setAttribute('aria-busy', String(!this.ready && !this.failed));
    button.setAttribute('aria-label', `${this.faceUp ? this.name + '，正面' : '背面'}朝上的卡牌；按住空格检视`);
    front.hidden = !this.faceUp; back.hidden = this.faceUp;
    front.setAttribute('aria-hidden', String(!this.faceUp));
    back.setAttribute('aria-hidden', String(this.faceUp));
  }
  dispose(): void {
    this.disposed = true; this.attachments?.dispose(); this.statuses.dispose(); this.flip.dispose();
    for (const image of this.images) image.removeEventListener('error', this.imageError);
  }
}

/** Game-wide card interactions: any region can register cards with one Space inspection owner. */
export class CardInteractions {
  private static hoverOwner: CardInteractions | null = null;
  private static focusOwner: CardInteractions | null = null;
  private static pointerFocus = true;
  private readonly cards: PhysicalCard[] = [];
  private readonly unbind = new Map<PhysicalCard, () => void>();
  private hovered: PhysicalCard | null = null;
  private focused: PhysicalCard | null = null;
  private active: PhysicalCard | null = null;
  private inspectionHeld = false;
  // Consume this press's repeats/release even if its inspected card disappears.
  private inspectionCaptured = false;
  private inspected: PhysicalCard | null = null;
  private inspectedFace = '';
  private suspended = false;
  private scope: HTMLElement | null = null;

  constructor(private overlay: HTMLElement, private content: HTMLElement, private notice?: HTMLElement) {
    window.addEventListener('keydown', this.keydown, true);
    window.addEventListener('keyup', this.keyup, true);
    window.addEventListener('pointerdown', this.pointerdown, true);
    window.addEventListener('blur', this.reset);
    window.addEventListener('pagehide', this.reset);
    window.addEventListener('wheel', this.scrollInspection, {passive: false, capture: true});
    document.addEventListener('visibilitychange', this.visibility);
  }

  add(elements: CardElements, name: string, faceUp = true): PhysicalCard {
    this.content.append(elements.inspection);
    const card = new PhysicalCard(elements, name, faceUp, () => this.render());
    card.setStatusSuspended(this.suspended);
    this.cards.push(card);
    const enter = (event: PointerEvent): void => {
      if (this.suspended || !this.allowed(card) || event.pointerType === 'touch') return;
      const held = this.inspectionHeld && !event.altKey && !event.ctrlKey && !event.metaKey && !this.editing(document.activeElement);
      if (this.hovered === card && this.inspectionHeld === held && CardInteractions.hoverOwner === this) return;
      const previous = CardInteractions.hoverOwner ?? CardInteractions.focusOwner;
      this.hovered = card; this.inspectionHeld = held; CardInteractions.hoverOwner = this;
      if (this.inspectionHeld) this.inspectionCaptured = true;
      if (previous && previous !== this) previous.render();
      this.render();
    };
    const leave = (): void => {
      if (this.hovered === card) {
        this.hovered = null;
        if (CardInteractions.hoverOwner === this) CardInteractions.hoverOwner = null;
      }
      this.render();
      if (!CardInteractions.hoverOwner && CardInteractions.focusOwner !== this) CardInteractions.focusOwner?.render();
    };
    const focus = (): void => {
      if (this.suspended || !this.allowed(card)) return;
      const previous = CardInteractions.hoverOwner ?? CardInteractions.focusOwner;
      this.focused = elements.button.matches(':focus-visible') ? card : null;
      if (this.focused) CardInteractions.focusOwner = this;
      else if (CardInteractions.focusOwner === this) CardInteractions.focusOwner = null;
      if (previous && previous !== this) previous.render();
      this.render();
    };
    const blur = (): void => {
      if (this.focused === card) {
        this.focused = null;
        if (CardInteractions.focusOwner === this) CardInteractions.focusOwner = null;
      }
      this.render();
    };
    elements.button.addEventListener('pointerenter', enter);
    // A captured drag can end over this same card without another pointerenter.
    elements.button.addEventListener('pointermove', enter);
    elements.button.addEventListener('pointerleave', leave);
    elements.button.addEventListener('focus', focus);
    elements.button.addEventListener('blur', blur);
    this.unbind.set(card, () => {
      elements.button.removeEventListener('pointerenter', enter);
      elements.button.removeEventListener('pointermove', enter);
      elements.button.removeEventListener('pointerleave', leave);
      elements.button.removeEventListener('focus', focus);
      elements.button.removeEventListener('blur', blur);
    });
    return card;
  }

  refresh(): void {this.render();}
  /** Release an obsolete/revoked card view, including its inspection image and listeners. */
  remove(card: PhysicalCard): void {
    const index = this.cards.indexOf(card); if (index < 0) return;
    card.setVisible(false); this.unbind.get(card)?.(); this.unbind.delete(card);
    this.cards.splice(index, 1); card.dispose(); card.elements.button.remove(); card.elements.inspection.remove(); this.render();
  }
  setScope(scope: HTMLElement | null): void {this.scope = scope; this.resetState(true);}
  private allowed(card: PhysicalCard): boolean {
    if (!card.visible || !card.elements.button.isConnected || (this.scope && !this.scope.contains(card.elements.button))) return false;
    for (let node: HTMLElement | null = card.elements.button; node; node = node.parentElement) {
      if (node.hidden || node.inert) return false;
    }
    return true;
  }
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    for (const card of this.cards) card.setStatusSuspended(suspended);
    if (suspended) this.resetState(true); else this.render();
  }
  private editing(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const field = target.closest('input, textarea, select');
    if (!field) return false;
    // Checkboxes and native buttons are controls, not text editors. Hovered-card
    // inspection must not toggle a checkbox left focused by a previous click.
    return field.tagName.toLowerCase() !== 'input' ||
      !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((field.getAttribute('type') ?? 'text').toLowerCase());
  }
  private control(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const control = target.closest('button, a[href], summary, [role="button"], [role="switch"], [role="tab"]');
    return !!control && !control.classList.contains('physical-card');
  }
  private inGameArea(target: HTMLElement): boolean {
    // Includes pile-browser controls, tabs and focusable panning desktops,
    // even when they are not registered as physical cards with this owner.
    for (let node: HTMLElement | null = target; node; node = node.parentElement)
      if (node.classList.contains('game-cursor')) return true;
    return false;
  }
  private isInspectionKey(event: KeyboardEvent): boolean {
    return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
  }
  private pointerdown = (): void => {CardInteractions.pointerFocus = true;};
  private consume(event: KeyboardEvent): void {event.preventDefault(); event.stopPropagation();}
  private keydown = (event: KeyboardEvent): void => {
    if (!this.isInspectionKey(event)) {
      if (['Tab', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
        CardInteractions.pointerFocus = false;
      // Modifier shortcuts and Escape belong to their normal handlers.
      if (event.altKey || event.ctrlKey || event.metaKey || event.key === 'Escape') {this.inspectionHeld = false; this.render();}
      return;
    }
    if (!event.repeat) this.inspectionCaptured = false;
    const hoverOwner = CardInteractions.hoverOwner;
    const hovering = hoverOwner?.hovered && !hoverOwner.suspended && hoverOwner.allowed(hoverOwner.hovered);
    const focused = document.activeElement;
    const staleFocus = CardInteractions.pointerFocus && focused instanceof HTMLElement
      && (this.inGameArea(focused) || this.cards.some(card => card.elements.button === focused && this.allowed(card)));
    if (event.isComposing || this.editing(event.target) || this.editing(document.activeElement)
        || (this.control(event.target) && !hovering && !staleFocus) || event.altKey || event.ctrlKey || event.metaKey) {
      if (this.inspectionCaptured) this.consume(event);
      this.inspectionHeld = false; this.render(); return;
    }
    // Keyboard input can make a mouse-focused control match :focus-visible even
    // when its default action is prevented. Release that stale focus before the
    // browser paints it; never blur text editors or genuine keyboard navigation.
    if (CardInteractions.pointerFocus && focused instanceof HTMLElement
        && focused !== document.body && (hovering || staleFocus)) focused.blur();
    // Once claimed, swallow repeats and keyup too: Space must not activate the
    // game control last clicked after the pointer has left it.
    if (staleFocus) {this.inspectionCaptured = true; this.consume(event);}
    this.render();
    this.inspectionHeld = true;
    if (this.active || this.inspectionCaptured) {this.inspectionCaptured = true; this.consume(event);}
    this.render();
  };
  private keyup = (event: KeyboardEvent): void => {
    if (!this.isInspectionKey(event)) return;
    if (this.inspectionCaptured) this.consume(event);
    this.inspectionHeld = this.inspectionCaptured = false; this.render();
  };
  private reset = (): void => {this.resetState();};
  private resetState(keepHeld = false): void {
    // Reset presentation on blur/suspension, but retain ownership of this Space release.
    // A new keydown clears it if a window switch prevented keyup from reaching us.
    if (!keepHeld) this.inspectionHeld = false;
    this.hovered = this.focused = null;
    if (CardInteractions.hoverOwner === this) CardInteractions.hoverOwner = null;
    if (CardInteractions.focusOwner === this) CardInteractions.focusOwner = null;
    for (const card of this.cards) card.settle();
    this.render();
    const owner = CardInteractions.hoverOwner ?? CardInteractions.focusOwner;
    if (owner && owner !== this) owner.render();
  }
  private visibility = (): void => {if (document.hidden) this.reset();};
  private scrollInspection = (event: WheelEvent): void => {
    if (this.overlay.hidden) return;
    // Capture before a public viewport can interpret the same wheel as zoom.
    event.preventDefault(); event.stopPropagation();
    if (this.inspected?.scrollStatuses(event.deltaY)) return;
    if (this.overlay.scrollHeight > this.overlay.clientHeight || this.overlay.scrollWidth > this.overlay.clientWidth) {
      this.overlay.scrollBy({top: event.deltaY, left: event.deltaX});
    }
  };
  private render(): void {
    if (this.hovered && !this.allowed(this.hovered)) {
      this.hovered = null; if (CardInteractions.hoverOwner === this) CardInteractions.hoverOwner = null;
    }
    if (this.focused && !this.allowed(this.focused)) {
      this.focused = null; if (CardInteractions.focusOwner === this) CardInteractions.focusOwner = null;
    }
    const owner = CardInteractions.hoverOwner ?? CardInteractions.focusOwner;
    const active = this.suspended || owner !== this ? null : CardInteractions.hoverOwner === this ? this.hovered : this.focused;
    if (this.active !== active) {this.active?.setActive(false); this.active = active;}
    active?.setActive(true);
    const inspection = active?.ready && this.inspectionHeld ? active : null;
    this.overlay.hidden = !inspection;
    if (this.inspected !== inspection || this.inspectedFace !== inspection?.face) {
      this.inspected?.inspect(false);
      this.overlay.scrollTop = this.overlay.scrollLeft = 0;
    }
    this.inspected = inspection;
    this.inspectedFace = inspection?.face ?? '';
    if (inspection) {inspection.inspect(true); this.content.dataset.face = inspection.face;}
    if (this.notice) this.notice.textContent = this.cards.some(card => card.visible && card.failed)
      ? '部分卡图暂未载入，请稍后重试。' : '';
  }

  dispose(): void {
    this.reset();
    for (const card of this.cards) {
      this.unbind.get(card)?.(); card.dispose(); card.elements.button.remove(); card.elements.inspection.remove();
    }
    this.unbind.clear(); this.cards.length = 0;
    window.removeEventListener('keydown', this.keydown, true);
    window.removeEventListener('keyup', this.keyup, true);
    window.removeEventListener('pointerdown', this.pointerdown, true);
    window.removeEventListener('blur', this.reset);
    window.removeEventListener('pagehide', this.reset);
    window.removeEventListener('wheel', this.scrollInspection, true);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
