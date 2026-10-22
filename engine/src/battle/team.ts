import {isHero, isMonster, tags} from '../catalog/cards.js';
import {Calculation, equipmentPairs} from '../effects/context.js';
import {RuleError, type BattleTeam, type CombatTrace} from '../types.js';
import {combatValues, equipmentCapacity, equipmentChoices, monsterHealth} from './combat.js';
import {ENGINE_VERSION} from '../build-info.js';
import type {PreviewContext} from './preview.js';
import {isBattleSupport} from './participation.js';

export interface BattleDraft extends BattleTeam {
  schema_version: 'thunderstone.battle-draft/1';
  engine_version: string;
  game_version: number;
  catalog_version: string;
  effects_version: string;
  player_id: string;
  target_instance_id: string | null;
  equipment: Record<string, string[]>;
}
export type BattleDraftAction =
  | {type: 'set_hero' | 'set_support'; instance_id: string; selected: boolean}
  | {type: 'equip'; hero_instance_id: string; weapon_instance_id: string}
  | {type: 'unequip'; weapon_instance_id: string}
  | {type: 'set_target'; target_instance_id: string | null};
export interface SubmitBattleTeamCommand {
  type: 'SubmitBattleTeam'; player_id: string; expected_version: number; draft: BattleDraft;
}
export interface BattleTeamPreview {
  draft: BattleDraft;
  calculation: CombatTrace;
  target_instance_id: string | null;
  rank: number | null;
  health: number | null;
  outcome_before_battle_effects: 'win' | 'loss' | 'cannot_attack' | null;
  equipment_events_pending: number;
}

function checkContext(context: PreviewContext) {
  if (context.schema_version !== 'thunderstone.preview/1' || context.engine_version !== ENGINE_VERSION)
    throw new RuleError('shared engine version mismatch or unsupported battle context');
  if (context.player_id !== context.state.active_player_id || !context.state.battle_context)
    throw new RuleError('battle context requires the active player and dungeon preparation');
}
export function battleTeamOptions(context: PreviewContext) {
  checkContext(context);
  const tx = new Calculation(context), hand = tx.hand();
  return {
    hero_instance_ids: hand.filter(id => isHero(tx.card(id))),
    support_instance_ids: hand.filter(id => isBattleSupport(tx.card(id))),
    weapon_instance_ids: hand.filter(id => tags(tx.card(id)).includes('武器')),
    mandatory_instance_ids: hand.filter(id => !isHero(tx.card(id)) && !isBattleSupport(tx.card(id)) && !tags(tx.card(id)).includes('武器')),
    target_instance_ids: Object.entries(tx.state.zones).filter(([name]) => name.startsWith('hall:'))
      .flatMap(([, pile]) => pile).filter(id => isMonster(tx.card(id)) && tx.card(id).wiki_生命值 !== ''),
  };
}
export function createBattleDraft(context: PreviewContext, targetId: string | null = null): BattleDraft {
  const options = battleTeamOptions(context);
  return {schema_version: 'thunderstone.battle-draft/1', engine_version: context.engine_version,
    game_version: context.game_version, catalog_version: context.catalog_version, effects_version: context.effects_version,
    player_id: context.player_id, target_instance_id: targetId,
    hero_instance_ids: [...options.hero_instance_ids], support_instance_ids: [...options.support_instance_ids],
    equipment: Object.fromEntries(Object.entries(context.state.battle_context!.equipped_weapon_by_hero ?? {})
      .map(([hero, weapons]) => [hero, [...(Array.isArray(weapons) ? weapons : [weapons])]]))};
}
function selection(value: unknown, allowed: string[], name: string): asserts value is string[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !allowed.includes(id)))
    throw new RuleError(`invalid battle ${name}: use unique current hand instances`);
}

/** Validates and projects a draft into a new calculation input. Never executes effects. */
export function battleDraftInput(context: PreviewContext, draft: BattleDraft): PreviewContext {
  const options = battleTeamOptions(context);
  if (!draft || draft.schema_version !== 'thunderstone.battle-draft/1') throw new RuleError('unsupported battle draft');
  for (const key of ['engine_version', 'game_version', 'catalog_version', 'effects_version', 'player_id'] as const)
    if (draft[key] !== context[key]) throw new RuleError(`stale or mismatched battle draft ${key}`);
  selection(draft.hero_instance_ids, options.hero_instance_ids, 'heroes');
  selection(draft.support_instance_ids, options.support_instance_ids, 'support');
  if (draft.target_instance_id !== null && !options.target_instance_ids.includes(draft.target_instance_id))
    throw new RuleError('battle target must be a visible monster or guardian');
  if (!draft.equipment || typeof draft.equipment !== 'object' || Array.isArray(draft.equipment))
    throw new RuleError('invalid battle equipment');
  const input = structuredClone(context);
  input.state.battle_context!.equipped_weapon_by_hero = structuredClone(draft.equipment);
  input.state.battle_context!.battle_team = {hero_instance_ids: [...draft.hero_instance_ids], support_instance_ids: [...draft.support_instance_ids]};
  const tx = new Calculation(input), pairs = equipmentPairs(tx.context), weapons = pairs.map(([, weapon]) => weapon);
  if (new Set(weapons).size !== weapons.length) throw new RuleError('a weapon may only be equipped once');
  for (const [hero, values] of Object.entries(draft.equipment)) {
    selection(values, options.weapon_instance_ids, 'weapons');
    if (!draft.hero_instance_ids.includes(hero) || values.includes(hero)) throw new RuleError('equipment requires a selected hero');
    if (values.length > equipmentCapacity(input, hero)) throw new RuleError('hero equipment capacity exceeded');
  }
  // Validate new pairs in the same order and against the same shared choices
  // used by server EquipWeapon, before any CARD_EQUIPPED effects execute.
  const working = structuredClone(context), existing = new Set(equipmentPairs(working.state.battle_context!).map(([hero, weapon]) => `${hero}\0${weapon}`));
  const wanted = new Set(pairs.map(([hero, weapon]) => `${hero}\0${weapon}`));
  const kept = equipmentPairs(working.state.battle_context!).filter(([hero, weapon]) => wanted.has(`${hero}\0${weapon}`));
  const mapping: Record<string, string[]> = {};
  working.state.battle_context!.equipped_weapon_by_hero = mapping;
  for (const [hero, weapon] of kept) (mapping[hero] ??= []).push(weapon);
  for (const [hero, weapon] of pairs) if (!existing.has(`${hero}\0${weapon}`)) {
    if (!equipmentChoices(working).some(item => item.hero_instance_id === hero && item.weapon_instance_id === weapon))
      throw new RuleError('weapon is too heavy or exceeds hero equipment capacity');
    (mapping[hero] ??= []).push(weapon);
  }
  const rank = draft.target_instance_id ? battleTargetRank(input, draft.target_instance_id) : 0;
  const target = draft.target_instance_id ? tx.card(draft.target_instance_id) : null;
  let trace: CombatTrace;
  try {trace = combatValues(input, rank, target);}
  catch (error) {
    if (!(error instanceof RuleError) || error.message !== 'disease penalty must target a positive attack type') throw error;
    // Changing the team can empty the previously chosen positive attack pool.
    // Keep valid assignments; otherwise return to the shared automatic rule.
    delete input.state.battle_context!.disease_penalty_assignments;
    trace = combatValues(input, rank, target);
  }
  const valid = new Set(trace.equipped_pairs.map(([hero, weapon]) => `${hero}\0${weapon}`));
  for (const [hero, weapon] of pairs) if (!valid.has(`${hero}\0${weapon}`))
    throw new RuleError('weapon is too heavy for the selected hero');
  // Selected passive spells/items count as use; earlier activations remain used.
  const used = input.state.battle_context!.used_card_tags ??= [];
  for (const id of [...draft.support_instance_ids, ...weapons])
    for (const tag of tags(tx.card(id))) if (tag && !used.includes(tag)) used.push(tag);
  return input;
}
export function battleTargetRank(context: PreviewContext, targetId: string): number {
  const entry = Object.entries(context.state.zones).find(([name, pile]) => name.startsWith('hall:') && pile.includes(targetId));
  if (!entry) throw new RuleError('battle target is no longer in a visible hall');
  return entry[0].endsWith(':rank0') ? 0 : entry[1].indexOf(targetId) + 1;
}
export function previewBattleTeam(context: PreviewContext, draft: BattleDraft): BattleTeamPreview {
  const input = battleDraftInput(context, draft), tx = new Calculation(input);
  const rank = draft.target_instance_id === null ? null : battleTargetRank(input, draft.target_instance_id);
  const target = draft.target_instance_id === null ? null : tx.card(draft.target_instance_id);
  const calculation = combatValues(input, rank ?? 0, target);
  const health = target ? monsterHealth(input, target, rank!, draft.target_instance_id) : null;
  const existing = new Set(equipmentPairs(context.state.battle_context!).map(([hero, weapon]) => `${hero}\0${weapon}`));
  return {draft: structuredClone(draft), calculation, target_instance_id: draft.target_instance_id, rank, health,
    outcome_before_battle_effects: health === null ? null : !calculation.can_attack ? 'cannot_attack'
      : calculation.can_defeat && calculation.effective_attack >= health ? 'win' : 'loss',
    equipment_events_pending: equipmentPairs(input.state.battle_context!).filter(([hero, weapon]) => !existing.has(`${hero}\0${weapon}`)).length};
}
export function updateBattleDraft(context: PreviewContext, draft: BattleDraft, action: BattleDraftAction): BattleDraft {
  const result = structuredClone(draft);
  if (action.type === 'set_target') result.target_instance_id = action.target_instance_id;
  else if (action.type === 'set_hero' || action.type === 'set_support') {
    if (typeof action.selected !== 'boolean') throw new RuleError('battle selection requires a boolean');
    const key = action.type === 'set_hero' ? 'hero_instance_ids' : 'support_instance_ids';
    const pool = action.type === 'set_hero' ? battleTeamOptions(context).hero_instance_ids : battleTeamOptions(context).support_instance_ids;
    if (!pool.includes(action.instance_id)) throw new RuleError('card is not an optional battle selection');
    result[key] = result[key].filter(id => id !== action.instance_id);
    if (action.selected) result[key].push(action.instance_id);
    else if (action.type === 'set_hero') delete result.equipment[action.instance_id];
  } else if (action.type === 'equip' || action.type === 'unequip') {
    for (const hero of Object.keys(result.equipment)) {
      result.equipment[hero] = result.equipment[hero].filter(id => id !== action.weapon_instance_id);
      if (!result.equipment[hero].length) delete result.equipment[hero];
    }
    if (action.type === 'equip') {
      if (!result.hero_instance_ids.includes(action.hero_instance_id)) throw new RuleError('equipment requires a selected hero');
      (result.equipment[action.hero_instance_id] ??= []).push(action.weapon_instance_id);
    }
  } else throw new RuleError('unknown battle draft action');
  battleDraftInput(context, result);
  return result;
}
export function buildSubmitBattleTeamCommand(context: PreviewContext, draft: BattleDraft): SubmitBattleTeamCommand {
  battleDraftInput(context, draft);
  if (!draft.target_instance_id) throw new RuleError('select a battle target before submitting');
  return {type: 'SubmitBattleTeam', player_id: context.player_id, expected_version: context.game_version, draft: structuredClone(draft)};
}
