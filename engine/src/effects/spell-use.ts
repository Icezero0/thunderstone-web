import {RuleError} from '../types.js';
import {tags} from '../catalog/cards.js';
import type {Transition} from '../turn/transaction.js';

/** A spell is used explicitly, never merely because it is present in the hand. */
export function spellUseOptions(tx: Transition): string[] {
  if (tx.state.chosen_action !== 'dungeon' || tx.state.subphase !== 'DUNGEON_PREPARE' || tx.state.pending_choice) return [];
  return tx.zone('hand').filter(id => tags(tx.card(id)).includes('法术') && !(tx.state.used_cards ?? []).includes(id));
}

export function useSpell(tx: Transition, instanceId: string): void {
  if (!spellUseOptions(tx).includes(instanceId)) throw new RuleError('spell cannot be used now');
  (tx.state.used_cards ??= []).push(instanceId);
  const context = tx.state.battle_context;
  const usedTags = context.used_card_tags ??= [];
  for (const tag of tags(tx.card(instanceId))) if (!usedTags.includes(tag)) usedTags.push(tag);
  (context.spell_cast_counts ??= {})[instanceId] ??= 1;
  tx.event('spell_used', {player_id: tx.playerId, instance_id: instanceId, card_id: tx.card(instanceId).card_id});
}
