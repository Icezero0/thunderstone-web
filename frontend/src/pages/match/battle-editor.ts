import {updateBattleDraft, previewBattleTeam, type BattleDraft, type BattleDraftAction} from '@thunderstone/engine';
import type {GameCommand, MatchView} from '../../shared/api/types.js';
import {BoardPicker} from './board-picker.js';
import {instanceName, optionRows} from './commands.js';
import type {CardStatus} from '../../shared/components/game-card/types.js';

/** Local contribution markers and equipment; all cards remain in the hand. */
export class BattleEditor {
  private draft: BattleDraft | null = null;
  private view: MatchView | null = null;
  private busy = false;
  private key = '';
  private turn = '';
  private effects = false;
  private mandatory: string[] = [];
  private calculated: {context: Parameters<typeof previewBattleTeam>[0]; draft: BattleDraft;
    selected?: ReturnType<typeof previewBattleTeam> | null; base?: ReturnType<typeof previewBattleTeam> | null} | null = null;
  constructor(private picker: BoardPicker, private send: (command: GameCommand) => void,
    private report: (message: string) => void, private changed: () => void) {}
  get effectMode(): boolean {return this.active && this.effects;}
  get mandatoryIds(): string[] {return this.mandatory.filter(id => this.view?.hand.some(card => card.instance_id === id));}
  get equipment(): Record<string, string[]> {return this.draft?.equipment ?? {};}
  get selectedIds(): string[] {
    return this.draft ? [...this.draft.hero_instance_ids, ...this.draft.support_instance_ids, ...this.mandatoryIds,
      ...Object.entries(this.draft.equipment).filter(([hero]) => this.draft!.hero_instance_ids.includes(hero)).flatMap(([, weapons]) => weapons)] : [];
  }
  get targetId(): string | null {return this.draft?.target_instance_id ?? null;}
  /** One calculation per immutable draft/context, shared by values and all status markers. */
  private calculation(withoutTarget = false): ReturnType<typeof previewBattleTeam> | null {
    const context = this.view?.battle_preparation?.context, draft = this.draft;
    if (!context || !draft) return null;
    if (this.calculated?.context !== context || this.calculated.draft !== draft) this.calculated = {context, draft};
    const key = withoutTarget && draft.target_instance_id !== null ? 'base' : 'selected';
    if (this.calculated[key] === undefined) {
      try {this.calculated[key] = previewBattleTeam(context, key === 'base' ? {...draft, target_instance_id: null} : draft);}
      catch {this.calculated[key] = null;}
    }
    return this.calculated[key] ?? null;
  }
  get handStatuses(): Record<string, readonly CardStatus[]> | null {
    if (!this.draft || !this.view?.battle_preparation) return null;
    const live = this.calculation()?.continuous_card_statuses; if (!live) return null;
    return Object.fromEntries(this.view.hand.map(card => [card.instance_id,
      [...(card.statuses ?? []).filter(status => !status.continuous), ...live[card.instance_id] ?? []]]));
  }
  get publicStatuses(): Record<string, readonly CardStatus[]> | null {
    if (!this.draft || !this.view?.battle_preparation) return null;
    const live = this.calculation()?.continuous_card_statuses; if (!live) return null;
    return Object.fromEntries([...this.view.settings, ...this.view.dungeons.flatMap(dungeon => dungeon.hall)].map(card => [card.instance_id,
      [...(card.statuses ?? []).filter(status => !status.continuous), ...live[card.instance_id] ?? []]]));
  }
  get preview(): ReturnType<typeof previewBattleTeam> | null {
    if (!this.draft?.target_instance_id || !this.view?.battle_preparation || this.view.turn?.subphase !== 'DUNGEON_DECLARE') return null;
    return this.calculation();
  }
  get values() {
    const trace = this.calculation(true)?.calculation; if (!trace) return undefined;
    const final = this.preview?.calculation;
    return {attack: trace.attack, magicAttack: trace.magic_attack, light: trace.light,
      ...(final ? {versusTarget: {attack: final.attack, magicAttack: final.magic_attack, light: final.light}} : {})};
  }
  get active(): boolean {
    return this.view?.turn?.subphase === 'DUNGEON_PREPARE' && !!this.view.battle_preparation && this.view.actor_player_id === this.view.viewer_player_id
      && this.view.status === 'active' && !this.view.pending_choice && !this.view.unavailable_reason;
  }
  get targetIds(): string[] {
    if (this.busy || this.view?.turn?.subphase !== 'DUNGEON_DECLARE' || this.view.status !== 'active'
      || this.view.actor_player_id !== this.view.viewer_player_id || this.view.pending_choice || this.view.unavailable_reason) return [];
    return this.view.legal_commands.find(command => command.type === 'DeclareBattleTarget')?.instance_ids ?? [];
  }
  receive(view: MatchView, busy: boolean): void {
    const turn = `${view.id}:${view.history?.epoch ?? 0}:${view.turn?.number}:${view.turn?.active_player_id}`, key = `${view.id}:${view.version}`;
    if (turn !== this.turn || view.turn?.chosen_action !== 'dungeon' || view.status !== 'active') {this.draft = null; this.effects = false; this.mandatory = [];}
    if (view.battle_preparation) this.mandatory = [...view.battle_preparation.options.mandatory_instance_ids];
    if (view.battle_preparation && (this.key !== key || !this.draft)) {
      const previous = this.draft, prep = view.battle_preparation;
      let next = structuredClone(prep.draft);
      const committed = view.turn?.subphase === 'DUNGEON_DECLARE';
      next.hero_instance_ids = committed ? [...prep.draft.hero_instance_ids] : previous?.hero_instance_ids.filter(id => prep.options.hero_instance_ids.includes(id)) ?? [];
      next.support_instance_ids = committed ? [...prep.draft.support_instance_ids] : previous?.support_instance_ids.filter(id => prep.options.support_instance_ids.includes(id)) ?? [];
      next.target_instance_id = committed && this.view?.turn?.subphase === 'DUNGEON_DECLARE'
        && view.legal_commands.some(command => command.type === 'DeclareBattleTarget' && command.instance_ids?.includes(previous?.target_instance_id ?? ''))
        ? previous?.target_instance_id ?? null : null;
      next.equipment = {};
      for (const [hero, weapons] of Object.entries(committed ? prep.draft.equipment : previous?.equipment ?? prep.draft.equipment)) {
        if (!prep.options.hero_instance_ids.includes(hero)) continue;
        for (const weapon of weapons) try {next = updateBattleDraft(prep.context, next, {type: 'equip', hero_instance_id: hero, weapon_instance_id: weapon});} catch { /* A resolved effect can invalidate equipment. */ }
      }
      this.draft = next;
    }
    this.view = view; this.busy = busy; this.key = key; this.turn = turn;
  }
  toggleEffects(): void {if (this.active && !this.busy) {this.effects = !this.effects; this.changed();}}
  selectTarget(id: string): void {
    if (!this.draft || !this.view?.battle_preparation || !this.targetIds.includes(id)) return;
    try {
      this.draft = updateBattleDraft(this.view.battle_preparation.context, this.draft, {type: 'set_target', target_instance_id: id});
      this.report(''); this.changed();
    } catch (error) {this.report(error instanceof Error ? error.message : '当前目标无法选择。');}
  }
  confirmTarget(): void {
    if (this.targetId && this.targetIds.includes(this.targetId)) this.send({type: 'DeclareBattleTarget', target_instance_id: this.targetId});
  }
  clickCard(id: string): boolean {
    if (!this.active) return false;
    if (this.busy || this.mandatoryIds.includes(id) || !this.draft) return true;
    const prep = this.view!.battle_preparation!;
    if (prep.options.weapon_instance_ids.includes(id)) {
      const authoritative = this.view!.legal_commands.some(command => command.type === 'UnequipWeapon' && command.instance_ids?.includes(id));
      if (Object.values(this.draft.equipment).some(weapons => weapons.includes(id)) || authoritative) {
        if (this.update({type: 'unequip', weapon_instance_id: id}) && authoritative) this.send({type: 'UnequipWeapon', instance_id: id});
      }
      else this.chooseHero(id);
    } else if (prep.options.hero_instance_ids.includes(id)) this.update({type: 'set_hero', instance_id: id, selected: !this.draft.hero_instance_ids.includes(id)});
    else if (prep.options.support_instance_ids.includes(id)) {
      const selected = !this.draft.support_instance_ids.includes(id);
      // Participation is only a preview until SubmitBattleTeam. Activating an
      // ability records real use separately; toggling never consumes a spell.
      this.update({type: 'set_support', instance_id: id, selected});
    }
    return true;
  }
  private chooseHero(weapon: string): void {
    const prep = this.view!.battle_preparation!, key = this.key;
    const eligible = prep.options.hero_instance_ids.filter(hero => {
      try {updateBattleDraft(prep.context, this.draft!, {type: 'equip', hero_instance_id: hero, weapon_instance_id: weapon}); return true;} catch {return false;}
    });
    if (!eligible.length) {this.report('手牌中没有能够装备此武器的英雄。'); return;}
    this.picker.start({prompt: `为${instanceName(this.view!, weapon)}选择装备英雄`, cards: eligible.map(id => ({key: id, instanceId: id,
      cardId: prep.context.state.instances[id].card_id})), immediate: true, cancel: () => {}, submit: ids => {
      if (key !== this.key || !this.update({type: 'equip', hero_instance_id: ids[0], weapon_instance_id: weapon})) return;
      this.picker.clear(); this.changed();
      const options = optionRows(this.view!.legal_commands.find(command => command.type === 'EquipWeapon') ?? {type: ''});
      if (options.some(option => option.hero_instance_id === ids[0] && option.weapon_instance_id === weapon))
        this.send({type: 'EquipWeapon', hero_instance_id: ids[0], weapon_instance_id: weapon});
    }});
  }
  private update(action: BattleDraftAction): boolean {
    if (!this.active || this.busy || !this.draft) return false;
    try {this.draft = updateBattleDraft(this.view!.battle_preparation!.context, this.draft, action); this.report(''); this.changed(); return true;}
    catch (error) {this.report(error instanceof Error ? error.message : '当前装备或选择无效。'); return false;}
  }
  submit(): void {
    if (!this.active || this.busy || !this.draft || !this.view!.legal_commands.some(command => command.type === 'SubmitBattleTeam')) return;
    try {
      this.send({type: 'SubmitBattleTeam', draft: {target_instance_id: null,
        hero_instance_ids: [...this.draft.hero_instance_ids], support_instance_ids: [...this.draft.support_instance_ids], equipment: structuredClone(this.draft.equipment)}});
    } catch (error) {this.report(error instanceof Error ? error.message : '当前队伍无法提交。');}
  }
}
