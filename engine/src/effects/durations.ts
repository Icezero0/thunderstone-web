import type {Transition} from '../turn/transaction.js';

export function mustEnterDungeon(tx: Transition): boolean {
  return Boolean(tx.player.forced_dungeon || (tx.state.continuous_effects ?? []).some((rule: any) =>
    rule.kind === 'force_dungeon' && (rule.scope === 'all' || rule.player_id !== tx.playerId)));
}
export function expireRules(tx: Transition, event: string) {
  const remaining = [];
  for (const rule of tx.state.continuous_effects ?? []) {
    if (rule.player_id === tx.playerId && rule.created_turn < tx.state.turn_number && rule.until === event)
      tx.event('continuous_rule_expired', {rule});
    else remaining.push(rule);
  }
  tx.state.continuous_effects = remaining;
}
