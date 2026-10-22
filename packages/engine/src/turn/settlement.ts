import {scoreGame} from '../scoring/score.js';
import {returnBorrowed, restoreAtGameEnd} from '../effects/ownership.js';
import {activePlayers, type Transition} from './transaction.js';

export function settleGame(tx: Transition, reason: string, details: Record<string, any> = {}) {
  if (tx.state.phase === 'SETTLING') return;
  Object.assign(tx.state, {phase: 'SETTLING', subphase: 'GAME_END', timing_window: 'GAME_END',
    pending_choice: null, resolution_frames: [], workflow_steps: []});
  delete tx.state.effect_resume;
  tx.state.end_condition = {reason, ...details, turn_number: tx.state.turn_number};
  tx.event('game_end_triggered', tx.state.end_condition);
  returnBorrowed(tx, 'after_battle'); returnBorrowed(tx, 'turn_end');
  restoreAtGameEnd(tx);
  tx.state.result = scoreGame({state: tx.state as any, cards: tx.cards, mechanics: tx.ruleset.mechanics});
  tx.event('game_scored', {result: tx.state.result});
}
export function resolveHeartOutcome(tx: Transition, instanceId: string, won: boolean) {
  if (won) {settleGame(tx, 'heart_of_doom_defeated', {instance_id: instanceId, defeated_by: tx.playerId}); return;}
  if (!tx.state.battle_context?.lose_on_battle_loss) return;
  const player = tx.playerId;
  Object.assign(tx.player, {eliminated: true, elimination_reason: 'heart_of_doom_battle_lost',
    eliminated_on_turn: tx.state.turn_number});
  tx.state.scheduled_effects = tx.state.scheduled_effects.filter((item: any) => item.player_id !== player);
  tx.event('player_eliminated', {player_id: player, reason: 'heart_of_doom_battle_lost', instance_id: instanceId});
  if (!activePlayers(tx.state).length) settleGame(tx, 'all_players_eliminated', {instance_id: instanceId});
}
