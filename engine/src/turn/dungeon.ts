import {RuleError} from '../types.js';
import {isMonster, stat} from '../catalog/cards.js';
import {reconcileEquipment} from '../battle/equipment.js';
import {canMoveMonster, rememberFronts} from './hall.js';
import {queueSteps} from './workflow.js';
import type {Transition} from './transaction.js';

export function enterDungeon(tx: Transition) {
  tx.state.subphase = tx.state.timing_window = 'DUNGEON_PREPARE';
  tx.state.battle_context = {equipped_weapon_by_hero: {}};
  tx.event('dungeon_hand_revealed', {player_id: tx.playerId, instance_ids: [...tx.zone('hand')]});
  delete tx.player.forced_dungeon;
  queueSteps(tx, [{op: 'event', event: 'DUNGEON_ENTER'}]);
}
export function attackTargets(tx: Transition): string[] {
  return Object.entries(tx.state.zones).filter(([zone]) => zone.startsWith('hall:'))
    .flatMap(([, pile]) => pile as string[])
    .filter(id => isMonster(tx.card(id)) && tx.card(id)['wiki_生命值'] !== '');
}
export function targetLocation(tx: Transition, targetId: string): [string, number] {
  for (const [zone, pile] of Object.entries(tx.state.zones) as [string, string[]][]) if (zone.startsWith('hall:') && pile.includes(targetId))
    return [zone, zone.endsWith(':rank0') ? 0 : pile.indexOf(targetId) + 1];
  throw new RuleError('battle target is not in a dungeon hall');
}
export function declareBattleTarget(tx: Transition, targetId: string) {
  if (!attackTargets(tx).includes(targetId)) throw new RuleError('target must be a monster or guardian in a hall');
  const [hallZone, rank] = targetLocation(tx, targetId), target = tx.card(targetId);
  rememberFronts(tx);
  if (target['wiki_生命值'] === '') throw new RuleError(`target ${target.card_id} has no recorded health`);
  Object.assign(tx.state.battle_context, {target_rank: rank, target_instance_id: targetId, hall_zone: hallZone});
  reconcileEquipment(tx, true);
  const trace = tx.combat(rank, target);
  tx.health(target, rank, targetId);
  if (!trace.can_attack) throw new RuleError("target's attack restrictions are not satisfied");
  tx.event('battle_target_declared', {player_id: tx.playerId, target_instance_id: targetId, hall_zone: hallZone, rank});
  tx.state.subphase = 'BATTLE_EFFECTS'; tx.state.timing_window = 'BATTLE_BEFORE_OUTCOME';
  queueSteps(tx, [{op: 'release_battle_diseases', target_id: targetId, timing: 'before'},
    {op: 'event', event: 'BATTLE_BEFORE_OUTCOME'}, {op: 'resolve_battle_outcome'}]);
}
export function resolveBattleOutcome(tx: Transition) {
  const context = tx.state.battle_context, targetId = context.target_instance_id, target = tx.card(targetId);
  const [, rank] = targetLocation(tx, targetId);
  reconcileEquipment(tx, true);
  const trace = tx.combat(rank, target), health = tx.health(target, rank, targetId);
  const won = trace.can_defeat && trace.effective_attack >= health;
  tx.event('battle_resolved', {target_instance_id: targetId, target_card_id: target.card_id,
    rank, health, outcome: won ? 'win' : 'loss', calculation: trace, card_effects: 'reviewed_ruleset'});
  context.outcome = won ? 'win' : 'loss';
  queueSteps(tx, [{op: 'release_battle_diseases', target_id: targetId, timing: 'after'},
    {op: 'destroy_battle_marks'}, {op: 'battle_departure'}]);
}
export function destroyBattleMarks(tx: Transition) {
  queueSteps(tx, Object.entries(tx.state.instances).filter(([, item]: [string, any]) => item.flags.pending_after_battle_destruction)
    .map(([instance_id]) => ({op: 'destroy_one', instance_id, reason: 'after_battle'})), true);
}
export function battleDeparture(tx: Transition) {
  const context = tx.state.battle_context, targetId = context.target_instance_id, target = tx.card(targetId);
  const [hallZone, rank] = targetLocation(tx, targetId), won = context.outcome === 'win';
  let departed = false;
  if (won) {
    const xp = Number(target.defeat_xp_reward || 0);
    (tx.state.turn_defeated_monsters ??= []).push(targetId);
    tx.state.instances[targetId].owner_player_id = tx.playerId;
    tx.move(targetId, hallZone, `player:${tx.playerId}:discard`);
    tx.player.xp += xp;
    tx.event('monster_defeated', {player_id: tx.playerId, target_instance_id: targetId, xp_gained: xp});
    departed = true;
  } else if (isMonster(target) && target.subcategory !== '守护者' && canMoveMonster(tx, targetId)) {
    const deckZone = hallZone.replace('hall:', 'dungeon:').replace(/:rank0$/, '');
    tx.move(targetId, hallZone, deckZone);
    if (context.retreat_position) {
      const pile = tx.state.zones[deckZone];
      pile.splice(pile.indexOf(targetId), 1);
      pile.splice(Math.min(context.retreat_position - 1, pile.length), 0, targetId);
    }
    tx.event('monster_returned_to_deck', {target_instance_id: targetId, deck_zone: deckZone,
      position: context.retreat_position ?? 'bottom'});
    departed = true;
  } else tx.event('guardian_remained', {target_instance_id: targetId});
  if (departed && rank === 1) (tx.state.hall_fronts ??= {})[hallZone] = null;
  tx.state.subphase = 'BATTLE_AFTER_EFFECTS';
  const steps: Record<string, any>[] = [{op: 'event', event: 'BATTLE_AFTER_OUTCOME', context: {
    source_instance_id: targetId, won, rank}}];
  if (won) steps.push({op: 'event', event: 'MONSTER_DEFEATED', context: {
    source_instance_id: targetId, rank, hall_zone: hallZone}});
  steps.push({op: 'return_borrowed', timing: 'after_battle'});
  if (target.card_id === 'TS-0683') steps.push({op: 'heart_of_doom_outcome', instance_id: targetId, won});
  if (departed && rank !== 0) steps.push({op: 'refill_hall', hall_zone: hallZone,
    acquire_stone: won && rank === 1 && isMonster(target),
    defeated_instance_id: won && isMonster(target) ? targetId : null});
  steps.push({op: 'finish_turn'});
  queueSteps(tx, steps);
}
