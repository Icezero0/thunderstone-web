import type {PhysicalCard} from '../game-card/index.js';
import {createUpgradeEnergy} from './upgrade-energy.js';

/** Two decoded instances share one stage; the old hero's catalog identity is never rewritten. */
export class UpgradeMotion {
  private complete: (() => void) | null = null;
  constructor(private layer: HTMLElement, private cache: HTMLElement) {}

  play(source: PhysicalCard, target: PhysicalCard, from: DOMRect, to: DOMRect): Promise<void> {
    this.finish();
    return new Promise(resolve => {
      const wrapper = document.createElement('div'); wrapper.className = 'card-upgrade';
      wrapper.inert = true; wrapper.setAttribute('aria-hidden', 'true');
      wrapper.dataset.stage = 'arrival';
      Object.assign(wrapper.style, {left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`});
      wrapper.style.setProperty('--card-radius', getComputedStyle(source.elements.surface).borderRadius);
      const saved = [source, target].map(card => ({card, style: {left: card.elements.button.style.left, top: card.elements.button.style.top,
        width: card.elements.button.style.width, height: card.elements.button.style.height, opacity: card.elements.button.style.opacity,
        filter: card.elements.button.style.filter, transform: card.elements.button.style.transform, zIndex: card.elements.button.style.zIndex}}));
      for (const [i, card] of [source, target].entries()) {
        Object.assign(card.elements.button.style, {left: '0px', top: '0px', width: '100%', height: '100%', opacity: i ? '0' : '1', zIndex: String(i)});
        card.setActive(false); card.setGlow(false); card.setFaceUp(true, false); card.setVisible(true);
        wrapper.append(card.elements.button);
      }
      this.layer.append(wrapper);
      const vw = window.innerWidth || from.width * 6, vh = window.innerHeight || from.height * 4;
      const width = Math.min(from.width * 1.8, vw * .48, vh * .58 * 504 / 704), height = width * 704 / 504;
      const left = (vw - width) / 2, top = (vh - height) / 2;
      let done = false, energy: HTMLElement | null = null; const animations: Animation[] = [];
      const cancelAnimations = (): void => {
        for (const animation of animations.splice(0)) {animation.onfinish = animation.oncancel = null; animation.cancel();}
      };
      const complete = (): void => {
        if (done) return; done = true; cancelAnimations();
        window.removeEventListener('resize', complete);
        for (const {card, style} of saved) {Object.assign(card.elements.button.style, style); card.setVisible(false); this.cache.append(card.elements.button);}
        wrapper.remove(); if (this.complete === complete) this.complete = null; resolve();
      };
      const animate = (element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions): Animation => {
        const animation = element.animate(frames, options); animations.push(animation); animation.oncancel = complete; return animation;
      };
      const depart = (): void => {
        if (done) return;
        target.elements.button.style.opacity = '1'; target.elements.button.style.filter = 'none'; target.elements.button.style.transform = 'none';
        source.elements.button.style.opacity = '0'; cancelAnimations();
        energy?.remove(); energy = null; wrapper.dataset.stage = 'departure';
        try {
          const dx = to.left - left, dy = to.top - top;
          const flight = animate(wrapper, [{transform: 'translate(0px, 0px)', width: `${width}px`, height: `${height}px`},
            {transform: `translate(${dx * .5}px, ${dy * .5 - 24}px)`, width: `${(width + to.width) / 2}px`, height: `${(height + to.height) / 2}px`, offset: .5},
            {transform: `translate(${dx}px, ${dy}px)`, width: `${to.width}px`, height: `${to.height}px`}],
          {duration: 300, fill: 'both', easing: 'cubic-bezier(.22,.61,.36,1)'});
          flight.onfinish = complete;
        } catch {complete();}
      };
      const evolve = (): void => {
        if (done) return;
        Object.assign(wrapper.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`});
        cancelAnimations(); wrapper.dataset.stage = 'evolution';
        try {
          energy = createUpgradeEnergy(wrapper, width, animate);
          animate(source.elements.button, [{opacity: 1, filter: 'brightness(1)'},
            {opacity: 1, filter: 'brightness(1.5)', offset: .4}, {opacity: 0, filter: 'brightness(2.8)', offset: .56},
            {opacity: 0, filter: 'brightness(1)'}], {duration: 1000, fill: 'both'});
          const reveal = animate(target.elements.button, [{opacity: 0, filter: 'brightness(3)', transform: 'scale(1.04)'},
            {opacity: 0, filter: 'brightness(3)', transform: 'scale(1.04)', offset: .51},
            {opacity: 1, filter: 'brightness(2)', transform: 'scale(1.02)', offset: .66},
            {opacity: 1, filter: 'brightness(1)', transform: 'scale(1)', offset: .83},
            {opacity: 1, filter: 'brightness(1)', transform: 'scale(1)'}], {duration: 1000, fill: 'both'});
          reveal.onfinish = depart;
        } catch {complete();}
      };
      this.complete = complete; window.addEventListener('resize', complete);
      try {
        const arrival = animate(wrapper, [{transform: 'translate(0px, 0px)', width: `${from.width}px`, height: `${from.height}px`},
          {transform: `translate(${left - from.left}px, ${top - from.top}px)`, width: `${width}px`, height: `${height}px`}],
        {duration: 320, fill: 'both', easing: 'cubic-bezier(.22,.7,.26,1)'});
        arrival.onfinish = evolve;
      } catch {complete();}
    });
  }
  finish(): void {this.complete?.();}
}
