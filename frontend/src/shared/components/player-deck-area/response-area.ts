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
    const prompt = document.createElement('span'); prompt.className = 'player-response-prompt';
    prompt.dataset.error = String(!!this.response.error); prompt.textContent = this.response.error || this.response.prompt;
    prompt.setAttribute('role', this.response.error ? 'alert' : 'status'); prompt.setAttribute('aria-live', this.response.error ? 'assertive' : 'polite');
    if (this.response.battlePreview && !this.response.error) {
      const preview = this.response.battlePreview, icon = document.createElement('span');
      icon.className = 'battle-preview-outcome'; icon.dataset.outcome = preview.outcome;
      icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', preview.outcome === 'unknown' ? '结果未知，有效果待执行' : preview.outcome === 'win' ? '预计能够击败' : preview.outcome === 'cannot_attack' ? '当前无法攻击' : '预计无法击败');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'aria-hidden': 'true'})) svg.setAttribute(name, value);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', preview.outcome === 'unknown' ? 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM9 8a3 3 0 0 1 6 0c0 2-3 2-3 5M12 16v2' : preview.outcome === 'win' ? 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6ZM7 12l3 3 7-7' : 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6ZM8 8l8 8M16 8l-8 8');
      svg.append(path); icon.append(svg); prompt.textContent = '';
      const text = document.createElement('span'); text.textContent = `攻击阶层 ${preview.rank} ：队伍预计攻击总和 ${preview.total}。`; prompt.append(icon, text);
      const note = document.createElement('small'); note.className = 'battle-preview-note'; note.textContent = this.response.prompt; prompt.append(note);
    }
    this.root.append(prompt);
    if (this.response.combat) {
      const totals = document.createElement('span'); totals.className = 'player-response-combat'; totals.id = this.id('combat-values');
      for (const [key, label, paths] of [
        ['attack', '攻击', ['M9 13 18 4l3-1-1 3-9 9Z', 'm6 11 7 7', 'm9.5 15.5-5 5M3 19l2 2']],
        ['magicAttack', '魔法攻击', ['M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Z',
          'M12 6v14M6 9.5l3 .5M6 13l3 .5', 'm17 8 .8 2.2L20 11l-2.2.8L17 14l-.8-2.2L14 11l2.2-.8Z']],
        ['light', '光照', ['M9 6V5a3 3 0 0 1 6 0v1', 'm9 6-3 4h12l-3-4ZM6 10l1 11h10l1-11M6 21h12',
          'M12 12c.5 2 2 2.5 2 4a2 2 0 0 1-4 0c0-1.5 1-2 2-4Z']],
      ] as const) {
        const item = document.createElement('span'); item.className = `combat-value combat-value-${key}`;
        const value = this.response.combat[key], final = this.response.combat.versusTarget?.[key];
        item.setAttribute('aria-label', `${label} ${value}${final === undefined ? '' : `，挑战目标预计 ${final}`}`);
        item.title = final === undefined ? label : `${label} · 括号内为挑战目标时的预估值，未执行的效果不计入；总和另计光照惩罚`;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [name, value] of Object.entries({viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'})) svg.setAttribute(name, value);
        for (const d of paths) {const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path);}
        const number = document.createElement('b'); number.textContent = String(value); item.append(svg, number);
        if (final !== undefined) {const adjusted = document.createElement('span'); adjusted.className = 'combat-value-adjusted'; adjusted.textContent = `(${final})`; item.append(adjusted);}
        totals.append(item);
      }
      this.root.append(totals);
    }
    for (const choice of this.response.choices ?? []) {
      const button = document.createElement('button'); button.type = 'button'; button.id = this.id(`response-${choice.id}`);
      button.className = 'player-response-choice'; button.textContent = choice.label;
      if (choice.tone) button.dataset.tone = choice.tone;
      if (choice.pressed !== undefined) button.setAttribute('aria-pressed', String(choice.pressed));
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
