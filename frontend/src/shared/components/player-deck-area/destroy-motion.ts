import type {PhysicalCard} from '../game-card/index.js';
import {playCardDissolve, type CardDissolvePlayback} from './card-dissolve.js';
import {playCardShards} from './card-shards.js';

/** Move the decoded card to center, then hand its image to the GPU dust renderer. */
export class DestroyMotion {
  private complete: (() => void) | null = null;
  constructor(private layer: HTMLElement, private cache: HTMLElement) {}
  play(card: PhysicalCard, from: DOMRect): Promise<void> {
    this.finish();
    return new Promise(resolve => {
      const wrapper = document.createElement('div'); wrapper.className = 'card-destruction';
      Object.assign(wrapper.style, {left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`});
      wrapper.style.setProperty('--card-radius', getComputedStyle(card.elements.surface).borderRadius);
      const button = card.elements.button, saved = {left: button.style.left, top: button.style.top, width: button.style.width, height: button.style.height, opacity: button.style.opacity};
      Object.assign(button.style, {left: '0px', top: '0px', width: '100%', height: '100%', opacity: '1'});
      card.setActive(false); card.setGlow(false); card.setFaceUp(true, false); card.setVisible(true);
      wrapper.append(button); this.layer.append(wrapper);
      const viewportWidth = window.innerWidth || from.width * 6, viewportHeight = window.innerHeight || from.height * 4;
      const width = Math.min(from.width * 1.7, viewportWidth * .65, viewportHeight * .65 * 504 / 704), height = width * 704 / 504;
      const left = (viewportWidth - width) / 2, top = (viewportHeight - height) / 2;
      const dx = left - from.left, dy = top - from.top;
      let lift: Animation | null = null, particles: CardDissolvePlayback | null = null, done = false;
      const complete = (): void => {
        if (done) return; done = true;
        if (lift) {lift.onfinish = lift.oncancel = null; lift.cancel();}
        particles?.cancel(); Object.assign(button.style, saved); card.setVisible(false); this.cache.append(button); wrapper.remove();
        if (this.complete === complete) this.complete = null; resolve();
      };
      this.complete = complete;
      try {
        lift = wrapper.animate([
          {transform: 'translate(0px, 0px) rotate(0deg)', width: `${from.width}px`, height: `${from.height}px`},
          {transform: `translate(${dx}px, ${dy - 6}px) rotate(-2deg)`, width: `${width}px`, height: `${height}px`, offset: .82},
          {transform: `translate(${dx}px, ${dy}px) rotate(0deg)`, width: `${width}px`, height: `${height}px`},
        ], {duration: 300, easing: 'cubic-bezier(.22,.7,.26,1)', fill: 'both'});
        lift.oncancel = complete;
        lift.onfinish = () => {
          if (done) return;
          // Commit final geometry before rasterizing: particle positions are local to this wrapper.
          lift!.onfinish = lift!.oncancel = null; lift!.cancel(); lift = null;
          Object.assign(wrapper.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`});
          const bounds = {x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({left, top, width, height})};
          particles = playCardDissolve(card, wrapper, bounds) ?? playCardShards(card, wrapper);
          void particles.finished.then(complete, complete);
        };
      } catch {complete();}
    });
  }
  finish(): void {this.complete?.();}
}
