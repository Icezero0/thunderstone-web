import {matches} from '../catalog/cards.js';
import {activePlayers, type Transition} from '../turn/transaction.js';
import {DeckSearchProgress} from './deck-search.js';

export function resolveRevealCycle(tx: Transition, predicate: any, goal: number,
                                   abilityId: string, responses: any = {}) {
  const order = activePlayers(tx.state), start = order.indexOf(tx.playerId);
  const players = Array.from({length: order.length}, (_, i) => order[(start - i + order.length) % order.length])
    .map(player => responses.redirects?.[player] ?? player)
    .filter(player => !(responses.immune ?? []).includes(player));
  let destroyed = 0;
  const progress = new DeckSearchProgress(tx);
  const revealed: Record<string, string> = {};
  while (destroyed < goal && progress.canContinue(players)) {
    let shown = 0;
    for (const player of players) {
      const draw = tx.playerDrawPile(player);
      if (!draw.length) continue;
      const instance = draw[0], zone = revealed[player] ??= `player:${player}:revealed_cycle_${tx.state.next_event_sequence}`;
      tx.state.zones[zone] ??= [];
      tx.move(instance, `player:${player}:draw`, zone);
      tx.event('cards_revealed', {player_id: player, instance_ids: [instance], ability_id: abilityId});
      shown++;
      if (matches(tx.card(instance), predicate)) {
        tx.destroyCard(instance, abilityId); destroyed++;
        if (destroyed === goal) break;
      } else {
        tx.move(instance, zone, `player:${player}:discard`);
        progress.recordNoProgress(player, instance);
      }
    }
    if (!shown) break;
  }
  if (destroyed < goal) tx.event('effect_search_stopped', {ability_id: abilityId,
    reason: 'no_progress', completed: destroyed, goal});
  for (const [player, zone] of Object.entries(revealed)) {
    for (const instance of [...tx.state.zones[zone]]) tx.move(instance, zone, `player:${player}:discard`);
    delete tx.state.zones[zone];
  }
  tx.event('trap_reveal_cycle_completed', {ability_id: abilityId, destroyed_count: destroyed, goal});
}
