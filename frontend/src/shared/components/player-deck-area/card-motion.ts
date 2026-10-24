import type {PhysicalCard} from '../game-card/index.js';

export interface Flight {
  card: PhysicalCard;
  from: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
  to: DOMRect;
  destination: HTMLElement;
  reveal: boolean;
  departed: () => void;
  landed: () => void;
}
export interface Reflow {element: HTMLElement; from: DOMRect; to: DOMRect;}

/** Move existing decoded card elements; temporary wrappers own the transforms. */
export class CardMotion {
  private completions: (() => void)[] = [];
  constructor(private layer: HTMLElement) {}

  async play(flights: Flight[], reflows: Reflow[]): Promise<void> {
    const completions: (() => void)[] = [];
    this.completions = completions;
    const pending: Promise<void>[] = [];
    for (const reflow of reflows) {
      const dx = reflow.from.left - reflow.to.left, dy = reflow.from.top - reflow.to.top;
      if (!dx && !dy) continue;
      pending.push(new Promise(resolve => {
        let animation: Animation | null = null, done = false;
        const complete = (): void => {
          if (done) return; done = true;
          if (animation) {animation.onfinish = animation.oncancel = null; animation.cancel();}
          resolve();
        };
        completions.push(complete);
        try {
          animation = reflow.element.animate([
            {transform: `translate(${dx}px, ${dy}px)`}, {transform: 'translate(0px, 0px)'},
          ], {duration: 250, easing: 'ease-out', fill: 'both'});
          animation.onfinish = animation.oncancel = complete;
        } catch {complete();}
      }));
    }
    for (const [index, flight] of flights.entries()) {
      pending.push(new Promise(resolve => {
        const {card, from, to} = flight, button = card.elements.button;
        const wrapper = document.createElement('div'); wrapper.className = 'card-flight';
        wrapper.style.left = `${from.left}px`; wrapper.style.top = `${from.top}px`;
        wrapper.style.width = `${from.width}px`; wrapper.style.height = `${from.height}px`;
        wrapper.style.zIndex = String(flights.length - index);
        wrapper.style.setProperty('--card-radius', getComputedStyle(card.elements.surface).borderRadius);
        const saved = {left: button.style.left, top: button.style.top, width: button.style.width, height: button.style.height};
        button.style.left = button.style.top = '0px'; button.style.width = button.style.height = '100%';
        card.setFaceUp(!flight.reveal, false); card.setVisible(true);
        wrapper.append(button); this.layer.append(wrapper);
        let animation: Animation | null = null, done = false, departed = false;
        const timers: number[] = [];
        const depart = (): void => {if (!departed) {departed = true; flight.departed();}};
        const complete = (): void => {
          if (done) return; done = true;
          timers.forEach(timer => window.clearTimeout(timer)); depart();
          if (animation) {animation.onfinish = animation.oncancel = null; animation.cancel();}
          card.setFaceUp(true, false);
          Object.assign(button.style, saved); flight.destination.append(button); wrapper.remove();
          flight.landed(); resolve();
        };
        completions.push(complete);
        const delay = index * 60;
        if (!delay) depart(); else timers.push(window.setTimeout(depart, delay));
        if (flight.reveal) timers.push(window.setTimeout(() => card.setFaceUp(true), delay + 25));
        const dx = to.left - from.left, dy = to.top - from.top;
        const lift = Math.min(38, Math.max(15, Math.abs(dx) * .06));
        try {
          animation = wrapper.animate([
            {transform: 'translate(0px, 0px)', width: `${from.width}px`, height: `${from.height}px`},
            {transform: `translate(${dx / 2}px, ${dy / 2 - lift}px)`,
              width: `${(from.width + to.width) / 2}px`, height: `${(from.height + to.height) / 2}px`, offset: .5},
            {transform: `translate(${dx}px, ${dy}px)`, width: `${to.width}px`, height: `${to.height}px`},
          ], {duration: 250, delay, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both'});
          animation.onfinish = animation.oncancel = complete;
        } catch {complete();}
      }));
    }
    await Promise.all(pending);
    if (this.completions === completions) this.completions = [];
  }

  /** Interruptions finish in card order, preserving the intended discard top. */
  finish(): void {
    const completions = this.completions; this.completions = [];
    completions.forEach(complete => complete());
  }
}
