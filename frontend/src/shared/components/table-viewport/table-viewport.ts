export interface ViewPosition {readonly x: number; readonly y: number;}
export interface TableViewportOptions {
  /** Center each axis when its content fits; overflowing axes start at the leading edge. */
  centerContent?: boolean;
  /** Extra room beyond the content edges for manual framing, in CSS pixels. */
  panPadding?: number;
  /** Omit to disable wheel zoom. Limits must include initial (defaults to 1). */
  zoom?: {min: number; max: number; initial?: number};
  onPanningChange?: (panning: boolean) => void;
  onViewChange?: (position: ViewPosition) => void;
  onZoomChange?: (zoom: number) => void;
}
interface Gesture {pointerId: number; buttons: number; startX: number; startY: number; x: number; y: number; started: boolean;}
const interactive = 'button, a, input, select, textarea, summary, [contenteditable], [role="button"], [data-no-pan]';

/** A clipped window onto a full-size desktop. Camera coordinates never alter gameplay state. */
export class TableViewport {
  private x = 0;
  private y = 0;
  private minX = 0;
  private minY = 0;
  private maxX = 0;
  private maxY = 0;
  private homeX = 0;
  private homeY = 0;
  private scale = 1;
  private readonly initialScale: number;
  private gesture: Gesture | null = null;
  private suppressClick = false;
  private disposed = false;
  private readonly observer: ResizeObserver | null;
  get position(): ViewPosition {return {x: this.x, y: this.y};}
  get isPanning(): boolean {return !!this.gesture?.started;}
  get zoom(): number {return this.scale;}
  capture(): {x: number; y: number; zoom: number} {return {x: this.x, y: this.y, zoom: this.scale};}
  /** Presentation-only camera changes may run while gameplay input is inert. */
  restore(camera: {x: number; y: number; zoom: number}): void {
    if (this.disposed) return;
    this.finish(); this.scale = camera.zoom; this.measure(); this.apply(camera.x, camera.y);
  }
  frame(rect: {left: number; top: number; width: number; height: number}): void {
    const bounds = this.viewport.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || rect.width <= 0 || rect.height <= 0) return;
    if (rect.left >= bounds.left && rect.top >= bounds.top && rect.left + rect.width <= bounds.right && rect.top + rect.height <= bounds.bottom) return;
    this.measure(); this.apply(this.x + bounds.left + (bounds.width - rect.width) / 2 - rect.left,
      this.y + bounds.top + (bounds.height - rect.height) / 2 - rect.top);
  }

  constructor(readonly viewport: HTMLElement, readonly desktop: HTMLElement, private options: TableViewportOptions = {}) {
    this.initialScale = options.zoom?.initial ?? 1;
    if (options.zoom && (![options.zoom.min, options.zoom.max, this.initialScale].every(Number.isFinite)
        || options.zoom.min <= 0 || options.zoom.min > this.initialScale || options.zoom.max < this.initialScale)) {
      throw new Error('Zoom limits must be finite, positive, and include the initial scale.');
    }
    this.scale = this.initialScale;
    viewport.dataset.panning = 'false'; viewport.tabIndex = 0;
    viewport.addEventListener('pointerdown', this.down, true);
    viewport.addEventListener('lostpointercapture', this.lostCapture);
    viewport.addEventListener('click', this.click, true);
    viewport.addEventListener('keydown', this.keydown);
    viewport.addEventListener('focusin', this.focusin);
    viewport.addEventListener('wheel', this.wheel, {passive: false});
    window.addEventListener('pointermove', this.move, {passive: false});
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.up);
    window.addEventListener('blur', this.finish);
    window.addEventListener('pagehide', this.finish);
    window.addEventListener('resize', this.refresh);
    document.addEventListener('visibilitychange', this.visibility);
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.refresh);
    this.observer?.observe(viewport); this.observer?.observe(desktop); this.refresh();
  }
  private blocked(): boolean {
    for (let node: HTMLElement | null = this.viewport; node; node = node.parentElement) if (node.hidden || node.inert) return true;
    return this.disposed;
  }
  private measure(): void {
    const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
    const contentWidth = this.desktop.scrollWidth * this.scale, contentHeight = this.desktop.scrollHeight * this.scale;
    const gapX = width - contentWidth, gapY = height - contentHeight;
    const padding = Math.max(0, this.options.panPadding ?? 0);
    // Leave some of the desktop reachable, even at the furthest framing limit.
    const paddingX = Math.min(padding, Math.max(0, Math.min(width, contentWidth) - 64));
    const paddingY = Math.min(padding, Math.max(0, Math.min(height, contentHeight) - 64));
    const homeX = this.options.centerContent ? Math.max(0, gapX / 2) : 0;
    const homeY = this.options.centerContent ? Math.max(0, gapY / 2) : 0;
    // Keep the user's adjustment relative to the default framing on resize or content changes.
    this.x += homeX - this.homeX; this.y += homeY - this.homeY;
    this.homeX = homeX; this.homeY = homeY;
    this.minX = Math.min(0, gapX) - paddingX; this.minY = Math.min(0, gapY) - paddingY;
    this.maxX = (this.options.centerContent ? Math.max(0, gapX) : 0) + paddingX;
    this.maxY = (this.options.centerContent ? Math.max(0, gapY) : 0) + paddingY;
  }
  private apply(x: number, y: number): void {
    this.x = Math.round(Math.max(this.minX, Math.min(this.maxX, x)));
    this.y = Math.round(Math.max(this.minY, Math.min(this.maxY, y)));
    // At 100%, keep only integer translation so the default card artwork stays sharp.
    this.desktop.style.transform = `translate(${this.x}px, ${this.y}px)${this.scale === 1 ? '' : ` scale(${this.scale})`}`;
    this.options.onViewChange?.(this.position);
  }
  refresh = (): void => {
    if (this.disposed) return;
    this.finish();
    // Hidden tabs have no measurable desktop. Preserve their camera until shown again.
    // Inert blocks input, not layout: authoritative animations still need the
    // final camera bounds before measuring flight destinations and reflows.
    if (this.viewport.clientWidth <= 0 || this.viewport.clientHeight <= 0) return;
    this.measure(); this.apply(this.x, this.y);
  };
  panTo(x: number, y: number): void {
    if (this.disposed) throw new Error('TableViewport has been disposed.');
    if (this.blocked()) return;
    this.finish(); this.measure(); this.apply(x, y);
  }
  /** Restore the current content's initial framing and configured initial scale. */
  reset(): void {
    if (this.disposed) throw new Error('TableViewport has been disposed.');
    if (this.blocked()) return;
    this.finish(); const changed = this.scale !== this.initialScale; this.scale = this.initialScale;
    this.measure(); this.apply(this.homeX, this.homeY);
    if (changed) this.options.onZoomChange?.(this.scale);
  }
  /** Zoom around viewport-local screen coordinates; defaults to the viewport center. */
  setZoom(zoom: number, anchorX = this.viewport.clientWidth / 2, anchorY = this.viewport.clientHeight / 2): void {
    if (this.disposed) throw new Error('TableViewport has been disposed.');
    if (!this.options.zoom || this.blocked() || !Number.isFinite(zoom) || !Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return;
    const next = Math.max(this.options.zoom.min, Math.min(this.options.zoom.max, zoom));
    if (next === this.scale) return;
    this.finish(); this.measure(); this.apply(this.x, this.y);
    const worldX = (anchorX - this.x) / this.scale, worldY = (anchorY - this.y) / this.scale;
    this.scale = next; this.measure();
    this.apply(anchorX - worldX * next, anchorY - worldY * next);
    this.options.onZoomChange?.(this.scale);
  }
  private wheel = (event: WheelEvent): void => {
    if (!this.options.zoom || this.blocked() || event.altKey || event.ctrlKey || event.metaKey || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable], [data-no-zoom]')) return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1);
    const factor = Math.exp(-Math.max(-200, Math.min(200, pixels)) * .0015);
    const rect = this.viewport.getBoundingClientRect();
    this.setZoom(this.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
  };
  focusArea(element: HTMLElement, margin = 24): void {
    if (!this.desktop.contains(element)) throw new Error('Area must belong to the desktop.');
    if (this.blocked()) return;
    this.finish(); this.measure(); this.apply(this.x, this.y);
    const view = this.viewport.getBoundingClientRect(), area = element.getBoundingClientRect();
    this.panTo(this.x + view.left + margin - area.left, this.y + view.top + margin - area.top);
  }
  private down = (event: PointerEvent): void => {
    // A new press is a new interaction, even when it belongs to a card instead of the camera.
    if (!this.gesture) this.suppressClick = false;
    if (this.blocked() || this.gesture || !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey || ![0, 1].includes(event.button)) return;
    if (event.button === 0 && event.target instanceof HTMLElement) {
      const control = event.target.closest(interactive);
      if (event.target.closest('[data-no-pan]') || control && control.getAttribute('data-pan-start') === null) return;
    }
    this.measure(); this.apply(this.x, this.y);
    this.gesture = {pointerId: event.pointerId, buttons: event.button === 1 ? 4 : 1,
      startX: event.clientX, startY: event.clientY, x: this.x, y: this.y, started: false};
    // Preserve the original click target until this press becomes a real drag.
    if (event.button === 1) event.preventDefault(); // Disable browser middle-button autoscroll.
  };
  private move = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (this.blocked() || !(event.buttons & gesture.buttons)) {this.finish(); return;}
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
    if (!gesture.started && Math.hypot(dx, dy) < 5) return;
    event.preventDefault();
    if (!gesture.started) {
      this.viewport.setPointerCapture(gesture.pointerId);
      gesture.started = true; this.viewport.dataset.panning = 'true'; this.suppressClick = true;
      this.options.onPanningChange?.(true); this.viewport.focus({preventScroll: true});
    }
    this.apply(gesture.x + dx, gesture.y + dy);
  };
  private up = (event: PointerEvent): void => {if (event.pointerId === this.gesture?.pointerId) this.finish();};
  private lostCapture = (event: PointerEvent): void => {
    // A child may lose implicit capture when the viewport takes over its drag.
    if (event.target === this.viewport && event.pointerId === this.gesture?.pointerId) this.finish();
  };
  finish = (): void => {
    const gesture = this.gesture; if (!gesture) return;
    this.gesture = null; this.viewport.dataset.panning = 'false';
    // Capture may already have been released by cancellation, focus loss or the browser.
    try {this.viewport.releasePointerCapture(gesture.pointerId);} catch { /* Pointer is no longer active. */ }
    if (gesture.started) this.options.onPanningChange?.(false);
  };
  private click = (event: MouseEvent): void => {
    if (this.suppressClick && event.detail !== 0) {this.suppressClick = false; event.preventDefault(); event.stopPropagation();}
  };
  private keydown = (event: KeyboardEvent): void => {
    if (this.blocked() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape' && this.gesture) {event.preventDefault(); this.finish(); return;}
    if (event.target !== this.viewport) return;
    const step = event.shiftKey ? 100 : 40;
    const delta: Record<string, [number, number]> = {ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step]};
    if (event.key === 'Home') {event.preventDefault(); this.reset();}
    else if (delta[event.key]) {event.preventDefault(); const [x, y] = delta[event.key]; this.panTo(this.x + x, this.y + y);}
  };
  private focusin = (event: FocusEvent): void => {
    if (this.gesture || this.blocked() || !(event.target instanceof HTMLElement) || event.target === this.viewport || !event.target.matches(':focus-visible')) return;
    // Keyboard navigation must reach cards that currently lie outside the clipped view.
    this.measure(); this.apply(this.x, this.y);
    const view = this.viewport.getBoundingClientRect(), card = event.target.getBoundingClientRect();
    const dx = card.left < view.left + 18 ? view.left + 18 - card.left : card.right > view.right - 18 ? view.right - 18 - card.right : 0;
    const dy = card.top < view.top + 18 ? view.top + 18 - card.top : card.bottom > view.bottom - 18 ? view.bottom - 18 - card.bottom : 0;
    if (dx || dy) this.apply(this.x + dx, this.y + dy);
  };
  private visibility = (): void => {if (document.hidden) this.finish();};
  dispose(): void {
    if (this.disposed) return;
    this.finish(); this.disposed = true; this.observer?.disconnect();
    this.viewport.removeEventListener('pointerdown', this.down, true);
    this.viewport.removeEventListener('lostpointercapture', this.lostCapture);
    this.viewport.removeEventListener('click', this.click, true);
    this.viewport.removeEventListener('keydown', this.keydown);
    this.viewport.removeEventListener('focusin', this.focusin);
    this.viewport.removeEventListener('wheel', this.wheel);
    window.removeEventListener('pointermove', this.move); window.removeEventListener('pointerup', this.up);
    window.removeEventListener('pointercancel', this.up); window.removeEventListener('blur', this.finish);
    window.removeEventListener('pagehide', this.finish); window.removeEventListener('resize', this.refresh);
    document.removeEventListener('visibilitychange', this.visibility);
  }
}
