import {RuleError} from '../types.js';

export interface AdvanceTurnInput {
  player_order: string[];
  first_player_id: string;
  current_player_id: string;
  players: Record<string, {eliminated?: boolean; extra_turns?: number}>;
  turn_number: number;
  round_number: number;
}
export interface AdvanceTurnResult {
  next_player_id: string;
  turn_number: number;
  round_number: number;
  extra_turn: boolean;
  remaining_extra_turns: number;
}

/** Choose the next surviving player in seating order, honoring a granted extra turn. */
export function advanceTurn(input: AdvanceTurnInput): AdvanceTurnResult {
  const {player_order, first_player_id, current_player_id, players} = input;
  if (!Array.isArray(player_order) || !player_order.length ||
      new Set(player_order).size !== player_order.length ||
      !player_order.includes(first_player_id) || !player_order.includes(current_player_id) ||
      player_order.some(id => !players[id])) throw new RuleError('invalid player order');
  const pivot = player_order.indexOf(first_player_id);
  const order = [...player_order.slice(pivot), ...player_order.slice(0, pivot)];
  const currentIndex = order.indexOf(current_player_id);
  const survivors = new Set(player_order.filter(id => !players[id].eliminated));
  if (!survivors.size) throw new RuleError('cannot pass turn when all players are eliminated');
  const extraTurns = players[current_player_id].extra_turns ?? 0;
  const extraTurn = extraTurns > 0 && !players[current_player_id].eliminated;
  let nextIndex = currentIndex;
  if (!extraTurn) {
    for (let offset = 1; offset <= order.length; offset++) {
      const candidate = (currentIndex + offset) % order.length;
      if (survivors.has(order[candidate])) {nextIndex = candidate; break;}
    }
  }
  return {next_player_id: order[nextIndex], turn_number: input.turn_number + 1,
    round_number: input.round_number + Number(!extraTurn && nextIndex <= currentIndex),
    extra_turn: extraTurn, remaining_extra_turns: extraTurn ? extraTurns - 1 : extraTurns};
}
