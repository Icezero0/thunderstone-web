import type {CommandOption, GameCommand, MatchView} from '../../shared/api/types.js';
import type {PlayerResponseChoice} from '../../shared/components/player-deck-area/index.js';
import type {SupplySelection} from '../../shared/components/table-areas/index.js';
import {CardInteractions, createCardElements, createCardInspection, defaultCardImages} from '../../shared/components/game-card/index.js';
import {instanceName, optionRows} from './commands.js';
import {$, el} from './dom.js';
import {InteractionPanel} from './interaction-panel.js';

/** Local targeting only: prices, uses, XP and available upgrades come from legal_commands. */
export class CardActionInteraction {
  private view: MatchView | null = null;
  private busy = false;
  private disposed = false;
  private key = '';
  private mode: 'buy' | 'upgrade' | null = null;
  private readonly panel = new InteractionPanel('match-card-actions', () => this.releaseCards());
  private readonly inspection = createCardInspection($('#match-overlays'), {overlay: 'match-upgrade-inspect', content: 'match-upgrade-inspect-content'});
  private cardViews: CardInteractions | null = null;
  constructor(private send: (command: GameCommand) => void,
    private participation: {selected: (id: string) => boolean; toggle: (id: string) => void}) {}

  receive(view: MatchView, busy: boolean): void {
    const key = `${view.id}:${view.version}`;
    if (this.key !== key) {
      if (view.id !== this.view?.id || view.turn?.number !== this.view.turn?.number
        || view.turn?.subphase !== this.view.turn?.subphase) this.mode = null;
      this.key = key; this.panel.close(false);
    }
    this.view = view; this.busy = busy;
    if (!this.active) {this.mode = null; this.panel.close(false);}
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
    const commands = this.view!.legal_commands, has = (type: string) => commands.some(command => command.type === type);
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
  get highlightedIds(): readonly string[] {
    if (!this.active || this.busy) return [];
    const options = this.mode === 'upgrade' ? this.options('UpgradeHero') : this.abilities;
    return [...new Set(options.map(option => option.source_instance_id!))].filter(id => this.view!.hand.some(card => card.instance_id === id));
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
        else if (options.length) this.showUpgrades(id, options);
      }
      return true;
    }
    const abilities = this.abilities.filter(option => option.source_instance_id === id);
    if (!this.busy && abilities.length) {
      const content = el('div', 'match-card-abilities');
      const prep = this.view!.battle_preparation;
      if (prep && (prep.options.hero_instance_ids.includes(id) || prep.options.support_instance_ids.includes(id))) {
        const hero = prep.options.hero_instance_ids.includes(id), selected = this.participation.selected(id);
        const toggle = el('button', 'button secondary', hero ? (selected ? '取消参战' : '选择参战') : (selected ? '不使用此牌' : '选用此牌'));
        toggle.type = 'button'; toggle.dataset.participation = id; const key = this.key;
        toggle.addEventListener('click', () => {
          if (!this.active || this.busy || this.key !== key) return;
          this.panel.close(false); this.participation.toggle(id);
        }); content.append(toggle);
      }
      for (const option of abilities) {
        const text = this.view!.abilities[option.ability_id!]?.source_line ?? '使用此效果';
        content.append(this.button(text, 'ActivateAbility', option));
      }
      this.panel.show(instanceName(this.view!, id), content); return true;
    }
    return this.view!.turn?.subphase?.startsWith('VILLAGE_') ?? false;
  }
  clickSupply(item: SupplySelection): boolean {
    if (this.mode !== 'buy' || !this.active) return false;
    if (!this.busy && this.purchaseOptions.some(option => option.cardId === item.cardId)) {
      const pile = this.view!.supplies.find(pile => pile.zone_id === item.pileId);
      if (pile?.top_card_id === item.cardId) this.send({type: 'BuyCard', card_id: item.cardId});
    }
    // Suppress hero browsing while explicitly choosing a purchase, including unaffordable stacks.
    return true;
  }
  private showUpgrades(id: string, options: CommandOption[]): void {
    const content = el('div', 'match-upgrade-options');
    this.releaseCards(); this.cardViews = new CardInteractions(this.inspection.overlay, this.inspection.content);
    for (const option of options) {
      const definition = this.view!.cards[option.target_card_id!], name = definition?.name ?? option.target_card_id!;
      const entry = el('article', 'match-upgrade-option'), elements = createCardElements(option.target_card_id!, defaultCardImages);
      this.cardViews.add(elements, name); const key = this.key;
      elements.button.addEventListener('click', () => {if (this.key === key) this.execute('UpgradeHero', option);});
      entry.append(elements.button, this.button(`${name} · ${option.xp_cost} XP`, 'UpgradeHero', option)); content.append(entry);
    }
    this.panel.show(`${instanceName(this.view!, id)} · 选择升级目标`, content);
  }
  private button(text: string, type: string, option: CommandOption): HTMLButtonElement {
    const button = el('button', 'button secondary', text); button.type = 'button'; button.dataset.command = type;
    if (option.source_instance_id) button.dataset.sourceInstanceId = option.source_instance_id;
    if (option.ability_id) button.dataset.abilityId = option.ability_id;
    const key = this.key;
    button.addEventListener('click', () => {if (this.key === key) this.execute(type, option);}); return button;
  }
  private execute(type: string, option: CommandOption): void {
    if (!this.active || this.busy || !this.options(type).some(current => current.source_instance_id === option.source_instance_id
      && current.ability_id === option.ability_id && current.target_card_id === option.target_card_id)) return;
    this.panel.close(false);
    this.send(type === 'ActivateAbility' ? {type, source_instance_id: option.source_instance_id, ability_id: option.ability_id}
      : {type, source_instance_id: option.source_instance_id, target_card_id: option.target_card_id});
  }
  close(): void {this.panel.close(false);}
  private releaseCards(): void {this.cardViews?.dispose(); this.cardViews = null;}
  dispose(): void {this.disposed = true; this.panel.dispose(); this.releaseCards(); this.inspection.dispose();}
}
