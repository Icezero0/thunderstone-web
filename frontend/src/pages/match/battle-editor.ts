import {updateBattleDraft, previewBattleTeam, type BattleDraft, type BattleDraftAction} from '@thunderstone/engine';
import type {GameCommand, MatchView} from '../../shared/api/types.js';
import {BoardPicker} from './board-picker.js';
import {instanceName} from './commands.js';
import type {CardStatus} from '../../shared/components/game-card/types.js';

/** Local contribution markers and equipment; all cards remain in the hand. */
export class BattleEditor {
  private draft: BattleDraft | null = null;
  private view: MatchView | null = null;
  private busy = false;
  private localSelectionAllowed = false;
  private sentEquipment: Record<string, string[]> | null = null;
  private sentEquipmentKey = '';
  private equipmentRollback: Record<string, string[]> | null = null;
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
  receive(view: MatchView, busy: boolean, localSelectionAllowed = false): void {
    const turn = `${view.id}:${view.history?.epoch ?? 0}:${view.turn?.number}:${view.turn?.active_player_id}`, key = `${view.id}:${view.version}`;
    if (turn !== this.turn || view.turn?.chosen_action !== 'dungeon' || view.status !== 'active') {
      this.draft = null; this.effects = false; this.mandatory = []; this.sentEquipment = null; this.equipmentRollback = null;
    }
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
      const equipment = this.sentEquipment ? prep.draft.equipment : previous?.equipment ?? prep.draft.equipment;
      for (const [hero, weapons] of Object.entries(committed ? prep.draft.equipment : equipment)) {
        if (!prep.options.hero_instance_ids.includes(hero)) continue;
        for (const weapon of weapons) try {next = updateBattleDraft(prep.context, next, {type: 'equip', hero_instance_id: hero, weapon_instance_id: weapon});} catch { /* A resolved effect can invalidate equipment. */ }
      }
      this.draft = next;
      this.sentEquipment = null; this.equipmentRollback = null;
    }
    if (this.busy && !busy && this.sentEquipment && key === this.sentEquipmentKey) {
      if (this.draft && this.equipmentRollback) this.draft = {...this.draft, equipment: this.equipmentRollback};
      this.sentEquipment = null; this.equipmentRollback = null;
    }
    this.view = view; this.busy = busy; this.key = key; this.turn = turn;
    this.localSelectionAllowed = localSelectionAllowed;
  }
  toggleEffects(): void {
    if (!this.active || (this.busy && !this.localSelectionAllowed)) return;
    this.effects = !this.effects; this.changed();
    // Ability legality may depend on being equipped. Resolve that boundary once,
    // instead of requesting authority for every draft adjustment.
    if (this.effects && !this.busy && this.draft && this.equipmentDirty(this.draft.equipment)
        && this.view!.legal_commands.some(command => command.type === 'UpdatePreparationEquipment'))
      this.send({type: 'UpdatePreparationEquipment', equipment: structuredClone(this.draft.equipment)});
  }
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
    if ((this.busy && !this.localSelectionAllowed) || this.mandatoryIds.includes(id) || !this.draft) return true;
    const prep = this.view!.battle_preparation!;
    if (prep.options.weapon_instance_ids.includes(id)) {
      if (this.busy) return true;
      if (Object.values(this.draft.equipment).some(weapons => weapons.includes(id))) this.update({type: 'unequip', weapon_instance_id: id});
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
      const previous = structuredClone(this.draft!.equipment);
      if (key !== this.key || !this.update({type: 'equip', hero_instance_id: ids[0], weapon_instance_id: weapon})) return;
      this.picker.clear(); this.changed();
      if (prep.options.immediate_equipment_instance_ids?.includes(weapon) ?? true) {
        this.equipmentRollback = previous;
        this.send({type: 'EquipWeapon', hero_instance_id: ids[0], weapon_instance_id: weapon});
      }
    }});
  }
  private update(action: BattleDraftAction): boolean {
    if (!this.active || (this.busy && !(this.localSelectionAllowed && ['set_hero', 'set_support'].includes(action.type))) || !this.draft) return false;
    try {this.draft = updateBattleDraft(this.view!.battle_preparation!.context, this.draft, action); this.report(''); this.changed(); return true;}
    catch (error) {this.report(error instanceof Error ? error.message : '当前装备或选择无效。'); return false;}
  }
  /** Include draft equipment in the next real operation, without committing participation. */
  prepareCommand(command: GameCommand): GameCommand {
    if (command.type === 'UpdatePreparationEquipment' && this.draft) {
      this.sentEquipment = structuredClone(this.draft.equipment); this.sentEquipmentKey = this.key; return command;
    }
    if (!this.active || !this.draft || !['ActivateAbility', 'EquipWeapon', 'AssignDiseasePenalty', 'AssignStrengthPenalty'].includes(command.type)) return command;
    const equipment = structuredClone(this.draft.equipment);
    if (command.type === 'EquipWeapon') for (const hero of Object.keys(equipment)) {
      equipment[hero] = equipment[hero].filter(id => id !== command.weapon_instance_id);
      if (!equipment[hero].length) delete equipment[hero];
    }
    this.sentEquipment = structuredClone(this.draft.equipment);
    this.sentEquipmentKey = this.key;
    return this.equipmentDirty(equipment) ? {...command, preparation_equipment: equipment} : command;
  }
  private equipmentDirty(equipment: Record<string, string[]>): boolean {
    const pairs = (value: Record<string, string[]>) => Object.entries(value).flatMap(([hero, weapons]) => weapons.map(weapon => `${hero}:${weapon}`)).sort().join('|');
    return pairs(equipment) !== pairs(this.view!.battle_preparation!.draft.equipment);
  }
  submit(): void {
    if (!this.active || this.busy || !this.draft || !this.view!.legal_commands.some(command => command.type === 'SubmitBattleTeam')) return;
    try {
      this.send({type: 'SubmitBattleTeam', draft: {target_instance_id: null,
        hero_instance_ids: [...this.draft.hero_instance_ids], support_instance_ids: [...this.draft.support_instance_ids], equipment: structuredClone(this.draft.equipment)}});
    } catch (error) {this.report(error instanceof Error ? error.message : '当前队伍无法提交。');}
  }
}
