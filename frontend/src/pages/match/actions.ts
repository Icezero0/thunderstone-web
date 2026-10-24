import type {GameCommand, LegalCommand, MatchView} from '../../shared/api/types.js';
import {$, el} from './dom.js';
import {abilityText, choiceCountValid, instanceCardId, instanceName, moveChoice, optionRows, valueLabel} from './commands.js';
import {BattleEditor} from './battle-editor.js';
import {InteractionPanel} from './interaction-panel.js';

const responseLabels: Record<string, string> = {destroy: '摧毁新获得的疾病', redirect: '将疾病交给另一玩家',
  prevent_destroy: '防止摧毁', ignore_trap: '免疫本次陷阱', ignore_battle: '免疫战斗效果', redirect_trap: '转移陷阱效果', redirect_opponent: '转移对手效果'};
const endingLabels: Record<string, string> = {FinishAbilities: '结束村庄能力，开始购买', FinishBuying: '结束购买，开始升级',
  FinishUpgrading: '完成升级', SkipRestDestroy: '跳过摧毁', FinishTurn: '结束回合'};

export class MatchActions {
  private view: MatchView | null = null;
  private busy = false;
  private key = '';
  private selected: string[] = [];
  private order: string[] = [];
  private battle: BattleEditor;
  private readonly responsePanel: InteractionPanel;
  private responseKey = '';
  private readonly controlsParent: HTMLElement;
  constructor(private send: (command: GameCommand) => void,
    private cardTile: (view: MatchView, id: string, caption?: string) => HTMLElement,
    report: (message: string) => void, selection: (ids: readonly string[]) => void,
    private beforePanel: () => void) {
    this.battle = new BattleEditor(send, report, selection);
    this.controlsParent = $('#turn-controls').parentElement!;
    this.responsePanel = new InteractionPanel('match-effect-response', () => this.controlsParent.append($('#turn-controls')));
  }
  selectHand(ids: readonly string[]): void {this.battle.selectHand(ids);}
  selectTarget(id: string): void {this.battle.selectTarget(id);}
  completeBattle(): void {this.battle.submit();}
  openResponse(): void {
    if (!this.canRespond) return;
    this.beforePanel(); this.responsePanel.show('处理卡牌效果', $('#turn-controls'));
  }
  private get canRespond(): boolean {
    const view = this.view;
    return !!view?.pending_choice && view.status === 'active' && !view.unavailable_reason
      && view.actor_player_id === view.viewer_player_id && view.legal_commands.some(command => command.type.startsWith('Resolve'));
  }
  finish(): void {this.responsePanel.close(false);}
  dispose(): void {this.responsePanel.dispose();}

  receive(view: MatchView, busy: boolean): void {
    this.view = view; this.busy = busy;
    const key = `${view.id}:${view.version}:${view.pending_choice?.kind ?? ''}`;
    if (key !== this.key) {this.key = key; this.selected = []; this.order = [];}
    this.render(); this.battle.receive(view, busy);
    if (!this.canRespond) {this.responsePanel.close(false); this.responseKey = '';}
    else if (this.responseKey !== key) {this.responseKey = key; this.openResponse();}
  }
  private button(text: string, command: GameCommand, secondary = false): HTMLButtonElement {
    const button = el('button', secondary ? 'button secondary' : 'button primary', text);
    button.type = 'button'; button.disabled = this.busy; button.dataset.command = command.type;
    button.addEventListener('click', () => {if (!this.busy) this.send(command);}); return button;
  }
  private render(): void {
    const view = this.view!, panel = $('#turn-controls'), actions = $('#turn-actions'); actions.replaceChildren();
    panel.hidden = view.status === 'setup_pending' || view.status === 'cancelled';
    if (panel.hidden) return;
    $('#turn-controls-title').textContent = view.pending_choice ? '等待效果选择' : '当前行动';
    if (view.result) {
      $('#turn-controls-title').textContent = '对局结算';
      const winners = view.result.winner_ids.map(id => view.players.find(p => p.player_id === id)?.display_name ?? id);
      $('#turn-controls-note').textContent = winners.length ? `${winners.join('、')}获胜。` : '本局已结束。';
      const table = el('table', 'score-table'), header = el('tr');
      for (const title of ['玩家', '胜利点', '雷霆之石', '结果']) header.append(el('th', '', title)); table.append(header);
      for (const player of view.players) {
        const score = view.result.players[player.player_id]; if (!score) continue;
        const row = el('tr');
        for (const text of [player.display_name, String(score.victory_points), String(score.thunderstones), score.eliminated ? '已淘汰' : view.result.winner_ids.includes(player.player_id) ? '获胜' : '完成']) row.append(el('td', '', text));
        table.append(row);
      }
      actions.append(table); return;
    }
    if (view.unavailable_reason) {$('#turn-controls-note').textContent = view.unavailable_reason; return;}
    const actor = view.players.find(player => player.player_id === view.actor_player_id);
    if (view.actor_player_id !== view.viewer_player_id || !(view.legal_commands ?? []).length) {
      $('#turn-controls-note').textContent = actor ? `等待 ${actor.display_name} ${view.pending_choice ? '处理效果选择' : '行动'}。` : '正在等待牌桌更新。'; return;
    }
    const money = view.viewer_resources;
    $('#turn-controls-note').textContent = view.pending_choice?.ability_id ? abilityText(view, view.pending_choice.ability_id)
      : money ? `可用金币 ${money.temporary_gold} · 剩余购买 ${money.purchases_remaining}${money.extra_basic_purchases ? `（另有 ${money.extra_basic_purchases} 次基础购买）` : ''} · 经验 ${money.xp}` : '请选择当前行动。';
    for (const command of view.legal_commands) {
      if (command.type.startsWith('Resolve')) {this.renderChoice(actions, command); continue;}
      if (endingLabels[command.type]) {actions.append(this.button(endingLabels[command.type], {type: command.type}, true)); continue;}
      switch (command.type) {
        case 'ChooseAction': {
          const row = el('div', 'action-buttons');
          for (const action of command.actions ?? []) row.append(this.button(valueLabel(view, action), {type: command.type, action})); actions.append(row); break;
        }
        case 'ActivateAbility': {
          const group = el('div', 'ability-list');
          for (const option of optionRows(command)) group.append(this.button(abilityText(view, option.ability_id!, option.source_instance_id),
            {type: command.type, ability_id: option.ability_id, source_instance_id: option.source_instance_id}, true));
          actions.append(el('h3', '', '可用能力'), group); break;
        }
        case 'UseSpell': {
          const group = el('div', 'action-buttons');
          for (const id of command.instance_ids ?? []) group.append(this.button(`使用 ${instanceName(view, id)}`, {type: command.type, instance_id: id}, true));
          actions.append(el('h3', '', '使用法术'), el('p', 'muted small', '使用法术会记录本回合已用；可选主动词条仍由你单独发动。'), group); break;
        }
        case 'BuyCard': this.cardActions(actions, (command.card_ids ?? []).map(id => ({card: id,
          caption: optionRows(command).find(option => option.card_id === id)?.price,
          text: '购买', payload: {type: 'BuyCard', card_id: id}}))); break;
        case 'UpgradeHero': this.upgrades(actions, command); break;
        case 'RestDestroy': this.cardActions(actions, (command.instance_ids ?? []).map(id => ({card: instanceCardId(view, id)!,
          text: '摧毁并结束休息', payload: {type: 'RestDestroy', instance_id: id}}))); break;
        case 'AssignDiseasePenalty': case 'AssignStrengthPenalty': this.penalties(actions, command); break;
        // Equipment is edited locally in the battle panel. DeclareBattleTarget is deliberately not exposed.
        case 'EquipWeapon': case 'SubmitBattleTeam': case 'DeclareBattleTarget': break;
        default: actions.append(el('p', 'notice error', '当前操作暂无法显示，请刷新牌桌。'));
      }
    }
  }
  private cardActions(target: HTMLElement, rows: {card: string; text: string; payload: GameCommand; caption?: number}[]): void {
    const group = el('div', 'action-card-grid');
    for (const row of rows) {
      const entry = el('article', 'action-card'); entry.append(this.cardTile(this.view!, row.card, row.caption === undefined ? '' : `${row.caption} 金币`), this.button(row.text, row.payload)); group.append(entry);
    }
    target.append(group);
  }
  private upgrades(target: HTMLElement, command: LegalCommand): void {
    const view = this.view!, group = el('div', 'ability-list');
    for (const option of optionRows(command)) group.append(this.button(`${instanceName(view, option.source_instance_id!)} → ${view.cards[option.target_card_id!]?.name ?? option.target_card_id} · ${option.xp_cost ?? 0} 经验`,
      {type: command.type, source_instance_id: option.source_instance_id, target_card_id: option.target_card_id}, true));
    if (command.may_skip) group.append(this.button('跳过升级', {type: command.type, source_instance_id: null, target_card_id: null}, true)); target.append(group);
  }
  private penalties(target: HTMLElement, command: LegalCommand): void {
    const view = this.view!, group = el('div', 'penalty-options');
    for (const id of command.instance_ids ?? command.penalties?.map(p => p.instance_id) ?? []) {
      const row = el('div', 'penalty-row'); row.append(el('strong', '', instanceName(view, id)));
      if (command.type === 'AssignDiseasePenalty') for (const type of command.attack_types ?? []) row.append(this.button(`扣除${valueLabel(view, type)}`,
        {type: command.type, instance_id: id, attack_type: type}, true));
      else for (const hero of command.hero_instance_ids ?? []) row.append(this.button(`作用于${instanceName(view, hero)}`,
        {type: command.type, instance_id: id, hero_instance_id: hero}, true));
      group.append(row);
    }
    target.append(group);
  }
  private renderChoice(target: HTMLElement, command: LegalCommand): void {
    const view = this.view!;
    switch (command.type) {
      case 'ResolveChoice': {
        const minimum = command.min_count ?? 1, maximum = command.max_count ?? 1;
        target.append(el('p', '', `选择 ${minimum === maximum ? minimum : `${minimum}～${maximum}`} 张牌，已选 ${this.selected.length} 张。`));
        if (command.highest_by) target.append(el('p', 'muted small', `优先选择${{strength: '力量', level: '等级', attack: '攻击', gold: '金币值'}[command.highest_by] ?? command.highest_by}最高的卡牌。`));
        for (const constraint of command.constraints ?? []) {
          const filter = constraint.filter, description = typeof filter.tag === 'string' ? filter.tag : Array.isArray(filter.tags_any) ? filter.tags_any.join('或') : '指定类型';
          target.append(el('p', 'muted small', `${description}最多 ${constraint.maximum} 张。`));
        }
        const cards = el('div', 'action-card-grid');
        for (const id of command.instance_ids ?? []) {
          const selected = this.selected.includes(id), entry = el('article', `action-card${selected ? ' selected' : ''}`);
          const owner = view.command_instances?.[id]?.owner_player_id, player = view.players.find(p => p.player_id === owner);
          entry.append(this.cardTile(view, instanceCardId(view, id)!, player?.display_name ?? ''));
          const label = el('label', 'choice-select'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected;
          checkbox.disabled = this.busy || !selected && this.selected.length >= maximum; checkbox.dataset.choiceInstance = id;
          checkbox.addEventListener('change', () => {this.selected = this.selected.filter(item => item !== id); if (checkbox.checked) this.selected.push(id); this.render();});
          label.append(checkbox, el('span', '', selected ? '已选择' : '选择此牌')); entry.append(label); cards.append(entry);
        }
        target.append(cards);
        const confirm = this.button('确认选择', {type: command.type, instance_ids: [...this.selected]});
        confirm.disabled ||= !choiceCountValid(this.selected, command); target.append(confirm); break;
      }
      case 'ResolveCardOrder': case 'ResolveEffectOrder': {
        if (!this.order.length) this.order = command.type === 'ResolveCardOrder' ? [...command.instance_ids ?? []] : (command.effects ?? []).map(effect => effect.effect_id);
        target.append(el('p', 'muted small', command.type === 'ResolveCardOrder' ? '从上到下依次放回牌堆顶部。' : '从上到下依次结算效果。'));
        const list = el('ol', 'choice-order');
        this.order.forEach((id, index) => {
          const item = el('li'), effect = command.effects?.find(e => e.effect_id === id);
          item.append(el('span', '', effect ? abilityText(view, effect.ability_id, effect.source_instance_id) : instanceName(view, id)));
          for (const [offset, name] of [[-1, '上移'], [1, '下移']] as const) {
            const button = el('button', 'button secondary', name); button.type = 'button'; button.dataset.orderIndex = String(index); button.dataset.offset = String(offset);
            button.disabled = this.busy || index + offset < 0 || index + offset >= this.order.length;
            button.addEventListener('click', () => {this.order = moveChoice(this.order, index, offset); this.render();}); item.append(button);
          }
          list.append(item);
        });
        target.append(list, this.button('确认顺序', command.type === 'ResolveCardOrder' ? {type: command.type, instance_ids: [...this.order]} : {type: command.type, effect_ids: [...this.order]})); break;
      }
      case 'ResolveValueChoice': {
        const group = el('div', 'action-buttons');
        for (const option of command.options ?? []) if (typeof option === 'string' || typeof option === 'number' || typeof option === 'boolean') group.append(this.button(valueLabel(view, option), {type: command.type, value: option}));
        target.append(group); break;
      }
      case 'ResolveEffectPurchase': {
        this.cardActions(target, optionRows(command).map(option => ({card: option.card_id!, caption: option.price,
          text: '选择此牌', payload: {type: command.type, card_id: option.card_id}})));
        if (command.may_skip) target.append(this.button('跳过本次购买', {type: command.type, card_id: null}, true)); break;
      }
      case 'ResolveEffectUpgrade': this.upgrades(target, command); break;
      case 'ResolveReusedAbility': {
        const group = el('div', 'ability-list');
        for (const id of command.ability_ids ?? []) group.append(this.button(abilityText(view, id), {type: command.type, ability_id: id})); target.append(group); break;
      }
      case 'ResolveResponse': case 'ResolveDiseaseReplacement': {
        const group = el('div', 'ability-list');
        if (command.stage === 'recipient') {
          for (const recipient of command.options ?? []) if (typeof recipient === 'string') group.append(this.button(`交给 ${valueLabel(view, recipient)}`, {type: command.type, source_instance_id: null, recipient_id: recipient}));
        } else {
          for (const option of optionRows(command)) group.append(this.button(`${instanceName(view, option.source_instance_id!)}：${responseLabels[option.action ?? ''] ?? (option.ability_id ? abilityText(view, option.ability_id) : '使用此效果')}`,
            {type: command.type, source_instance_id: option.source_instance_id, recipient_id: null}, true));
          if (command.may_decline) group.append(this.button('不响应，继续结算', {type: command.type, source_instance_id: null, recipient_id: null}, true));
        }
        target.append(group); break;
      }
      default: target.append(el('p', 'notice error', '暂无法显示这个效果选择，请刷新牌桌。'));
    }
  }
}
