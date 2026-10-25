import {CardInteractions, createCardElements, createCardInspection, defaultCardImages, type PhysicalCard} from '../../shared/components/game-card/index.js';
import {CardMotion} from '../../shared/components/game-card/card-motion.js';
import {DestroyMotion} from '../../shared/components/player-deck-area/destroy-motion.js';
import type {CardFlightOrigin} from '../../shared/components/player-deck-area/index.js';
import {el} from './dom.js';
let sequence = 0;

/** Public cards already revealed by the engine; no hidden deck is inspected. */
export class PublicCardMotion {
  private readonly root = el('div', 'player-deck-overlays game-cursor');
  private readonly layer = el('div', 'card-motion-layer match-public-motion');
  private readonly cache = el('div');
  private readonly stage = el('div', 'public-card-spotlight');
  private readonly motion: CardMotion;
  private readonly destruction: DestroyMotion;
  private card: PhysicalCard | null = null;
  private revision = 0;
  private endPause: (() => void) | null = null;
  private endGeneration: (() => void) | null = null;
  private readonly inspection;
  private interactions: CardInteractions | null = null;
  constructor(host: HTMLElement) {
    const prefix = `public-motion-${++sequence}`;
    this.inspection = createCardInspection(host, {overlay: `${prefix}-inspect`, content: `${prefix}-inspect-content`});
    this.cache.hidden = true; this.stage.hidden = true;
    this.layer.append(this.stage, this.cache); this.root.append(this.layer); host.append(this.root);
    this.motion = new CardMotion(this.layer); this.destruction = new DestroyMotion(this.layer, this.cache);
  }
  private async prepare(cardId: string | null): Promise<PhysicalCard | null> {
    this.clear(); const revision = this.revision;
    const elements = createCardElements(cardId ?? 'hidden-motion', cardId ? defaultCardImages : {front: () => defaultCardImages.back, back: defaultCardImages.back}); elements.button.style.width = '100%'; elements.button.style.height = '100%';
    this.interactions = new CardInteractions(this.inspection.overlay, this.inspection.content); this.interactions.setSuspended(true);
    const card = this.interactions.add(elements, cardId ?? '未知卡牌'); this.card = card; this.cache.append(elements.button);
    await card.prepared; return revision === this.revision && this.card === card ? card : null;
  }
  private center(card: PhysicalCard): DOMRect {
    const width = Math.min(250, window.innerWidth * .45, window.innerHeight * .5 * 504 / 704), height = width * 704 / 504;
    Object.assign(this.stage.style, {left: `${(window.innerWidth - width) / 2}px`, top: `${(window.innerHeight - height) / 2}px`, width: `${width}px`, height: `${height}px`});
    this.stage.hidden = false; this.stage.append(card.elements.button); card.setVisible(true); return this.stage.getBoundingClientRect();
  }
  async present(cardId: string): Promise<DOMRect | null> {
    if (this.card?.elements.button.dataset.cardId === cardId) return this.center(this.card);
    const card = await this.prepare(cardId); return card ? this.center(card) : null;
  }
  async generate(cardId: string, origin?: CardFlightOrigin | null): Promise<DOMRect | null> {
    const card = await this.prepare(cardId); if (!card) return null;
    const centered = this.center(card), bounds = origin ?? centered;
    if (origin) Object.assign(this.stage.style, {left: `${origin.left}px`, top: `${origin.top}px`, width: `${origin.width}px`, height: `${origin.height}px`});
    this.stage.dataset.effect = 'disease';
    const cloud = el('div', 'disease-generation'); this.stage.append(cloud);
    await new Promise<void>(resolve => {
      const animations: Animation[] = [];
      const done = () => {
        for (const animation of animations) {animation.onfinish = animation.oncancel = null; animation.cancel();}
        cloud.remove(); delete this.stage.dataset.effect; if (this.endGeneration === done) this.endGeneration = null; resolve();
      };
      this.endGeneration = done;
      try {
        for (let index = 0; index < 18; index++) {
          const wisp = el('i', 'disease-wisp'); cloud.append(wisp);
          const angle = index * Math.PI * 2 / 18, x = Math.cos(angle) * bounds.width * .8, y = Math.sin(angle) * bounds.height * .65;
          animations.push(wisp.animate([{opacity: 0, transform: `translate(${x}px, ${y}px) scale(.2)`},
            {opacity: .8, offset: .4}, {opacity: 0, transform: 'translate(0px, 0px) scale(2.5)'}],
          {duration: 650, delay: index % 3 * 30, easing: 'ease-in', fill: 'both'}));
        }
        const reveal = this.stage.animate([{opacity: 0, filter: 'blur(14px)', transform: 'scale(.65)'},
          {opacity: .8, filter: 'blur(4px)', transform: 'scale(1.05)', offset: .65},
          {opacity: 1, filter: 'blur(0px)', transform: 'scale(1)'}], {duration: 760, easing: 'ease-out', fill: 'both'});
        animations.push(reveal); reveal.onfinish = reveal.oncancel = done;
      } catch {done();}
    });
    if (this.card !== card) return null;
    const to = this.center(card);
    if (origin) {
      await this.motion.play([{card, from: origin, to, destination: this.stage, reveal: false, departed: () => {}, landed: () => {}}], []);
      if (this.card !== card) return null;
      await new Promise<void>(resolve => {
        let animation: Animation | null = null;
        const done = () => {if (animation) {animation.onfinish = animation.oncancel = null; animation.cancel();} if (this.endPause === done) this.endPause = null; resolve();};
        this.endPause = done;
        try {animation = this.stage.animate([{opacity: 1}, {opacity: 1}], {duration: 350}); animation.onfinish = animation.oncancel = done;} catch {done();}
      });
    }
    return this.card === card ? to : null;
  }
  async reveal(cardId: string, from: CardFlightOrigin, faceDown = true): Promise<DOMRect | null> {
    const card = await this.prepare(cardId); if (!card) return null;
    const to = this.center(card);
    await this.motion.play([{card, from, to, destination: this.stage, reveal: faceDown, departed: () => {}, landed: () => {}}], []);
    if (this.card !== card) return null;
    await new Promise<void>(resolve => {
      let animation: Animation | null = null;
      const done = () => {if (animation) {animation.onfinish = animation.oncancel = null; animation.cancel();} if (this.endPause === done) this.endPause = null; resolve();};
      this.endPause = done;
      try {animation = this.stage.animate([{opacity: 1}, {opacity: 1}], {duration: 500}); animation.onfinish = animation.oncancel = done;} catch {done();}
    });
    return this.card === card ? to : null;
  }
  hide(): void {this.card?.setVisible(false);}
  hold(enabled: boolean): void {
    this.stage.style.pointerEvents = enabled ? 'auto' : 'none'; this.interactions?.setSuspended(!enabled); this.interactions?.refresh();
  }
  rect(): DOMRect | null {return this.card && !this.stage.hidden ? this.stage.getBoundingClientRect() : null;}
  async fly(cardId: string | null, from: CardFlightOrigin, to: CardFlightOrigin, fast = false): Promise<void> {
    const card = await this.prepare(cardId); if (!card) return;
    await this.motion.play([{card, from, to, destination: this.cache, reveal: false, departed: () => {}, landed: () => {}}], [], fast ? {duration: 100} : {}); this.clear();
  }
  async destroy(): Promise<void> {
    if (this.card) await this.destruction.play(this.card, this.stage.getBoundingClientRect()); this.clear();
  }
  /** A resolved trap fades out at its hall slot, without the destruction spotlight. */
  async dismiss(cardId: string, from: CardFlightOrigin): Promise<void> {
    const card = await this.prepare(cardId); if (!card) return;
    Object.assign(this.stage.style, {left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`});
    this.stage.dataset.effect = 'trap-dismiss';
    this.stage.hidden = false; this.stage.append(card.elements.button); card.setVisible(true);
    await new Promise<void>(resolve => {
      let animation: Animation | null = null;
      const done = () => {
        if (animation) {animation.onfinish = animation.oncancel = null; animation.cancel();}
        delete this.stage.dataset.effect; if (this.endGeneration === done) this.endGeneration = null; resolve();
      };
      this.endGeneration = done;
      try {
        animation = this.stage.animate([
          {opacity: 1, transform: 'translateY(0) scale(1)', filter: 'saturate(1) blur(0px)'},
          {opacity: .7, transform: 'translateY(4px) scale(.98)', filter: 'saturate(.3) blur(0px)', offset: .4},
          {opacity: 0, transform: 'translateY(20px) scale(.9)', filter: 'saturate(0) blur(3px)'},
        ], {duration: 420, easing: 'ease-in', fill: 'both'});
        animation.onfinish = animation.oncancel = done;
      } catch {done();}
    });
    if (this.card === card) this.clear();
  }
  clear(): void {this.interactions?.dispose(); this.interactions = null; this.card?.elements.button.remove(); this.card = null; this.stage.hidden = true;}
  settle(): void {this.revision++; this.hold(false); this.motion.finish(); this.destruction.finish(); this.endPause?.(); this.endGeneration?.(); if (this.card) this.center(this.card);}
  finish(): void {this.settle(); this.clear();}
  dispose(): void {this.finish(); this.inspection.dispose(); this.root.remove();}
}
