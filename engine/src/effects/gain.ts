import {isDisease} from '../catalog/cards.js';
import type {Transition} from '../turn/transaction.js';

/** A player's deck consists of hand, draw pile and discard pile. */
export function inPlayerDeck(zone: string|null|undefined, playerId: string): boolean {
  return ['hand', 'draw', 'discard'].some(part => zone === `player:${playerId}:${part}`);
}

/** Call after a transfer; replacements are resolved by the normal interruptible workflow. */
export function gainSteps(tx: Transition, instanceId: string, origin: string|null|undefined,
                          oldOwner: string|null, reason = 'effect'): Record<string, any>[] {
  const instance = tx.state.instances[instanceId];
  if (!instance) return [];
  const player = instance.owner_player_id, destination = tx.location(instanceId);
  if (typeof player !== 'string' || !tx.state.players[player] || !inPlayerDeck(destination, player) ||
      oldOwner === player && inPlayerDeck(origin, player)) return [];
  tx.event('card_gained', {instance_id: instanceId, card_id: instance.card_id,
    player_id: player, source: origin, destination, reason});
  if (!isDisease(tx.printedCard(instanceId))) return [];
  const part = destination!.slice(`player:${player}:`.length);
  return [{op: 'resolve_disease_gain', gain: {instance_id: instanceId, player_id: player,
    destination: part, draw_top: part === 'draw' && tx.state.zones[destination!][0] === instanceId,
    used_sources: []}}];
}
