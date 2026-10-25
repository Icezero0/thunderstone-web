import {isMonster} from '../catalog/cards.js';
import type {Transition} from '../turn/transaction.js';

/** Capture only a publicly visible monster's printed identity and hall position. */
export function diseaseOrigin(tx: Transition, sourceId?: string): {source_card_id: string; source_hall_zone: string; source_rank: number} | undefined {
  if (!sourceId || !tx.state.instances[sourceId] || !isMonster(tx.card(sourceId))) return undefined;
  const zone = tx.location(sourceId);
  if (!zone?.startsWith('hall:')) return undefined;
  return {source_card_id: tx.printedCard(sourceId).card_id, source_hall_zone: zone,
    source_rank: zone.endsWith(':rank0') ? 0 : tx.state.zones[zone].indexOf(sourceId) + 1};
}
