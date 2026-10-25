import {isMonster, isThunderstone, stat, tags} from '../catalog/cards.js';
import type {Card, Instance, Mechanic} from '../types.js';

export interface ScoringInput {
  state: {player_order: string[]; players: Record<string, {eliminated?: boolean; xp?: number}>; instances: Record<string, Instance>};
  cards: Record<string, Card>; mechanics: Mechanic[];
}
export function scoreGame({state, cards, mechanics}: ScoringInput) {
  const eligible = state.player_order.filter(player => !state.players[player].eliminated);
  const owned = Object.fromEntries(state.player_order.map(player =>
    [player, Object.entries(state.instances).filter(([, item]) => item.owner_player_id === player).map(([id]) => id)]));
  const card = (id: string) => cards[state.instances[id].card_id];
  const monsterCounts = Object.fromEntries(Object.entries(owned).map(([player, pile]) =>
    [player, pile.filter(id => isMonster(card(id))).length]));
  const players = Object.fromEntries(Object.entries(owned).map(([player, pile]) => {
    const stones = pile.filter(id => isThunderstone(card(id))).length;
    const entries = pile.map(id => {
      const definition = card(id);
      let points = stat(definition, 'vp');
      const applied: string[] = [];
      for (const rule of mechanics) if (rule.op === 'scoring' && rule.source_card_id === definition.card_id) {
        const p = rule.params;
        if (p.group !== undefined) points = Math.min(p.maximum ?? 10 ** 6, pile.filter(other => tags(card(other)).includes(p.group!)).length);
        points += (p.other_stones ?? 0) * Math.max(0, stones - 1);
        if (p.fewest_monsters_bonus && Object.entries(monsterCounts).every(([other, count]) =>
          other === player || !eligible.includes(other) || count > monsterCounts[player])) points += p.fewest_monsters_bonus;
        applied.push(rule.id);
      }
      return {instance_id: id, card_id: definition.card_id, victory_points: points, ability_ids: applied};
    });
    const cardPoints = entries.reduce((sum, item) => sum + item.victory_points, 0);
    const experiencePoints = state.players[player].xp ?? 0;
    return [player, {victory_points: cardPoints + experiencePoints, card_victory_points: cardPoints,
      experience_points: experiencePoints, thunderstones: stones, cards: entries}];
  }));
  const maximum = eligible.length ? Math.max(...eligible.map(player => players[player].victory_points)) : 0;
  const winners = eligible.filter(player => players[player].victory_points === maximum);
  const holders = winners.filter(player => players[player].thunderstones > 0);
  return {players, winner_ids: holders.length ? holders : winners,
    tie_break: holders.length && holders.length < winners.length ? 'thunderstone' : null};
}
