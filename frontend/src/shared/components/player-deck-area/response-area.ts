import type {PlayerResponse} from './types.js';

/** A small pennant marks the viewer's own turn, with an accessible text equivalent. */
function turnIndicator(id: string): HTMLElement {
  const marker = document.createElement('span'); marker.id = id; marker.className = 'player-turn-indicator';
  marker.setAttribute('role', 'img'); marker.setAttribute('aria-label', '当前是你的回合'); marker.setAttribute('title', '你的回合');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'})) svg.setAttribute(key, value);
  for (const d of ['M5 21V3', 'M5 3h13l-3 5 3 5H5']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path);
  }
  marker.append(svg); return marker;
}

/** A host-driven choice prompt; never decides which game actions are legal. */
export class PlayerResponseArea {
  private response: PlayerResponse | null = null;
  private disabled = false;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private cleanup: (() => void)[] = [];
  constructor(private root: HTMLElement, private id: (key: string) => string, private choose?: (responseId: string, choiceId: string) => void) {}
  set(response: PlayerResponse | null): void {
    const choices = response?.choices ?? [];
    if (response && (!response.id || (!response.prompt.trim() && !choices.length && !response.progress) || new Set(choices.map(choice => choice.id)).size !== choices.length
      || choices.some(choice => !choice.id || !choice.label || choice.tone !== undefined && !['gold', 'violet', 'blue', 'red'].includes(choice.tone))
      || (response.selectedId !== undefined && !choices.some(choice => choice.id === response.selectedId)))) {
      throw new Error('A response needs content, unique choices and a valid selectedId.');
    }
    const focused = [...this.buttons].find(([, button]) => button === document.activeElement)?.[0];
    this.cleanup.forEach(cleanup => cleanup()); this.cleanup = []; this.buttons.clear();
    this.response = response ? {...response, choices: choices.map(choice => ({...choice}))} : null;
    this.root.textContent = ''; this.root.dataset.empty = String(!response);
    if (!this.response) return;
    if (this.response.isCurrentTurn) this.root.append(turnIndicator(this.id('turn-indicator')));
    if (this.response.progress) {
      const {action, stage, step, total} = this.response.progress;
      const progress = document.createElement('span'); progress.className = 'player-response-progress';
      progress.id = this.id('response-progress');
      progress.textContent = `${action} · ${step}/${total} ${stage}`;
      this.root.append(progress);
    }
    const prompt = document.createElement('span'); prompt.className = 'player-response-prompt'; prompt.textContent = this.response.prompt;
    prompt.setAttribute('role', 'status'); prompt.setAttribute('aria-live', 'polite');
    this.root.append(prompt);
    for (const choice of this.response.choices ?? []) {
      const button = document.createElement('button'); button.type = 'button'; button.id = this.id(`response-${choice.id}`);
      button.className = 'player-response-choice'; button.textContent = choice.label;
      if (choice.tone) button.dataset.tone = choice.tone;
      if (this.response.selectedId !== undefined) button.setAttribute('aria-pressed', String(choice.id === this.response.selectedId));
      const responseId = this.response.id, click = () => {
        if (button.disabled || !this.root.contains(button) || this.response?.id !== responseId) return;
        for (let node: HTMLElement | null = this.root; node; node = node.parentElement) if (node.hidden || node.inert) return;
        this.choose?.(responseId, choice.id);
      };
      button.addEventListener('click', click); this.cleanup.push(() => button.removeEventListener('click', click));
      this.root.append(button); this.buttons.set(choice.id, button);
    }
    this.setDisabled(this.disabled);
    if (focused) (this.buttons.get(focused) ?? [...this.buttons.values()].find(button => !button.disabled))?.focus({preventScroll: true});
  }
  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    for (const choice of this.response?.choices ?? []) this.buttons.get(choice.id)!.disabled = disabled || !!this.response?.disabled || !!choice.disabled;
  }
  dispose(): void {this.cleanup.forEach(cleanup => cleanup()); this.cleanup = []; this.buttons.clear(); this.response = null; this.root.textContent = '';}
}
