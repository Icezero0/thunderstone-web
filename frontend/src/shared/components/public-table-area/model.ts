import {copyDungeonState, copyVillageState} from '../table-areas/model.js';
import {copyPlayers} from '../player-list/model.js';
import type {PublicTableState} from './types.js';

/** Validate the entire snapshot before touching any displayed region. */
export function copyPublicTableState(state: PublicTableState): PublicTableState {
  const dungeon = copyDungeonState(state.dungeon), village = copyVillageState(state.village);
  const players = copyPlayers(state.players ?? []);
  return {dungeon, village, players};
}
