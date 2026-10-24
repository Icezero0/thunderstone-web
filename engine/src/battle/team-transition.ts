import {RuleError} from '../types.js';
import type {Transition} from '../turn/transaction.js';
import {queueSteps} from '../turn/workflow.js';
import {declareBattleTarget} from '../turn/dungeon.js';
import {equipWeapon, equipmentPairs} from './equipment.js';
import {projectBattleContext} from './preparation.js';
import {battleDraftInput, createBattleDraft, previewBattleTeam, type BattleDraft} from './team.js';
import {spellUseOptions, useSpell} from '../effects/spell-use.js';

const contextFor = (tx: Transition) => projectBattleContext(tx.state,
  {cards: tx.cards, setup_index: tx.setupIndex}, tx.ruleset);
const pairKey = ([hero, weapon]: [string, string]) => `${hero}\0${weapon}`;

/** Equip events use the normal interruptible workflow before the team is locked. */
export function submitBattleTeam(tx: Transition, draft: BattleDraft) {
  const input = battleDraftInput(contextFor(tx), draft);
  if (!draft.target_instance_id) throw new RuleError('select a battle target before submitting');
  if (!previewBattleTeam(contextFor(tx), draft).calculation.can_attack)
    throw new RuleError("target's attack restrictions are not satisfied");
  const previous = equipmentPairs(tx.state.battle_context), wanted = equipmentPairs(input.state.battle_context!);
  const desired = new Set(wanted.map(pairKey)), existing = new Set(previous.map(pairKey));
  const kept = previous.filter(pair => desired.has(pairKey(pair)));
  tx.state.battle_context.equipped_weapon_by_hero = {};
  for (const [hero, weapon] of kept) (tx.state.battle_context.equipped_weapon_by_hero[hero] ??= []).push(weapon);
  for (const [hero, weapon] of previous.filter(pair => !desired.has(pairKey(pair))))
    tx.event('weapon_unequipped', {hero_instance_id: hero, weapon_instance_id: weapon, reason: 'battle_team_selection'});
  queueSteps(tx, [{op: 'battle_team_equipment', pairs: wanted.filter(pair => !existing.has(pairKey(pair))),
    draft: structuredClone(draft), hand: [...tx.zone('hand')]}]);
}

/** Each new pair resolves its equipment event fully before the next pair. */
export function advanceBattleTeamEquipment(tx: Transition, pairs: [string, string][], draft: BattleDraft, hand: string[]) {
  if (!pairs.length) {finalizeBattleTeam(tx, draft, hand); return;}
  const [hero, weapon] = pairs[0];
  let events: Record<string, any>[] = [];
  try {
    if (!equipmentPairs(tx.state.battle_context).some(pair => pairKey(pair) === pairKey([hero, weapon])))
      events = equipWeapon(tx, hero, weapon, true);
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    tx.event('battle_team_revision_required', {player_id: tx.playerId, reason: error.message});
    return;
  }
  queueSteps(tx, [...events, {op: 'battle_team_equipment', pairs: pairs.slice(1), draft, hand}], true);
}

export function finalizeBattleTeam(tx: Transition, draft: BattleDraft, submittedHand: string[]) {
  // Equipment may draw/destroy cards or request a choice. Resume against the
  // actual new state, returning to preparation if the original team needs edits.
  const context = contextFor(tx);
  const refreshed: BattleDraft = {...createBattleDraft(context), hero_instance_ids: draft.hero_instance_ids,
    support_instance_ids: draft.support_instance_ids, equipment: draft.equipment, target_instance_id: draft.target_instance_id};
  let input;
  try {
    if (submittedHand.length !== tx.zone('hand').length || submittedHand.some(id => !tx.zone('hand').includes(id)))
      throw new RuleError('equipment effects changed the hand');
    const current = new Set(equipmentPairs(tx.state.battle_context).map(pairKey));
    if (equipmentPairs({equipped_weapon_by_hero: draft.equipment}).some(pair => !current.has(pairKey(pair))))
      throw new RuleError('equipment effects changed the selected equipment');
    input = battleDraftInput(context, refreshed);
    if (!previewBattleTeam(context, refreshed).calculation.can_attack) throw new RuleError("target's attack restrictions are not satisfied");
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    tx.event('battle_team_revision_required', {player_id: tx.playerId, reason: error.message});
    return;
  }
  const selected = input.state.battle_context!;
  Object.assign(tx.state.battle_context, {battle_team: selected.battle_team,
    used_card_tags: selected.used_card_tags});
  if (selected.disease_penalty_assignments === undefined) delete tx.state.battle_context.disease_penalty_assignments;
  else tx.state.battle_context.disease_penalty_assignments = selected.disease_penalty_assignments;
  // Local selection becomes authoritative use only at submission. Merely
  // owning a spell, or previewing an unchecked card, never consumes its use.
  const unusedSpells = new Set(spellUseOptions(tx));
  for (const instance of draft.support_instance_ids) if (unusedSpells.has(instance)) useSpell(tx, instance);
  tx.event('battle_team_submitted', {player_id: tx.playerId,
    hero_instance_ids: [...draft.hero_instance_ids], support_instance_ids: [...draft.support_instance_ids],
    equipment: structuredClone(draft.equipment), target_instance_id: draft.target_instance_id});
  declareBattleTarget(tx, draft.target_instance_id!);
}
