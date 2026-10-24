/** Programmatic card presentation: rotate one surface without backface culling. */
export class FaceFlip {
  private faceUp: boolean;
  private targetFaceUp: boolean;
  private animation: Animation | null = null;
  private disposed = false;
  isAnimating = false;

  constructor(private surface: HTMLElement, private show: (faceUp: boolean) => void,
    private reducedMotion: () => boolean, faceUp = true) {
    this.faceUp = this.targetFaceUp = faceUp;
  }

  setFaceUp(faceUp: boolean, animate = true): void {
    if (this.disposed) return;
    this.targetFaceUp = faceUp;
    if (!animate) {this.settle(); return;}
    if (!this.isAnimating) this.start();
  }

  private start(): void {
    if (this.disposed || this.faceUp === this.targetFaceUp) return;
    if (this.reducedMotion() || typeof this.surface.animate !== 'function') {this.settle(); return;}
    this.isAnimating = true; this.show(this.faceUp);
    let closing: Animation;
    try {
      closing = this.surface.animate([
        {transform: 'perspective(1400px) rotateY(0deg)'},
        {transform: 'perspective(1400px) rotateY(-90deg)'},
      ], {duration: 100, easing: 'ease-in', fill: 'forwards'});
    } catch {this.settle(); return;}
    this.animation = closing;
    closing.oncancel = () => {if (this.animation === closing) this.settle();};
    closing.onfinish = () => {
      if (this.disposed || this.animation !== closing) return;
      const switched = this.faceUp !== this.targetFaceUp;
      this.faceUp = this.targetFaceUp; this.show(this.faceUp);
      this.open(switched ? 90 : -90, closing);
    };
  }

  private open(angle: number, closing: Animation): void {
    let opening: Animation;
    try {
      opening = this.surface.animate([
        {transform: `perspective(1400px) rotateY(${angle}deg)`},
        {transform: 'perspective(1400px) rotateY(0deg)'},
      ], {duration: 120, easing: 'ease-out', fill: 'both'});
    } catch {this.settle(); return;}
    this.animation = opening;
    closing.onfinish = closing.oncancel = null; closing.cancel();
    opening.oncancel = () => {if (this.animation === opening) this.settle();};
    opening.onfinish = () => {
      if (this.disposed || this.animation !== opening) return;
      this.animation = null; this.isAnimating = false;
      opening.onfinish = opening.oncancel = null; opening.cancel();
      // Returning to the underlying transform:none also releases the temporary
      // animation layer. No rotated/hidden backface is retained while idle.
      this.show(this.faceUp); this.start();
    };
  }

  /** Hidden tabs, cancellation and page disposal must never leave an edge-on card. */
  settle(): void {
    const animation = this.animation; this.animation = null; this.isAnimating = false;
    if (animation) {animation.onfinish = animation.oncancel = null; animation.cancel();}
    this.faceUp = this.targetFaceUp; this.show(this.faceUp);
  }

  dispose(): void {this.disposed = true; this.settle();}
}
