import type {Card} from '../types.js';
import type {SetupState} from './contracts.js';
import {baseHallCapacity, hallCapacity} from './rules.js';
import {SetupError} from './validation.js';
import {validateStateFormat} from '../state-format.js';

export function validateSetupState(state: SetupState, cards: Record<string, Card>): void {
  validateStateFormat(state);
  const seen = new Set<string>();
  for (const [zone, pile] of Object.entries(state.zones)) for (const id of pile) {
    const instance = state.instances[id];
    if (seen.has(id) || !instance) throw new SetupError(`duplicate or unknown instance in ${zone}: ${id}`);
    seen.add(id);
    if (!Object.hasOwn(cards, instance.card_id)) throw new SetupError(`unknown card: ${instance.card_id}`);
    if (zone.startsWith('player:') && instance.owner_player_id !== zone.split(':')[1]) throw new SetupError(`wrong owner in ${zone}: ${id}`);
    if (!zone.startsWith('player:') && instance.owner_player_id !== null) throw new SetupError(`unexpected owner in ${zone}: ${id}`);
  }
  if (seen.size !== Object.keys(state.instances).length) throw new SetupError('some instances have no zone');
  for (const player of state.player_order) {
    const total = ['draw','hand','discard','control'].reduce((sum, part) => sum + state.zones[`player:${player}:${part}`].length, 0);
    if (total !== 12 || state.zones[`player:${player}:hand`].length !== 6) throw new SetupError(`${player}: invalid starter deck`);
  }
  for (const [zone, pile] of Object.entries(state.zones)) {
    if (!zone.startsWith('hall:')) continue;
    const size = hallCapacity(pile.map(id => state.instances[id].card_id), state.active_settings);
    const remaining = state.zones[zone.replace('hall:', 'dungeon:')] ?? [];
    const shortfall = baseHallCapacity(state.active_settings) <= pile.length && pile.length < size
      && !remaining.some(id => cards[state.instances[id].card_id].subcategory === '怪物');
    if (pile.length !== size && !shortfall || pile.some(id => cards[state.instances[id].card_id].subcategory !== '怪物')) throw new SetupError(`${zone}: invalid initial hall`);
  }
}
