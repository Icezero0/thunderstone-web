import type {PhysicalCard} from '../game-card/index.js';

/** A few decoded card views represent the whole pile during the visual shuffle. */
export class ShuffleMotion {
  private complete: (() => void) | null = null;
  constructor(private layer: HTMLElement, private cache: HTMLElement) {}

  play(cards: PhysicalCard[], from: DOMRect, to: DOMRect): Promise<void> {
    return new Promise(resolve => {
      const packet = document.createElement('div'); packet.className = 'shuffle-packet';
      packet.style.left = `${from.left}px`; packet.style.top = `${from.top}px`;
      packet.style.width = `${from.width}px`; packet.style.height = `${from.height}px`;
      packet.style.setProperty('--card-radius', getComputedStyle(cards.at(-1)!.elements.surface).borderRadius);
      const animations: Animation[] = [], timers: number[] = [];
      const saved = cards.map(card => ({card, style: {left: card.elements.button.style.left,
        top: card.elements.button.style.top, width: card.elements.button.style.width,
        height: card.elements.button.style.height}}));
      let done = false;
      const complete = (): void => {
        if (done) return; done = true;
        timers.forEach(timer => window.clearTimeout(timer));
        for (const animation of animations) {
          animation.onfinish = animation.oncancel = null; animation.cancel();
        }
        for (const {card, style} of saved) {
          card.setFaceUp(false, false); card.setVisible(false);
          Object.assign(card.elements.button.style, style); this.cache.append(card.elements.button);
        }
        packet.remove();
        if (this.complete === complete) this.complete = null;
        resolve();
      };
      this.complete = complete;
      const sheets: HTMLElement[] = [];
      for (const [index, card] of cards.entries()) {
        const sheet = document.createElement('div'); sheet.className = 'shuffle-sheet';
        sheet.style.zIndex = String(index + 1);
        const button = card.elements.button;
        button.style.left = button.style.top = '0px'; button.style.width = button.style.height = '100%';
        card.setFaceUp(index === cards.length - 1, false); card.setVisible(true);
        sheet.append(button); packet.append(sheet); sheets.push(sheet);
      }
      this.layer.append(packet);
      timers.push(window.setTimeout(() => cards.at(-1)!.setFaceUp(false), 0));
      const dx = to.left - from.left, dy = to.top - from.top;
      const middle = `translate(${dx / 2}px, ${dy / 2 - Math.max(40, from.height * .3)}px)`;
      try {
        for (const [index, sheet] of sheets.entries()) {
          const sign = index % 2 ? 1 : -1, edge = (cards.length - index - 1) * 1.5;
          const rest = `translate(0px, ${edge}px) rotate(0deg)`;
          animations.push(sheet.animate([
            {transform: rest, offset: 0}, {transform: rest, offset: .24},
            {transform: `translate(${sign * from.width * .34}px, ${edge - 6}px) rotate(${sign * 4}deg)`, offset: .34},
            {transform: rest, offset: .45},
            {transform: `translate(${-sign * from.width * .3}px, ${edge - 5}px) rotate(${-sign * 3}deg)`, offset: .56},
            {transform: rest, offset: .68},
            {transform: `translate(${sign * from.width * .12}px, ${edge}px) rotate(${sign}deg)`, offset: .75},
            {transform: rest, offset: .82}, {transform: rest, offset: 1},
          ], {duration: 650, easing: 'ease-in-out', fill: 'both'}));
        }
        const movement = packet.animate([
          {transform: 'translate(0px, 0px)', offset: 0},
          {transform: middle, offset: .24}, {transform: middle, offset: .78},
          {transform: `translate(${dx}px, ${dy}px)`, offset: 1},
        ], {duration: 650, easing: 'ease-in-out', fill: 'both'});
        animations.push(movement); movement.onfinish = movement.oncancel = complete;
      } catch {complete();}
    });
  }

  finish(): void {this.complete?.();}
}
