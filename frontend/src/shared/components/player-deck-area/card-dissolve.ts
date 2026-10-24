import {createParticleAnimation} from 'vanilla-disintegrate/particles';
import type {AnimationFactory, AnimationPlayback} from 'vanilla-disintegrate/core';
import type {PhysicalCard} from '../game-card/index.js';

/** Use only the renderer: images are already decoded, so no DOM capture or extra image request is needed. */
const dust = createParticleAnimation({
  duration: 760, stagger: 220, particleSize: 1.6, release: 'left', releaseRandomness: .35,
  curve: 'drift', horizontalTravel: [35, 135], horizontalDrift: 32, verticalTravel: [-105, -25],
  swirl: 18, waveTurns: 1.15, fadeStart: .42, endScale: .12, rotation: [-95, 110],
  renderQuality: {maxSourcePixels: 500_000, maxSourceDimension: 1024, maxRenderPixels: 2_000_000},
});

export interface CardDissolvePlayback {readonly finished: Promise<void>; cancel(): void;}

export function playCardDissolve(card: PhysicalCard, host: HTMLElement, bounds: DOMRectReadOnly,
  factory: AnimationFactory = dust): CardDissolvePlayback | null {
  let snapshot: HTMLCanvasElement | null = null, playback: AnimationPlayback | null = null;
  const cleanups: (() => void)[] = [];
  let settled = false, resolveFinished = () => {};
  const finished = new Promise<void>(resolve => {resolveFinished = resolve;});
  const complete = (): void => {
    if (settled) return; settled = true;
    for (const cleanup of [() => playback?.cancel?.(), () => playback?.dispose?.(), () => playback?.element?.remove(),
      ...cleanups.splice(0), () => {if (snapshot) {snapshot.width = 0; snapshot.height = 0;}}]) {
      try {cleanup();} catch { /* A renderer failure must not block the committed game result. */ }
    }
    resolveFinished();
  };
  try {
    snapshot = document.createElement('canvas');
    const scale = Math.min(2, window.devicePixelRatio || 1);
    snapshot.width = Math.max(1, Math.ceil(bounds.width * scale)); snapshot.height = Math.max(1, Math.ceil(bounds.height * scale));
    const ctx = snapshot.getContext('2d');
    if (!ctx) {complete(); return null;}
    ctx.scale(scale, scale);
    const radius = Number.parseFloat(getComputedStyle(card.elements.surface).borderRadius) || 9;
    ctx.beginPath(); ctx.roundRect(0, 0, bounds.width, bounds.height, Math.min(radius, bounds.width / 2, bounds.height / 2)); ctx.clip();
    const source = card.elements.frontImage, fit = Math.max(bounds.width / source.naturalWidth, bounds.height / source.naturalHeight);
    const width = source.naturalWidth * fit, height = source.naturalHeight * fit;
    ctx.drawImage(source, (bounds.width - width) / 2, (bounds.height - height) / 2, width, height);
    const controller = new AbortController(); cleanups.push(() => controller.abort());
    const result = factory({operation: 'remove', element: card.elements.button, layer: host, snapshot, visual: null,
      bounds, signal: controller.signal, reducedMotion: false, random: Math.random, addCleanup: callback => cleanups.push(callback)});
    if (!result || !('finished' in result)) {complete(); return null;}
    playback = result;
    if (playback.element && !playback.element.parentElement) host.append(playback.element);
    // Do not hide the physical card until the renderer has produced its intact first frame.
    card.elements.button.style.opacity = '0';
    void Promise.resolve(playback.finished).then(complete, complete);
    return {finished, cancel: complete};
  } catch {complete(); return null;}
}
