import type {CommandOption, GameCommand, MatchView} from '../../shared/api/types.js';
import type {PlayerResponseChoice} from '../../shared/components/player-deck-area/index.js';
import type {SupplySelection} from '../../shared/components/table-areas/index.js';
import {instanceName, optionRows, valueLabel} from './commands.js';
import {BoardPicker} from './board-picker.js';
import {el} from './dom.js';
import {InteractionPanel} from './interaction-panel.js';

/** Card menus select an action; every target is chosen directly on the board. */
export class CardActionInteraction {
  private view: MatchView | null = null;
  private busy = false;
  private disposed = false;
  private key = '';
  private mode: 'buy' | 'upgrade' | null = null;
  private readonly panel = new InteractionPanel('match-card-actions');
  constructor(private send: (command: GameCommand) => void, private picker: BoardPicker) {}
  receive(view: MatchView, busy: boolean): void {
    const key = `${view.id}:${view.version}`;
    if (this.key !== key) {
      if (view.id !== this.view?.id || view.turn?.number !== this.view.turn?.number || view.turn?.subphase !== this.view.turn?.subphase) this.mode = null;
      this.key = key; this.panel.close(false);
    }
    this.view = view; this.busy = busy;
    if (!this.active) {this.mode = null; this.panel.close(false);}
    if (busy) this.panel.close(false);
  }
  private get active(): boolean {
    const view = this.view;
    return !this.disposed && !!view && view.status === 'active' && view.actor_player_id === view.viewer_player_id
      && !view.unavailable_reason && !view.pending_choice;
  }
  private options(type: string): CommandOption[] {
    return this.active ? optionRows(this.view!.legal_commands.find(command => command.type === type) ?? {type}) : [];
  }
  private get abilities(): CommandOption[] {
    return ['VILLAGE_ABILITIES', 'DUNGEON_PREPARE'].includes(this.view?.turn?.subphase ?? '') ? this.options('ActivateAbility') : [];
  }
  get choices(): PlayerResponseChoice[] | null {
    if (!this.active) return null;
    const has = (type: string) => this.view!.legal_commands.some(command => command.type === type);
    if (this.view!.turn?.subphase === 'VILLAGE_ABILITIES') return has('FinishAbilities') ? [{id: 'FinishAbilities', label: '跳过'}] : [];
    if (this.view!.turn?.subphase === 'VILLAGE_BUY') return [
      {id: 'village:buy', label: '购买卡牌', disabled: !this.options('BuyCard').length, tone: 'gold'},
      ...(has('FinishBuying') ? [{id: 'FinishBuying', label: '跳过'}] : []),
    ];
    if (this.view!.turn?.subphase === 'VILLAGE_UPGRADE') return [
      {id: 'village:upgrade', label: '升级英雄', disabled: !this.options('UpgradeHero').length, tone: 'gold'},
      ...(has('FinishUpgrading') ? [{id: 'FinishUpgrading', label: '跳过'}] : []),
    ];
    return null;
  }
  get selectedId(): string | undefined {return this.mode ? `village:${this.mode}` : undefined;}
  get prompt(): string {return this.mode === 'buy' ? '点击高亮的供应卡牌购买' : this.mode === 'upgrade' ? '选择要升级的英雄' : '';}
  get highlightedIds(): readonly string[] {
    if (!this.active || this.busy) return [];
    const options = this.mode === 'upgrade' ? this.options('UpgradeHero') : this.abilities;
    const penalties = this.view!.legal_commands.filter(command => ['AssignDiseasePenalty', 'AssignStrengthPenalty'].includes(command.type))
      .flatMap(command => command.instance_ids ?? command.penalties?.map(item => item.instance_id) ?? []);
    return [...new Set([...options.map(option => option.source_instance_id!), ...penalties])].filter(id => this.view!.hand.some(card => card.instance_id === id));
  }
  get purchaseOptions(): {cardId: string; price: number}[] {
    return this.mode === 'buy' && !this.busy ? this.options('BuyCard')
      .filter(option => typeof option.card_id === 'string' && Number.isSafeInteger(option.price) && option.price! >= 0
        && option.price! <= this.view!.viewer_resources.temporary_gold)
      .map(option => ({cardId: option.card_id!, price: option.price!})) : [];
  }
  choose(id: string): boolean {
    if (!this.active || this.busy) return false;
    const mode = id === 'village:buy' ? 'buy' : id === 'village:upgrade' ? 'upgrade' : null;
    const phase = this.view!.turn?.subphase;
    if (!mode || (mode === 'buy' ? phase !== 'VILLAGE_BUY' : phase !== 'VILLAGE_UPGRADE')) return false;
    if (!this.options(mode === 'buy' ? 'BuyCard' : 'UpgradeHero').length) return false;
    this.panel.close(); this.mode = this.mode === mode ? null : mode; return true;
  }
  clickHand(id: string): boolean {
    if (!this.active) return false;
    if (this.view!.turn?.subphase === 'VILLAGE_UPGRADE') {
      if (this.mode === 'upgrade' && !this.busy) {
        const options = this.options('UpgradeHero').filter(option => option.source_instance_id === id);
        if (options.length === 1) this.execute('UpgradeHero', options[0]);
        else if (options.length) this.chooseUpgrade(id, options);
      }
      return true;
    }
    const abilities = this.abilities.filter(option => option.source_instance_id === id);
    if (!this.busy && (abilities.length || this.penaltyCommands(id).length)) {
      const content = el('div', 'match-card-abilities'), key = this.key;
      for (const option of abilities) content.append(this.button(this.view!.abilities[option.ability_id!]?.source_line ?? '使用此效果', 'ActivateAbility', option));
      for (const type of this.penaltyCommands(id)) {
        const button = el('button', 'button secondary', type === 'AssignDiseasePenalty' ? '分配疾病惩罚' : '分配力量惩罚'); button.type = 'button';
        button.addEventListener('click', () => {if (this.key === key && !this.busy && this.panel.isOpen) {this.panel.close(false); this.choosePenalty(type, id);}});
        content.append(button);
      }
      this.panel.show(instanceName(this.view!, id), content); return true;
    }
    // Preparation hand clicks are card menus, never implicit battle toggles.
    return this.view!.turn?.subphase === 'DUNGEON_PREPARE' || (this.view!.turn?.subphase?.startsWith('VILLAGE_') ?? false);
  }
  private penaltyCommands(id: string): string[] {
    return this.active ? this.view!.legal_commands.filter(command => ['AssignDiseasePenalty', 'AssignStrengthPenalty'].includes(command.type)
      && (command.instance_ids ?? command.penalties?.map(item => item.instance_id) ?? []).includes(id)).map(command => command.type) : [];
  }
  private choosePenalty(type: string, id: string): void {
    const command = this.view!.legal_commands.find(command => command.type === type)!, key = this.key;
    if (type === 'AssignStrengthPenalty') {
      this.picker.start({prompt: `为${instanceName(this.view!, id)}选择承受力量惩罚的英雄`, cards: (command.hero_instance_ids ?? []).map(hero => ({key: hero, instanceId: hero,
        cardId: this.view!.command_instances[hero]?.card_id ?? this.view!.hand.find(card => card.instance_id === hero)!.card_id})), immediate: true, cancel: () => {},
        submit: ids => {if (this.key === key && !this.busy) this.send({type, instance_id: id, hero_instance_id: ids[0]});}});
    } else {
      this.picker.start({prompt: `为${instanceName(this.view!, id)}选择扣除的攻击类型`, cards: [], immediate: true,
        cancel: () => {}, submit: () => {}, actions: (command.attack_types ?? []).map(attackType => ({label: `扣除${valueLabel(this.view!, attackType)}`,
          run: () => {if (this.key === key && !this.busy) this.send({type, instance_id: id, attack_type: attackType});}}))});
    }
  }
  clickSupply(item: SupplySelection): boolean {
    if (this.mode !== 'buy' || !this.active) return false;
    if (!this.busy && this.purchaseOptions.some(option => option.cardId === item.cardId)) {
      const pile = this.view!.supplies.find(pile => pile.zone_id === item.pileId);
      if (pile?.top_card_id === item.cardId) this.send({type: 'BuyCard', card_id: item.cardId});
    }
    return true;
  }
  private chooseUpgrade(id: string, options: CommandOption[]): void {
    this.picker.start({prompt: `${instanceName(this.view!, id)} · 选择升级后的英雄`, cards: options.map(option => ({key: option.target_card_id!,
      cardId: option.target_card_id!, label: `${this.view!.cards[option.target_card_id!]?.name ?? option.target_card_id} · ${option.xp_cost} XP`})),
      immediate: true, cancel: () => {}, submit: keys => {const option = options.find(option => option.target_card_id === keys[0]); if (option) this.execute('UpgradeHero', option);}});
  }
  private button(text: string, type: string, option: CommandOption): HTMLButtonElement {
    const button = el('button', 'button secondary', text); button.type = 'button'; button.dataset.command = type;
    if (option.source_instance_id) button.dataset.sourceInstanceId = option.source_instance_id;
    if (option.ability_id) button.dataset.abilityId = option.ability_id;
    const key = this.key;
    button.addEventListener('click', () => {if (this.key === key && this.panel.isOpen) this.execute(type, option);}); return button;
  }
  private execute(type: string, option: CommandOption): void {
    if (!this.active || this.busy || !this.options(type).some(current => current.source_instance_id === option.source_instance_id
      && current.ability_id === option.ability_id && current.target_card_id === option.target_card_id)) return;
    this.panel.close(false);
    this.send(type === 'ActivateAbility' ? {type, source_instance_id: option.source_instance_id, ability_id: option.ability_id}
      : {type, source_instance_id: option.source_instance_id, target_card_id: option.target_card_id});
  }
  close(): void {this.panel.close(false);}
  dispose(): void {this.disposed = true; this.panel.dispose();}
}
