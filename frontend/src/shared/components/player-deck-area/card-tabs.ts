import type {PlayerCardTab} from './types.js';
import type {PlayerDeckElements} from './view.js';

const order: PlayerCardTab[] = ['hand', 'treasures', 'aside'];

/** Local tab selection does not move cards between game zones. */
export class PlayerCardTabs {
  active: PlayerCardTab = 'hand';
  private disabled = false;
  private readonly cleanup: (() => void)[] = [];
  constructor(private view: PlayerDeckElements, private changed: () => void) {
    for (const kind of order) {
      const tab = view.tabs[kind], click = () => {this.select(kind);};
      const keydown = (event: KeyboardEvent) => {
        if (this.disabled || tab.hidden || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const available = order.filter(item => !view.tabs[item].hidden), index = available.indexOf(kind);
        const target = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1)!
          : available[(index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length];
        event.preventDefault(); if (this.select(target)) view.tabs[target].focus({preventScroll: true});
      };
      tab.addEventListener('click', click); tab.addEventListener('keydown', keydown);
      this.cleanup.push(() => {tab.removeEventListener('click', click); tab.removeEventListener('keydown', keydown);});
    }
  }
  update(treasures: number, aside: number): void {
    const previous = this.active, focused = document.activeElement;
    this.view.tabs.treasures.hidden = treasures === 0; this.view.tabs.aside.hidden = aside === 0;
    if (this.view.tabs[previous].hidden) {
      this.active = 'hand'; this.render(); this.changed();
      if (focused instanceof HTMLElement && (focused === this.view.tabs[previous] || this.view.panels[previous].contains(focused))) this.view.tabs.hand.focus({preventScroll: true});
    } else this.render();
  }
  select(kind: PlayerCardTab): boolean {
    if (this.disabled || this.view.tabs[kind].hidden || this.blocked()) return false;
    if (kind !== this.active) {this.active = kind; this.render(); this.changed();}
    return true;
  }
  private blocked(): boolean {
    for (let node: HTMLElement | null = this.view.root; node; node = node.parentElement) if (node.hidden || node.inert) return true;
    return false;
  }
  private render(): void {
    for (const kind of order) {
      const selected = kind === this.active;
      this.view.tabs[kind].setAttribute('aria-selected', String(selected)); this.view.tabs[kind].tabIndex = selected ? 0 : -1;
      this.view.panels[kind].hidden = !selected;
    }
  }
  setDisabled(disabled: boolean): void {this.disabled = disabled; for (const kind of order) this.view.tabs[kind].disabled = disabled;}
  dispose(): void {this.cleanup.forEach(cleanup => cleanup()); this.disabled = true;}
}
