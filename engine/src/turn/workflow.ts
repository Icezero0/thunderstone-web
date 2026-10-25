import {RuleError} from '../types.js';
import {dispatchEvent, runEffect, available} from '../effects/execute.js';
import {offerDestroy} from '../effects/responses.js';
import {advanceGain} from '../effects/disease-transition.js';
import {returnBorrowed, diseaseGainSteps} from '../effects/ownership.js';
import {expireRules, mustEnterDungeon} from '../effects/durations.js';
import {enterVillage, finishAbilities} from './village.js';
import {enterDungeon, awaitBattleDeclaration, startCommittedBattle, resolveBattleOutcome, destroyBattleMarks, battleDeparture} from './dungeon.js';
import {hallRankCount, refillStep} from './hall.js';
import {resolveHeartOutcome} from './settlement.js';
import type {Transition} from './transaction.js';
import {advanceBattleTeamEquipment} from '../battle/team-transition.js';

export function queueSteps(tx: Transition, steps: Record<string, any>[], front = false) {
  const queue = tx.state.workflow_steps ??= [];
  if (front) queue.unshift(...steps); else queue.push(...steps);
  if (!tx.workflowRunning) runSteps(tx);
}
export function runSteps(tx: Transition) {
  tx.workflowRunning = true;
  try {
    let count = 0;
    while (tx.state.workflow_steps?.length && tx.state.pending_choice === null) {
      if (++count > 4096) throw new RuleError('engine workflow step limit reached');
      const step = tx.state.workflow_steps.shift(), op = step.op;
      switch (op) {
        case 'event': {
          const previous = tx.state.event_context;
          tx.state.event_context = step.context ?? {};
          tx.state.workflow_steps.unshift({op: 'restore_event_context', value: previous ?? null,
            event: tx.state.resolving_event ?? null});
          tx.state.resolving_event = step.event;
          tx.event('rule_timing', {event: step.event, context: step.context ?? {}});
          if (step.event === 'TURN_START') {
            expireRules(tx, 'owner_next_turn_start');
            tx.state.started_turn = tx.state.turn_number;
            tx.event('TURN_WILL_START', {player_id: tx.playerId});
          }
          if (!dispatchEvent(tx, step.event)) tx.state.effect_resume = 'workflow';
          break;
        }
        case 'restore_event_context':
          if (step.value === null) delete tx.state.event_context;
          else tx.state.event_context = step.value;
          if (step.event == null) delete tx.state.resolving_event;
          else tx.state.resolving_event = step.event;
          break;
        case 'refill_hall': refillStep(tx, step); break;
        case 'dispose_trap': {
          const instance = step.instance_id, hall = step.hall_zone;
          delete tx.state.trap_responses?.[instance];
          if (tx.location(instance) === hall) {
            const rank = tx.state.zones[hall].indexOf(instance) + 1;
            tx.destroyCard(instance, 'trap_resolved');
            tx.event('trap_removed', {instance_id: instance, hall_zone: hall, rank, hall_rank_count: hallRankCount(tx, hall)});
          }
          break;
        }
        case 'dispose_revealed': {
          const instance = step.instance_id;
          delete tx.state.trap_responses?.[instance];
          if (Object.entries(tx.state.zones).some(([zone, pile]) => zone.startsWith('revealed:') && (pile as string[]).includes(instance)))
            tx.destroyCard(instance, 'trap_resolved');
          break;
        }
        case 'guardian_to_rank0': {
          const hall = step.hall_zone, instance = step.instance_id;
          if (tx.state.zones[hall].includes(instance)) {
            tx.move(instance, hall, `${hall}:rank0`);
            tx.event('guardian_entered_rank_0', {instance_id: instance, hall_zone: hall, hall_rank_count: hallRankCount(tx, hall)});
          }
          break;
        }
        case 'await_turn_end': tx.awaitTurnEnd(); break;
        case 'pass_turn': tx.passTurn(); break;
        case 'turn_will_end':
          tx.event('TURN_WILL_END', {player_id: tx.playerId});
          tx.state.subphase = 'TURN_END_EFFECTS'; tx.state.timing_window = 'TURN_WILL_END';
          queueSteps(tx, [{op: 'event', event: 'TURN_WILL_END'}], true); break;
        case 'cleanup_turn': tx.cleanupTurn(); break;
        case 'resolve_battle_outcome': resolveBattleOutcome(tx); break;
        case 'start_committed_battle': startCommittedBattle(tx, step.target_id); break;
        case 'await_battle_declaration': awaitBattleDeclaration(tx); break;
        case 'battle_team_equipment': advanceBattleTeamEquipment(tx, step.pairs, step.draft, step.hand); break;
        case 'release_battle_diseases': queueSteps(tx, diseaseGainSteps(tx, step.target_id, step.timing), true); break;
        case 'destroy_battle_marks': destroyBattleMarks(tx, step.processed); break;
        case 'destroy_one':
          if (!tx.state.instances[step.instance_id]?.flags.pending_after_battle_destruction) break;
          if (offerDestroy(tx, step.instance_id, step.reason)) tx.state.effect_resume = 'workflow';
          else tx.destroyCard(step.instance_id, step.reason);
          break;
        case 'battle_departure': battleDeparture(tx); break;
        case 'return_borrowed': returnBorrowed(tx, step.timing); break;
        case 'heart_of_doom_outcome': resolveHeartOutcome(tx, step.instance_id, step.won); break;
        case 'gain_disease': tx.takeDisease(step.destination ?? 'discard', step.player_id, step.source_instance_id); break;
        case 'resolve_disease_gain': advanceGain(tx, step.gain); break;
        case 'effect_continuation':
          if (!runEffect(tx, step.ability_id, step.source_instance_id, step.stack)) tx.state.effect_resume = 'workflow';
          break;
        case 'village_entry_done': if (!available(tx).length) finishAbilities(tx); break;
        case 'enter_action': {
          const action = step.action;
          if (mustEnterDungeon(tx) && action !== 'dungeon') throw new RuleError('this player must enter the dungeon');
          tx.event('TURN_STARTED', {player_id: tx.playerId});
          tx.state.chosen_action = action;
          tx.event('ACTION_WILL_ENTER', {player_id: tx.playerId, action});
          if (action === 'village') enterVillage(tx);
          else if (action === 'dungeon') enterDungeon(tx);
          else tx.state.subphase = tx.state.timing_window = 'REST';
          tx.event('ACTION_ENTERED', {player_id: tx.playerId, action});
          break;
        }
        default: throw new RuleError(`unknown workflow operation: ${op}`);
      }
      if (tx.state.phase === 'SETTLING') {tx.state.workflow_steps = []; break;}
    }
  } finally {tx.workflowRunning = false;}
}
