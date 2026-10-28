import type {GameCommand, LegalCommand, MatchView} from '../../shared/api/types.js';
import type {PlayerResponseChoice} from '../../shared/components/player-deck-area/index.js';
import {abilityText, instanceCardId, optionRows, valueLabel} from './commands.js';
import {BoardPicker, type PickCard} from './board-picker.js';

const responseLabels: Record<string, string> = {destroy: '摧毁新获得的疾病', redirect: '将疾病交给另一玩家',
  prevent_destroy: '防止摧毁', ignore_trap: '免疫本次陷阱', ignore_battle: '免疫战斗效果', redirect_trap: '转移陷阱效果', redirect_opponent: '转移对手效果'};

/** Translate authorized choice options into response controls and board targets. */
export class EffectInteraction {
  private key = '';
  private view: MatchView | null = null;
  private busy = false;
  private buttons = new Map<string, {label: string; command: GameCommand}>();
  private instruction = '';
  private recipients: string[] | null = null;
  constructor(private picker: BoardPicker, private send: (command: GameCommand) => void) {}
  get active(): boolean {
    return !!this.view?.pending_choice && this.view.status === 'active' && !this.view.unavailable_reason
      && this.view.actor_player_id === this.view.viewer_player_id;
  }
  get prompt(): string {return this.picker.active ? this.picker.prompt : this.instruction;}
  get playerTargets(): readonly string[] | null {return this.active && this.recipients ? this.busy ? [] : this.recipients : null;}
  clickPlayer(id: string): void {
    if (this.active && !this.busy && this.recipients?.includes(id)) this.send({type: 'ResolveDiseaseReplacement', source_instance_id: null, recipient_id: id});
  }
  get choices(): PlayerResponseChoice[] {
    return this.active ? [...this.picker.choices, ...[...this.buttons].map(([id, button]) => ({id, label: button.label}))] : [];
  }
  receive(view: MatchView, busy: boolean): void {
    this.view = view; this.busy = busy;
    const key = `${view.id}:${view.version}:${!!view.unavailable_reason}:${view.actor_player_id}`;
    if (this.key === key) return;
    this.key = key; this.buttons.clear(); this.instruction = ''; this.recipients = null;
    if (!this.active) return;
    const command = view.legal_commands.find(command => command.type.startsWith('Resolve'));
    if (!command) {this.instruction = '等待效果结算'; return;}
    const source = view.pending_choice?.ability_id ? abilityText(view, view.pending_choice.ability_id) : '效果响应';
    this.instruction = source;
    const send = (payload: GameCommand) => {if (this.key === key && this.active && !this.busy) this.send(payload);};
    const add = (label: string, payload: GameCommand) => this.buttons.set(`effect:${this.buttons.size}`, {label, command: payload});
    const instances = (ids: string[]): PickCard[] => ids.flatMap(id => {
      const cardId = instanceCardId(view, id), owner = view.command_instances[id]?.owner_player_id;
      const player = owner ? view.players.find(player => player.player_id === owner) : null;
      return cardId ? [{key: id, instanceId: id, cardId, ...(player ? {label: `${view.cards[cardId]?.name ?? cardId} · ${player.display_name}`} : {})}] : [];
    });
    const pick = (prompt: string, cards: PickCard[], submit: (key: string) => void, autoSingle = false) => this.picker.start({prompt: `${source} · ${prompt}`, cards,
      immediate: true, autoSingle, submit: keys => submit(keys[0])});
    switch (command.type) {
      case 'ResolveTrap':
        this.picker.start({prompt: '点击地下城大厅中高亮的陷阱，触发效果', cards: instances(command.instance_ids ?? []),
          immediate: true, submit: keys => send({type: command.type, instance_id: keys[0]})});
        break;
      case 'ResolveChoice': {
        const constraints = (command.constraints ?? []).map(item => {
          const filter = item.filter;
          return `${filter.tag ?? (Array.isArray(filter.tags_any) ? filter.tags_any.join('或') : '指定类型')}最多 ${item.maximum} 张`;
        });
        const highest = command.highest_by ? `优先选择${{strength: '力量', level: '等级', attack: '攻击', gold: '金币值'}[command.highest_by] ?? command.highest_by}最高的牌` : '';
        this.picker.start({prompt: [source, '点击高亮卡牌选择', highest, ...constraints].filter(Boolean).join(' · '),
          cards: instances(command.instance_ids ?? []), min: command.min_count ?? 1, max: command.max_count ?? 1,
          autoSingle: command.instance_ids?.length === 1,
          submit: keys => send({type: command.type, instance_ids: keys})}); break;
      }
      case 'ResolveCardOrder': case 'ResolveEffectOrder': {
        const cards = command.type === 'ResolveCardOrder' ? instances(command.instance_ids ?? [])
          : (command.effects ?? []).flatMap(effect => {
            const cardId = instanceCardId(view, effect.source_instance_id);
            return cardId ? [{key: effect.effect_id, cardId, instanceId: effect.source_instance_id, label: abilityText(view, effect.ability_id, effect.source_instance_id)}] : [];
          });
        this.picker.start({prompt: command.type === 'ResolveCardOrder' ? '依次点击卡牌，决定放回牌堆顶部的顺序；再次点击可取消' : '依次点击卡牌词条，决定效果结算顺序；再次点击可取消',
          cards, min: cards.length, max: cards.length, ordered: true,
          submit: keys => send(command.type === 'ResolveCardOrder' ? {type: command.type, instance_ids: keys} : {type: command.type, effect_ids: keys})}); break;
      }
      case 'ResolveValueChoice':
        for (const value of command.options ?? []) if (['string', 'number', 'boolean'].includes(typeof value))
          add(valueLabel(view, value as string | number | boolean), {type: command.type, value});
        break;
      case 'ResolveEffectPurchase':
        pick('选择要获得的卡牌', optionRows(command).map(option => ({key: option.card_id!, cardId: option.card_id!})),
          id => send({type: command.type, card_id: id}), command.may_skip === false);
        if (command.may_skip) add('跳过本次购买', {type: command.type, card_id: null});
        break;
      case 'ResolveEffectUpgrade': this.upgrade(command, source, send, instances); break;
      case 'ResolveReusedAbility':
        pick('选择要再次发动的效果', (command.ability_ids ?? []).map(id => ({key: id,
          cardId: view.abilities[id]?.source_card_id ?? id.split('-A')[0], instanceId: command.source_instance_id, label: abilityText(view, id)})),
          id => send({type: command.type, ability_id: id}), true); break;
      case 'ResolveResponse': case 'ResolveDiseaseReplacement':
        if (command.stage === 'recipient') {
          if (command.type === 'ResolveDiseaseReplacement') {
            this.recipients = (command.options ?? []).filter((id): id is string => typeof id === 'string');
            this.instruction = `${source} · 选择玩家列表中高亮的玩家接收疾病`;
            if (command.may_decline) add('跳过', {type: command.type, source_instance_id: null, recipient_id: null});
          } else for (const recipient of command.options ?? []) if (typeof recipient === 'string')
              add(`交给 ${valueLabel(view, recipient)}`, {type: command.type, source_instance_id: null, recipient_id: recipient});
        } else {
          const options = optionRows(command);
          const cards = instances([...new Set(options.map(option => option.source_instance_id!))]).map(card => ({...card,
            label: responseLabels[options.find(option => option.source_instance_id === card.instanceId)?.action ?? '']}));
          pick('点击高亮卡牌响应', cards, id => send({type: command.type, source_instance_id: id, recipient_id: null}), command.may_decline === false);
          if (command.may_decline) add('跳过', {type: command.type, source_instance_id: null, recipient_id: null});
        }
        break;
      default: this.instruction = `${source} · 暂无法显示此选择，请刷新牌桌`;
    }
  }
  private upgrade(command: LegalCommand, source: string, send: (command: GameCommand) => void, instances: (ids: string[]) => PickCard[]): void {
    const options = optionRows(command), sources = [...new Set(options.map(option => option.source_instance_id!))];
    const selectSource = () => this.picker.start({prompt: `${source} · 选择要升级的英雄`, cards: instances(sources), immediate: true, autoSingle: command.may_skip === false,
      submit: keys => {
        const targets = options.filter(option => option.source_instance_id === keys[0]);
        const submit = (target: string) => send({type: command.type, source_instance_id: keys[0], target_card_id: target});
        if (targets.length === 1) submit(targets[0].target_card_id!);
        else this.picker.start({prompt: `${source} · 选择升级后的英雄`, cards: targets.map(option => ({key: option.target_card_id!,
          cardId: option.target_card_id!, label: `${this.view!.cards[option.target_card_id!]?.name ?? option.target_card_id} · ${option.xp_cost ?? 0} XP`})), immediate: true, cancel: selectSource,
          submit: ids => submit(ids[0])});
      }});
    selectSource();
    if (command.may_skip) this.buttons.set('effect:skip-upgrade', {label: '跳过升级', command: {type: command.type, source_instance_id: null, target_card_id: null}});
  }
  choose(id: string): boolean {
    if (!this.active) return false;
    const button = this.buttons.get(id);
    if (!button) return false;
    if (!this.busy) this.send(button.command);
    return true;
  }
}
