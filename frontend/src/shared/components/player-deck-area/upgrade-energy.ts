import {node} from '../../dom/elements.js';

type Animate = (element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) => Animation;

/** Bounded, short-lived decoration. Its owner controls every native animation and cleanup. */
export function createUpgradeEnergy(host: HTMLElement, width: number, animate: Animate): HTMLElement {
  const root = node('div', 'upgrade-energy'); root.setAttribute('aria-hidden', 'true'); host.append(root);
  const part = (className: string) => {const item = node('span', className); root.append(item); return item;};
  animate(part('upgrade-aura'), [
    {opacity: 0, transform: 'scale(.4)'}, {opacity: .8, transform: 'scale(.9)', offset: .35},
    {opacity: 1, transform: 'scale(1.1)', offset: .55}, {opacity: 0, transform: 'scale(1.35)'},
  ], {duration: 1000, fill: 'both'});
  for (let i = 0; i < 2; i++) {
    const ring = part(`upgrade-ring upgrade-ring-${i}`), direction = i ? -1 : 1;
    animate(ring, [
      {opacity: 0, transform: `rotate(${-direction * 50}deg) scale(.5)`},
      {opacity: .9, transform: 'rotate(0deg) scale(1)', offset: .3},
      {opacity: .85, transform: `rotate(${direction * 90}deg) scale(1.05)`, offset: .6},
      {opacity: 0, transform: `rotate(${direction * 150}deg) scale(1.4)`},
    ], {duration: 1000, fill: 'both', easing: 'ease-in-out'});
  }
  const tints = ['var(--header-gold)', 'var(--game-action-violet)', 'var(--game-action-blue)'];
  for (let i = 0; i < 36; i++) {
    const spark = part('upgrade-spark'), angle = i * 2.399963, radius = width * (1.1 + i % 5 * .11);
    spark.style.setProperty('--upgrade-tint', tints[i % tints.length]);
    const position = (distance: number, turn: number, scale: number) =>
      `translate(${Math.cos(angle + turn) * distance}px, ${Math.sin(angle + turn) * distance * .85}px) rotate(${(angle + turn) * 180 / Math.PI + 90}deg) scale(${scale})`;
    animate(spark, [{opacity: 0, transform: position(radius, 0, .3)},
      {opacity: 1, transform: position(radius * .8, .25, 1), offset: .22},
      {opacity: 1, transform: position(radius * .35, .9, .8), offset: .68},
      {opacity: 0, transform: position(0, 1.2, .2)}],
    {duration: 560, delay: i % 12 * 12, fill: 'both', easing: 'cubic-bezier(.45,0,.8,.5)'});
  }
  for (let i = 0; i < 18; i++) {
    const star = part('upgrade-star'), angle = i * 2.399963, radius = width * (.7 + i % 4 * .17);
    star.style.setProperty('--upgrade-tint', tints[i % tints.length]);
    animate(star, [{opacity: 0, transform: 'translate(0px, 0px) scale(.15)'},
      {opacity: 1, transform: `translate(${Math.cos(angle) * radius * .45}px, ${Math.sin(angle) * radius * .45}px) scale(1.3)`, offset: .3},
      {opacity: 0, transform: `translate(${Math.cos(angle) * radius}px, ${Math.sin(angle) * radius}px) scale(.1)`}],
    {duration: 360, delay: 540 + i % 6 * 13, fill: 'both', easing: 'ease-out'});
  }
  animate(part('upgrade-flare'), [{opacity: 0, transform: 'scale(.65)'},
    {opacity: 0, transform: 'scale(.8)', offset: .35}, {opacity: .95, transform: 'scale(1.06)', offset: .52},
    {opacity: .35, transform: 'scale(1.12)', offset: .65}, {opacity: 0, transform: 'scale(1.25)'}],
  {duration: 1000, fill: 'both'});
  animate(part('upgrade-beam'), [{opacity: 0, transform: 'scaleX(.1)'},
    {opacity: .85, transform: 'scaleX(1)', offset: .36}, {opacity: 0, transform: 'scaleX(1.5)'}],
  {duration: 500, delay: 350, fill: 'both', easing: 'ease-out'});
  return root;
}
