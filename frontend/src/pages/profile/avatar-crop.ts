import {cropRect, validateAvatar} from './model.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Native canvas equivalent of iCinema's square avatar crop dialog. */
export class AvatarCrop {
  private overlay = $<HTMLElement>('avatar-crop-dialog');
  private canvas = $<HTMLCanvasElement>('avatar-crop-canvas');
  private useButton = $<HTMLButtonElement>('avatar-crop-use');
  private error = $<HTMLElement>('avatar-crop-error');
  private image: HTMLImageElement | null = null;
  private source = document.createElement('canvas');
  private objectUrl = '';
  private version = 0;
  private zoom = 1;
  private x = 0;
  private y = 0;
  private rotation = 0;
  private drag: {id: number; x: number; y: number} | null = null;
  private trigger: HTMLElement | null = null;
  private backgrounds = [$<HTMLElement>('profile-header'), $<HTMLElement>('profile-main')];
  private inertBefore: boolean[] = [];
  private events = new AbortController();
  constructor(private done: (file: File) => void) {
    const options = {signal: this.events.signal};
    for (const id of ['avatar-crop-close', 'avatar-crop-cancel']) $(id).addEventListener('click', () => this.close(), options);
    $('avatar-crop-reset').addEventListener('click', () => this.reset(), options);
    $('avatar-crop-left').addEventListener('click', () => this.rotate(-1), options);
    $('avatar-crop-right').addEventListener('click', () => this.rotate(1), options);
    this.canvas.addEventListener('wheel', event => {
      if (this.overlay.hidden || !this.image || this.useButton.disabled || event.ctrlKey || event.metaKey || !event.deltaY) return;
      event.preventDefault();
      const bounds = this.canvas.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      this.changeZoom(this.zoom * Math.exp(-Math.max(-240, Math.min(240, delta)) * .0015),
        (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
    }, {...options, passive: false});
    this.canvas.addEventListener('keydown', event => {
      if (this.overlay.hidden || !this.image || this.useButton.disabled || event.ctrlKey || event.metaKey || event.altKey) return;
      if (['+', '=', '-', '_', '0'].includes(event.key)) {
        event.preventDefault();
        if (event.key === '0') this.reset();
        else this.changeZoom(this.zoom * (event.key === '+' || event.key === '=' ? 1.15 : 1 / 1.15));
      }
    }, options);
    this.useButton.addEventListener('click', () => {void this.use();}, options);
    this.canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.drag || this.useButton.disabled) return;
      this.drag = {id: event.pointerId, x: event.clientX, y: event.clientY};
      this.canvas.setPointerCapture(event.pointerId); this.canvas.dataset.dragging = 'true'; event.preventDefault();
    }, options);
    this.canvas.addEventListener('pointermove', event => {
      if (this.drag?.id !== event.pointerId) return;
      const rect = cropRect(this.source.width, this.source.height, this.zoom, this.x, this.y);
      const ratio = rect.size / Math.max(1, this.canvas.getBoundingClientRect().width);
      this.x -= (event.clientX - this.drag.x) * ratio; this.y -= (event.clientY - this.drag.y) * ratio;
      this.drag.x = event.clientX; this.drag.y = event.clientY; this.paint();
    }, options);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(name, () => this.endDrag(), options);
    window.addEventListener('blur', () => this.endDrag(), options);
    window.addEventListener('keydown', event => {
      if (this.overlay.hidden) return;
      if (event.key === 'Escape') {event.preventDefault(); this.close();}
      if (event.key !== 'Tab') return;
      const controls = Array.from(this.overlay.querySelectorAll<HTMLElement>('button:not(:disabled), canvas[tabindex="0"]'));
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {event.preventDefault(); controls.at(-1)?.focus();}
      else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) {event.preventDefault(); controls[0]?.focus();}
    }, options);
  }
  async open(file: File): Promise<void> {
    validateAvatar(file); this.close(false);
    const version = ++this.version;
    this.objectUrl = URL.createObjectURL(file);
    const image = new Image(); image.src = this.objectUrl;
    try {
      await image.decode();
      if (version !== this.version) return;
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error('头像图片不能超过 1600 万像素。');
      this.image = image; this.rotation = 0; this.prepare();
      this.trigger = document.activeElement as HTMLElement | null;
      this.inertBefore = this.backgrounds.map(element => element.inert);
      this.backgrounds.forEach(element => {element.inert = true;});
      this.overlay.hidden = false; this.error.hidden = true; this.useButton.disabled = false;
      $('avatar-crop-close').focus({preventScroll: true});
    } catch (error) {
      if (version !== this.version) return;
      this.close(); throw new Error(error instanceof Error && error.message.includes('1600') ? error.message : '无法读取头像，请重新选择图片。');
    }
  }
  private prepare(): void {
    const image = this.image; if (!image) return;
    const swapped = Math.abs(this.rotation % 2) === 1;
    this.source.width = swapped ? image.naturalHeight : image.naturalWidth;
    this.source.height = swapped ? image.naturalWidth : image.naturalHeight;
    const ctx = this.source.getContext('2d'); if (!ctx) throw new Error('浏览器不支持图片裁剪。');
    ctx.translate(this.source.width / 2, this.source.height / 2); ctx.rotate(this.rotation * Math.PI / 2);
    ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2); this.reset();
  }
  private rotate(turn: number): void {this.rotation = (this.rotation + turn) % 4; this.prepare();}
  private reset(): void {this.zoom = 1; this.x = this.y = 0; this.paint();}
  private changeZoom(value: number, anchorX = .5, anchorY = .5): void {
    const old = cropRect(this.source.width, this.source.height, this.zoom, this.x, this.y);
    this.zoom = Math.max(1, Math.min(4, value));
    const size = Math.min(this.source.width, this.source.height) / this.zoom;
    this.x = old.x + Math.max(0, Math.min(1, anchorX)) * (old.size - size) - (this.source.width - size) / 2;
    this.y = old.y + Math.max(0, Math.min(1, anchorY)) * (old.size - size) - (this.source.height - size) / 2;
    this.paint();
  }
  private paint(): void {
    const rect = cropRect(this.source.width, this.source.height, this.zoom, this.x, this.y);
    this.x = rect.x - (this.source.width - rect.size) / 2; this.y = rect.y - (this.source.height - rect.size) / 2;
    const ctx = this.canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, 512, 512); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.source, rect.x, rect.y, rect.size, rect.size, 0, 0, 512, 512);
  }
  private async use(): Promise<void> {
    if (this.useButton.disabled || this.overlay.hidden) return;
    const version = this.version; this.useButton.disabled = true;
    try {
      const blob = await new Promise<Blob>((resolve, reject) => this.canvas.toBlob(value => value ? resolve(value) : reject(new Error('头像导出失败，请重试。')), 'image/png'));
      if (version !== this.version) return;
      this.done(new File([blob], 'avatar.png', {type: 'image/png'})); this.close();
    } catch (error) {
      if (version !== this.version) return;
      this.error.textContent = error instanceof Error ? error.message : '头像导出失败。';
      this.error.dataset.error = 'true'; this.error.hidden = false;
    } finally {if (version === this.version) this.useButton.disabled = false;}
  }
  private endDrag(): void {
    const drag = this.drag; this.drag = null; delete this.canvas.dataset.dragging;
    if (drag && this.canvas.hasPointerCapture(drag.id)) this.canvas.releasePointerCapture(drag.id);
  }
  close(restoreFocus = true): void {
    this.version++; this.endDrag();
    if (!this.overlay.hidden) {
      this.overlay.hidden = true; this.backgrounds.forEach((element, i) => {element.inert = this.inertBefore[i];});
      if (restoreFocus) this.trigger?.focus({preventScroll: true});
    }
    this.trigger = null; this.image = null; this.source.width = this.source.height = 0;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); this.objectUrl = '';
  }
  dispose(): void {this.close(false); this.events.abort();}
}
