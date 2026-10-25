import {$, el} from './dom.js';

/** A card action menu; card targets are always selected on the table. */
export class InteractionPanel {
  readonly root = el('section', 'match-interaction-panel browse-dialog game-cursor');
  readonly body = el('div', 'match-interaction-body browse-dialog-body');
  private readonly title = el('h2');
  private readonly closeButton = el('button', 'button secondary browse-dialog-close', '关闭 ×');
  private previous: HTMLElement | null = null;
  private inertBefore: boolean[] = [];
  private readonly background = [$('#match-content'), $('#match-header')];
  private open = false;
  get isOpen(): boolean {return this.open;}

  constructor(id: string, private onClose?: () => void) {
    this.root.id = id; this.root.hidden = true; this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true');
    this.title.id = `${id}-title`; this.root.setAttribute('aria-labelledby', this.title.id);
    this.closeButton.id = `${id}-close`; this.closeButton.type = 'button';
    const panel = el('div', 'browse-dialog-panel'), heading = el('header', 'browse-dialog-heading');
    heading.append(this.title, this.closeButton); panel.append(heading, this.body); this.root.append(panel); $('#match-overlays').append(this.root);
    this.closeButton.addEventListener('click', this.closeClicked); this.root.addEventListener('click', this.backdrop);
    window.addEventListener('keydown', this.keydown);
  }
  show(title: string, content: HTMLElement): void {
    this.title.textContent = title;
    if (!this.body.contains(content)) this.body.replaceChildren(content);
    if (this.open) return;
    this.previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.inertBefore = this.background.map(element => element.inert);
    this.background.forEach(element => {element.inert = true;});
    this.open = true; this.root.hidden = false; this.closeButton.focus({preventScroll: true});
  }
  close(restoreFocus = true): void {
    if (!this.open) return;
    this.open = false; this.root.hidden = true;
    this.background.forEach((element, i) => {element.inert = this.inertBefore[i];});
    this.onClose?.();
    if (restoreFocus && this.previous?.isConnected) this.previous.focus({preventScroll: true});
    this.previous = null;
  }
  private closeClicked = (): void => {this.close();};
  private backdrop = (event: MouseEvent): void => {if (event.target === this.root) this.close();};
  private keydown = (event: KeyboardEvent): void => {
    if (!this.open || event.isComposing) return;
    if (event.key === 'Escape') {event.preventDefault(); this.close(); return;}
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = [this.closeButton, ...Array.from(this.body.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]'))]
      .filter(element => !(element as HTMLButtonElement).disabled && !element.hidden && element.tabIndex !== -1);
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && index <= 0) {event.preventDefault(); buttons.at(-1)?.focus();}
    else if (!event.shiftKey && (index < 0 || index === buttons.length - 1)) {event.preventDefault(); buttons[0]?.focus();}
  };
  dispose(): void {
    this.close(false); this.closeButton.removeEventListener('click', this.closeClicked); this.root.removeEventListener('click', this.backdrop);
    window.removeEventListener('keydown', this.keydown); this.root.remove();
  }
}
