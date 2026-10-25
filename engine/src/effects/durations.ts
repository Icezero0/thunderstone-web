import type {Transition} from '../turn/transaction.js';
import type {CalculationState} from '../types.js';

/** Lifetime belongs to match state, independently of a battle team or its source card. */
export function activeGlobalRules(state: CalculationState, kind: string, playerId = state.active_player_id) {
  return (state.continuous_effects ?? []).filter(rule => rule.kind === kind
    && (rule.scope === 'all' || rule.player_id !== playerId));
}

export function mustEnterDungeon(tx: Transition): boolean {
  return Boolean(tx.player.forced_dungeon || activeGlobalRules(tx.evaluation().state, 'force_dungeon').length);
}
export function expireRules(tx: Transition, event: string) {
  const remaining = [];
  for (const rule of tx.state.continuous_effects ?? []) {
    // "Your next turn" excludes both the creation turn and other players' turns.
    if (rule.player_id === tx.playerId && rule.created_turn < tx.state.turn_number && rule.until === event)
      tx.event('continuous_rule_expired', {rule});
    else remaining.push(rule);
  }
  tx.state.continuous_effects = remaining;
}
