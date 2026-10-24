import {FaceFlip} from './face-flip.js';

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
}

/** Local card presentation, independent of the rules and authoritative state. */
export class PhysicalCard {
  private faceUp: boolean;
  private active = false;
  private disposed = false;
  private readonly flip: FaceFlip;
  private readonly images: HTMLImageElement[];
  readonly prepared: Promise<void>;
  ready = false;
  failed = false;
  visible = true;

  constructor(readonly elements: CardElements, public name: string, faceUp: boolean,
    private readonly changed: () => void) {
    this.faceUp = faceUp;
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
  /** Presentation hint shared by every card region; independent of hover and selection. */
  setGlow(glowing: boolean): void {if (!this.disposed) this.elements.button.dataset.glowing = String(glowing);}
  setName(name: string): void {if (name !== this.name) {this.name = name; this.render();}}
  setVisible(visible: boolean): void {
    this.visible = visible; this.elements.button.hidden = !visible;
    if (!visible) {this.active = false; this.elements.inspection.hidden = true; this.flip.settle();}
    this.render();
  }
  settle(): void {this.flip.settle();}
  inspect(show: boolean): void {
    this.elements.inspection.hidden = !show;
    this.elements.largeFront.hidden = !this.faceUp;
    this.elements.largeBack.hidden = this.faceUp;
  }
  get face(): string {return this.faceUp ? 'front' : 'back';}

  private render(): void {
    const {button, front, back} = this.elements;
    button.dataset.face = this.face;
    button.dataset.active = String(this.active);
    button.dataset.flipping = String(this.flip.isAnimating);
    button.dataset.imagesReady = String(this.ready);
    button.setAttribute('aria-busy', String(!this.ready && !this.failed));
    button.setAttribute('aria-label', `${this.faceUp ? this.name + '，正面' : '背面'}朝上的卡牌；按住 Alt 检视`);
    front.hidden = !this.faceUp; back.hidden = this.faceUp;
    front.setAttribute('aria-hidden', String(!this.faceUp));
    back.setAttribute('aria-hidden', String(this.faceUp));
  }
  dispose(): void {
    this.disposed = true; this.flip.dispose();
    for (const image of this.images) image.removeEventListener('error', this.imageError);
  }
}

/** Game-wide card interactions: any region can register cards with a single Alt inspection owner. */
export class CardInteractions {
  private static hoverOwner: CardInteractions | null = null;
  private static focusOwner: CardInteractions | null = null;
  private readonly cards: PhysicalCard[] = [];
  private readonly unbind = new Map<PhysicalCard, () => void>();
  private hovered: PhysicalCard | null = null;
  private focused: PhysicalCard | null = null;
  private active: PhysicalCard | null = null;
  private altHeld = false;
  private inspected: PhysicalCard | null = null;
  private inspectedFace = '';
  private suspended = false;
  private scope: HTMLElement | null = null;

  constructor(private overlay: HTMLElement, private content: HTMLElement, private notice?: HTMLElement) {
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
    window.addEventListener('blur', this.reset);
    window.addEventListener('pagehide', this.reset);
    window.addEventListener('wheel', this.scrollInspection, {passive: false});
    document.addEventListener('visibilitychange', this.visibility);
  }

  add(elements: CardElements, name: string, faceUp = true): PhysicalCard {
    this.content.append(elements.inspection);
    const card = new PhysicalCard(elements, name, faceUp, () => this.render());
    this.cards.push(card);
    const enter = (event: PointerEvent): void => {
      if (this.suspended || !this.allowed(card) || event.pointerType === 'touch') return;
      if (this.hovered === card && this.altHeld === event.altKey && CardInteractions.hoverOwner === this) return;
      const previous = CardInteractions.hoverOwner ?? CardInteractions.focusOwner;
      this.hovered = card; this.altHeld = event.altKey; CardInteractions.hoverOwner = this;
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
  setScope(scope: HTMLElement | null): void {this.scope = scope; this.reset();}
  private allowed(card: PhysicalCard): boolean {
    if (!card.visible || !card.elements.button.isConnected || (this.scope && !this.scope.contains(card.elements.button))) return false;
    for (let node: HTMLElement | null = card.elements.button; node; node = node.parentElement) {
      if (node.hidden || node.inert) return false;
    }
    return true;
  }
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (suspended) this.reset(); else this.render();
  }
  private keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || (event.target instanceof HTMLElement &&
      (event.target.isContentEditable || event.target.closest('input, textarea, select')))) return;
    if (event.key !== 'Alt' || event.ctrlKey || event.metaKey) return;
    this.altHeld = true;
    if (this.active) event.preventDefault();
    this.render();
  };
  private keyup = (event: KeyboardEvent): void => {
    if (event.key !== 'Alt') return;
    if (this.active) event.preventDefault();
    this.altHeld = false; this.render();
  };
  private reset = (): void => {
    this.altHeld = false; this.hovered = this.focused = null;
    if (CardInteractions.hoverOwner === this) CardInteractions.hoverOwner = null;
    if (CardInteractions.focusOwner === this) CardInteractions.focusOwner = null;
    for (const card of this.cards) card.settle();
    this.render();
    const owner = CardInteractions.hoverOwner ?? CardInteractions.focusOwner;
    if (owner && owner !== this) owner.render();
  };
  private visibility = (): void => {if (document.hidden) this.reset();};
  private scrollInspection = (event: WheelEvent): void => {
    if (this.overlay.hidden) return;
    if (this.overlay.scrollHeight > this.overlay.clientHeight || this.overlay.scrollWidth > this.overlay.clientWidth) {
      event.preventDefault(); this.overlay.scrollBy({top: event.deltaY, left: event.deltaX});
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
    const inspection = active?.ready && this.altHeld ? active : null;
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
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    window.removeEventListener('blur', this.reset);
    window.removeEventListener('pagehide', this.reset);
    window.removeEventListener('wheel', this.scrollInspection);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
