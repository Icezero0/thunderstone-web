import type {PhysicalCard} from '../game-card/index.js';
import type {CardDissolvePlayback} from './card-dissolve.js';

/** WebGL-free fallback: irregular pieces keep the source illustration and separate along different paths. */
export function playCardShards(card: PhysicalCard, host: HTMLElement): CardDissolvePlayback {
  const field = document.createElement('div'); field.className = 'card-shard-field'; host.append(field);
  const columns = 5, rows = 7, animations: Animation[] = [];
  const vertices = Array.from({length: rows + 1}, (_, y) => Array.from({length: columns + 1}, (_, x) => [
    x === 0 || x === columns ? x * 100 / columns : (x + (Math.random() - .5) * .6) * 100 / columns,
    y === 0 || y === rows ? y * 100 / rows : (y + (Math.random() - .5) * .6) * 100 / rows,
  ]));
  let resolveFinished = () => {}, remaining = columns * rows, settled = false;
  const finished = new Promise<void>(resolve => {resolveFinished = resolve;});
  const complete = (): void => {
    if (settled) return; settled = true;
    for (const animation of animations) {animation.onfinish = animation.oncancel = null; animation.cancel();}
    field.remove(); resolveFinished();
  };
  try {
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const shard = document.createElement('span'); shard.className = 'card-shard';
      const points = [vertices[y][x], vertices[y][x + 1], vertices[y + 1][x + 1], vertices[y + 1][x]];
      shard.style.clipPath = `polygon(${points.map(point => `${point[0]}% ${point[1]}%`).join(',')})`;
      shard.style.backgroundImage = `url(${JSON.stringify(card.elements.frontImage.currentSrc || card.elements.frontImage.src)})`;
      shard.style.transformOrigin = `${(x + .5) * 100 / columns}% ${(y + .5) * 100 / rows}%`; field.append(shard);
      const dx = 35 + Math.random() * 105, dy = -20 - Math.random() * 110, rotation = (Math.random() - .5) * 135;
      const animation = shard.animate([
        {transform: 'translate(0px, 0px) rotate(0deg) scale(1)', opacity: 1},
        {transform: `translate(${dx * .25}px, ${dy * .25}px) rotate(${rotation * .3}deg) scale(.9)`, opacity: .95, offset: .4},
        {transform: `translate(${dx}px, ${dy}px) rotate(${rotation}deg) scale(.15)`, opacity: 0},
      ], {duration: 600 + Math.random() * 160, delay: (x + .5) / columns * 200 + Math.random() * 30,
        easing: 'cubic-bezier(.3,0,.7,1)', fill: 'both'});
      animations.push(animation);
      let ended = false;
      animation.onfinish = animation.oncancel = () => {if (!ended) {ended = true; if (--remaining === 0) complete();}};
    }
    card.elements.button.style.opacity = '0';
  } catch {complete();}
  return {finished, cancel: complete};
}
