import {node} from '../../shared/dom/elements.js';

type Rect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
export interface BattleImpact {
  target: Rect;
  origin: Rect | null;
  sources: readonly Rect[];
  attack: number;
  magic: number;
  total: number;
  health: number;
  won: boolean;
  shake: (frames: Keyframe[], options: KeyframeAnimationOptions) => Animation | null;
}
const center = (rect: Rect) => ({x: rect.left + rect.width / 2, y: rect.top + rect.height / 2});
const usable = (rect: Rect) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
interface BattleStrike {
  kind: 'slash' | 'magic'; origin: {x: number; y: number} | null; target: {x: number; y: number};
  size: number; scale: number; delay: number; travel: number;
}

// Independent, diminishing size growth for each damage type; cap to avoid covering the board.
const powerScale = (power: number): number => .65 + 1.15 * Math.sqrt(Math.min(40, Math.max(0, power)) / 40);

/** Decorative only. The caller supplies a committed outcome; no combat is simulated here. */
export class BattleMotion {
  private readonly layer = node('div', 'battle-motion game-cursor');
  private animations: Animation[] = [];
  private complete: (() => void) | null = null;
  constructor(host: HTMLElement) {
    this.layer.setAttribute('aria-hidden', 'true'); host.append(this.layer);
  }
  private enabled(): boolean {
    return !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && typeof this.layer.animate === 'function';
  }
  private animate(element: HTMLElement, frames: Keyframe[], duration: number, delay = 0): Animation {
    const animation = element.animate(frames, {duration, delay, easing: 'ease-out', fill: 'both'});
    this.animations.push(animation); return animation;
  }
  private at(className: string, rect: Rect): HTMLElement {
    const element = node('div', className);
    Object.assign(element.style, {left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`});
    this.layer.append(element); return element;
  }
  private focus(rect: Rect, duration = 300): Animation {
    const halo = this.at('battle-focus', rect);
    return this.animate(halo, [{opacity: 0, transform: 'scale(.97)'}, {opacity: .9, offset: .3},
      {opacity: 0, transform: 'scale(1.06)'}], duration);
  }
  private strike(plan: BattleStrike): void {
    const {kind, origin, target, size, scale, delay, travel} = plan;
    if (origin) {
      const dx = target.x - origin.x, dy = target.y - origin.y;
      const path = this.at(`battle-path battle-path-${kind}`, {
        left: origin.x, top: origin.y, width: Math.hypot(dx, dy), height: (kind === 'slash' ? 12 : 20) * scale,
      });
      path.style.transform = `translateY(-50%) rotate(${Math.atan2(dy, dx)}rad)`;
      const trail = node('div', `battle-trail battle-trail-${kind}`); path.append(trail);
      this.animate(trail, [
        {opacity: 0, transform: 'scaleX(.02) scaleY(.4)'},
        {opacity: 1, transform: 'scaleX(.06) scaleY(1)', offset: .12},
        {opacity: 1, transform: 'scaleX(1) scaleY(1)', offset: travel / (travel + 160)},
        {opacity: 0, transform: 'scaleX(1) scaleY(.15)'},
      ], travel + 160, delay);
    }
    const impact = this.at(`battle-hit battle-hit-${kind}`, {
      left: target.x - size / 2, top: target.y - size / 2, width: size, height: size,
    });
    this.animate(impact, [
      {opacity: 0, transform: 'scale(.55) rotate(-12deg)'},
      {opacity: 1, transform: 'scale(1.06) rotate(0deg)', offset: .12},
      {opacity: 1, transform: 'scale(1) rotate(0deg)', offset: .42},
      {opacity: 0, transform: 'scale(1.2) rotate(4deg)'},
    ], 460, delay + travel);
    const ring = this.at(`battle-ring battle-ring-${kind}`, {
      left: target.x - size * .32, top: target.y - size * .32, width: size * .64, height: size * .64,
    });
    this.animate(ring, [{opacity: 0, transform: 'scale(.3)'},
      {opacity: .85, transform: 'scale(.6)', offset: .12}, {opacity: 0, transform: 'scale(1.7)'}], 440, delay + travel);
  }
  /** Immediate acknowledgement, never a predicted attack or victory. */
  cue(target: Rect | null, sources: readonly Rect[]): void {
    this.finish(); if (!target || !usable(target) || !this.enabled()) return;
    try {
      for (const source of sources.filter(usable)) this.focus(source, 260);
      const animation = this.focus(target, 300);
      animation.onfinish = animation.oncancel = this.finish;
    } catch {this.finish();}
  }
  play(input: BattleImpact): Promise<void> {
    this.finish(); if (!usable(input.target) || !this.enabled()) return Promise.resolve();
    return new Promise(resolve => {
      this.complete = resolve;
      try {
        const target = center(input.target), sources = input.sources.filter(usable);
        for (const source of sources) this.focus(source, 360);
        this.focus(input.target, 720);
        const point = input.origin && usable(input.origin) ? center(input.origin) : null;
        const origin = point ? {x: Math.max(16, Math.min(window.innerWidth - 16, point.x)),
          y: Math.max(16, Math.min(window.innerHeight - 16, point.y))} : null;
        const size = Math.max(100, Math.min(230, input.target.width * 1.4));
        const strikes: BattleStrike[] = [];
        if (input.attack > 0) strikes.push({kind: 'slash', origin, target, size: size * powerScale(input.attack),
          scale: powerScale(input.attack), delay: 100, travel: 220});
        if (input.magic > 0) strikes.push({kind: 'magic', origin, target, size: size * 1.1 * powerScale(input.magic),
          scale: powerScale(input.magic), delay: input.attack > 0 ? 360 : 100, travel: 300});
        for (const strike of strikes) this.strike(strike);
        const hits = strikes.map(strike => strike.delay + strike.travel);
        const resultAt = Math.max(...hits, 460) + 320;
        for (const impactAt of hits) {
          const shake = input.shake([{transform: 'translate(0, 0) scale(1)', filter: 'brightness(1)'},
            {transform: 'translate(6px, -2px) scale(.97)', filter: 'brightness(1.65)', offset: .03},
            {transform: 'translate(6px, -2px) scale(.97)', filter: 'brightness(1.65)', offset: .2},
            {transform: 'translate(-4px, 1px) scale(1.01)', filter: 'brightness(1.1)', offset: .42},
            {transform: 'translate(2px, 0) scale(1)', offset: .7},
            {transform: 'translate(0, 0) scale(1)', filter: 'brightness(1)'}], {duration: 320, delay: impactAt, easing: 'ease-out'});
          if (shake) this.animations.push(shake);
        }
        const result = node('div', 'battle-result'); result.dataset.outcome = input.won ? 'win' : 'loss';
        result.append(node('strong', '', input.won ? '击败' : '未击败'), node('span', '', `攻击 ${input.total} / 生命 ${input.health}`));
        Object.assign(result.style, {left: `${Math.max(90, Math.min(window.innerWidth - 90, target.x))}px`,
          top: `${Math.max(45, Math.min(window.innerHeight - 70, target.y))}px`});
        this.layer.append(result);
        const final = this.animate(result, [{opacity: 0, transform: 'translate(-50%, -30%) scale(.88)'},
          {opacity: 1, transform: 'translate(-50%, -50%) scale(1.04)', offset: .08},
          {opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: .16},
          {opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: .88},
          {opacity: 0, transform: 'translate(-50%, -70%) scale(1)'}], 1800, resultAt);
        final.onfinish = final.oncancel = this.finish;
      } catch {this.finish();}
    });
  }
  finish = (): void => {
    for (const animation of this.animations.splice(0)) {animation.onfinish = animation.oncancel = null; animation.cancel();}
    this.layer.replaceChildren(); const complete = this.complete; this.complete = null; complete?.();
  };
  dispose(): void {this.finish(); this.layer.remove();}
}
