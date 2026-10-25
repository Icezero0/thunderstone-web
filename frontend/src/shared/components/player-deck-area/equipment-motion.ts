/** FLIP keeps decoded hand cards in their final DOM slots while they move and resize. */
export class EquipmentMotion {
  private animations = new Map<HTMLElement, Animation>();
  play(before: Map<HTMLElement, DOMRect>): void {
    this.finish();
    if (document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const [element, from] of before) {
      const to = element.getBoundingClientRect();
      if (!from.width || !to.width || !from.height || !to.height || typeof element.animate !== 'function') continue;
      const dx = from.left - to.left, dy = from.top - to.top, sx = from.width / to.width, sy = from.height / to.height;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(sx - 1) + Math.abs(sy - 1) < .01) continue;
      element.dataset.equipmentMoving = 'true';
      try {
        const animation = element.animate([
          {transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`},
          {transformOrigin: '0 0', transform: 'translate(0px, 0px) scale(1, 1)'},
        ], {duration: 220, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both'});
        this.animations.set(element, animation);
        animation.onfinish = animation.oncancel = () => {
          if (this.animations.get(element) !== animation) return;
          this.animations.delete(element); delete element.dataset.equipmentMoving;
          animation.onfinish = animation.oncancel = null; animation.cancel();
        };
      } catch {delete element.dataset.equipmentMoving;}
    }
  }
  finish(): void {
    for (const [element, animation] of this.animations) {
      animation.onfinish = animation.oncancel = null; animation.cancel(); delete element.dataset.equipmentMoving;
    }
    this.animations.clear();
  }
}
