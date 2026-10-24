import {updateBattleDraft, previewBattleTeam, type BattleDraft, type BattleDraftAction} from '@thunderstone/engine';
import type {GameCommand, MatchView} from '../../shared/api/types.js';
import {$, el} from './dom.js';
import {instanceName, optionRows} from './commands.js';

export class BattleEditor {
  private key = '';
  private draft: BattleDraft | null = null;
  private view: MatchView | null = null;
  private busy = false;
  constructor(private send: (command: GameCommand) => void, private report: (message: string) => void,
    private selection: (ids: readonly string[]) => void) {}
  selectTarget(id: string): void {
    if (this.view?.battle_preparation?.options.target_instance_ids.includes(id)) this.update({type: 'set_target', target_instance_id: id});
  }
  selectHand(ids: readonly string[]): void {
    if (this.busy || !this.view?.battle_preparation || !this.draft) return;
    const prep = this.view.battle_preparation;
    try {
      let next = this.draft;
      for (const id of prep.options.hero_instance_ids) next = updateBattleDraft(prep.context, next, {type: 'set_hero', instance_id: id, selected: ids.includes(id)});
      for (const id of prep.options.support_instance_ids) next = updateBattleDraft(prep.context, next, {type: 'set_support', instance_id: id, selected: ids.includes(id)});
      this.draft = next;
      this.report('');
    } catch (error) {this.report(error instanceof Error ? error.message : '当前选择无效。');}
    this.render();
  }

  receive(view: MatchView, busy: boolean): void {
    const hadDraft = !!this.draft;
    this.view = view; this.busy = busy;
    const key = `${view.id}:${view.version}`;
    if (key !== this.key || (!this.draft && view.battle_preparation)) {
      this.key = key; this.draft = view.battle_preparation ? structuredClone(view.battle_preparation.draft) : null;
    }
    if (!view.battle_preparation) {if (hadDraft) this.selection([]); this.draft = null;}
    this.render();
  }
  private update(action: BattleDraftAction): void {
    if (this.busy || !this.view?.battle_preparation || !this.draft) return;
    try {
      this.draft = updateBattleDraft(this.view.battle_preparation.context, this.draft, action);
      this.report(''); this.render();
    } catch (error) {this.report(error instanceof Error ? error.message : '当前装备或选择无效。'); this.render();}
  }
  private render(): void {
    const panel = $('#battle-team-panel'), view = this.view, draft = this.draft, prep = view?.battle_preparation;
    panel.replaceChildren(); panel.hidden = !prep || !draft;
    if (!view || !prep || !draft) return;
    panel.append(el('h3', '', '战斗队伍'), el('p', 'muted small', '在手牌区选择英雄与支援。所有牌仍留在手牌中，参战选择只改变本场贡献。'));
    this.selection([...draft.hero_instance_ids, ...draft.support_instance_ids]);
    const participants = el('div', 'battle-participants'); panel.append(participants);
    for (const item of view.hand) {
      const controls = el('div', 'hand-slot-controls'); controls.id = `hand-controls-${item.instance_id}`; participants.append(controls);
      const hero = prep.options.hero_instance_ids.includes(item.instance_id), support = prep.options.support_instance_ids.includes(item.instance_id);
      if (hero || support) {
        const checked = (hero ? draft.hero_instance_ids : draft.support_instance_ids).includes(item.instance_id);
        const label = el('label', `participation-control${checked ? ' selected' : ''}`), input = el('input');
        input.type = 'checkbox'; input.checked = checked; input.disabled = this.busy; input.dataset.battleInstance = item.instance_id;
        input.addEventListener('change', () => this.update({type: hero ? 'set_hero' : 'set_support', instance_id: item.instance_id, selected: input.checked}));
        label.append(input, el('span', '', `${instanceName(view, item.instance_id)} · ${hero ? (checked ? '已参战' : '不参战') : (checked ? '已选用' : '不使用')}`)); controls.append(label);
      } else controls.append(el('span', 'muted small', prep.options.weapon_instance_ids.includes(item.instance_id) ? '在上方分配装备' : '随手牌生效'));
    }
    const targetLabel = el('label', 'battle-target-label', '攻击目标'), target = el('select'); target.disabled = this.busy; target.dataset.battleTarget = 'true';
    target.append(new Option('选择地下城中的怪物', ''));
    for (const id of prep.options.target_instance_ids) {
      const dungeon = view.dungeons.find(d => d.hall.some(card => card.instance_id === id));
      const rank = dungeon?.hall.find(card => card.instance_id === id)?.rank;
      target.append(new Option(`${instanceName(view, id)} · ${dungeon?.id === 'main' ? '' : `${dungeon?.id.toUpperCase()} · `}阶层 ${rank ?? '?'}`, id));
    }
    target.value = draft.target_instance_id ?? '';
    target.addEventListener('change', () => this.update({type: 'set_target', target_instance_id: target.value || null}));
    targetLabel.append(target); panel.append(targetLabel);
    const equipment = el('div', 'battle-equipment');
    const formalEquipment = optionRows(view.legal_commands.find(c => c.type === 'EquipWeapon') ?? {type: ''});
    for (const weapon of prep.options.weapon_instance_ids) {
      const row = el('div', 'equipment-row'), label = el('label', '', instanceName(view, weapon)), select = el('select');
      select.disabled = this.busy; select.dataset.weaponInstance = weapon; select.append(new Option('未装备', ''));
      for (const hero of draft.hero_instance_ids) select.append(new Option(instanceName(view, hero), hero));
      const owner = Object.keys(draft.equipment).find(hero => draft.equipment[hero].includes(weapon)); select.value = owner ?? '';
      select.addEventListener('change', () => this.update(select.value ? {type: 'equip', hero_instance_id: select.value, weapon_instance_id: weapon}
        : {type: 'unequip', weapon_instance_id: weapon}));
      label.append(select); row.append(label);
      if (owner && formalEquipment.some(option => option.hero_instance_id === owner && option.weapon_instance_id === weapon)) {
        const equip = el('button', 'button secondary', '立即装备'); equip.type = 'button'; equip.disabled = this.busy;
        equip.title = '提前结算装备效果，以便在准备阶段使用这件武器的能力';
        equip.addEventListener('click', () => this.send({type: 'EquipWeapon', hero_instance_id: owner, weapon_instance_id: weapon})); row.append(equip);
      }
      equipment.append(row);
    }
    if (equipment.childElementCount) panel.append(el('h4', '', '分配武器'), equipment,
      el('p', 'muted small', '选择只在本地预览。提交队伍会执行新增装备的效果；若要先使用武器能力，可点击“立即装备”。'));
    try {
      const preview = previewBattleTeam(prep.context, draft), trace = preview.calculation, totals = el('dl', 'battle-totals');
      for (const [title, value] of [['攻击', trace.attack], ['魔法攻击', trace.magic_attack], ['光照', trace.light],
        ['光照惩罚', trace.darkness_penalty], ['有效攻击', trace.effective_attack], ['目标生命', preview.health ?? '—']]) {
        const pair = el('div'); pair.append(el('dt', '', String(title)), el('dd', '', String(value))); totals.append(pair);
      }
      panel.append(totals);
      const results = {win: '当前数值足以击败', loss: '当前数值不足以击败', cannot_attack: '当前不能攻击此目标'};
      panel.append(el('p', 'preview-result', preview.outcome_before_battle_effects ? results[preview.outcome_before_battle_effects] : '选择目标后预览战果'),
        el('p', 'muted small', '这是战斗效果结算前的预估；怪物战斗词条、疾病确认、装备触发和待选效果可能改变结果。'));
      const submit = el('button', 'button primary', '提交战斗队伍'); submit.type = 'button'; submit.dataset.command = 'SubmitBattleTeam';
      submit.disabled = this.busy || !draft.target_instance_id || !trace.can_attack;
      submit.addEventListener('click', () => this.send({type: 'SubmitBattleTeam', draft: {
        target_instance_id: draft.target_instance_id, hero_instance_ids: [...draft.hero_instance_ids],
        support_instance_ids: [...draft.support_instance_ids], equipment: structuredClone(draft.equipment),
      }})); panel.append(submit);
    } catch (error) {panel.append(el('p', 'notice error', error instanceof Error ? error.message : '预览暂不可用，请刷新。'));}
  }
}
