import {RuleError} from '../types.js';
import {isDisease, isMonster} from '../catalog/cards.js';
import type {Transition} from '../turn/transaction.js';
import {gainSteps} from './gain.js';

export function borrow(tx: Transition, item: string, when: string, returnDestroyed: boolean) {
  const original = tx.state.instances[item].owner_player_id;
  if (!tx.state.players[original] || !['after_battle', 'turn_end'].includes(when)) throw new RuleError('invalid borrowed card');
  (tx.state.borrowed_cards ??= {})[item] = {owner_player_id: original, when, return_destroyed: returnDestroyed};
  tx.state.instances[item].owner_player_id = tx.playerId;
  tx.move(item, tx.location(item)!, `player:${tx.playerId}:hand`);
  tx.event('card_borrowed', {instance_id: item, original_owner: original, return_when: when});
}
export function returnBorrowed(tx: Transition, timing: string) {
  for (const [item, obligation] of Object.entries(tx.state.borrowed_cards ?? {}) as [string, any][]) {
    if (obligation.when !== timing) continue;
    delete tx.state.borrowed_cards[item];
    if (!tx.state.instances[item]) continue;
    if (tx.state.instances[item].owner_player_id === null && !obligation.return_destroyed) continue;
    tx.state.instances[item].owner_player_id = obligation.owner_player_id;
    tx.move(item, tx.location(item)!, `player:${obligation.owner_player_id}:discard`);
    tx.event('borrowed_card_returned', {instance_id: item, player_id: obligation.owner_player_id});
  }
}
const KINDS = new Set(['cage', 'emerald', 'sapphire', 'disease_before', 'disease_after']);
export function attach(tx: Transition, item: string, anchor: string, kind: string, owner: string) {
  if (!KINDS.has(kind) || item === anchor) throw new RuleError('invalid attachment');
  const records = (tx.state.attachments ??= {})[anchor] ??= [];
  let destination: string;
  if (kind.startsWith('disease_')) {
    if (!isDisease(tx.card(item)) || !isMonster(tx.card(anchor))) throw new RuleError('disease attachment needs a disease and a monster');
    destination = `attached:${anchor}`;
    tx.state.instances[item].owner_player_id = null;
  } else {
    if (records.length) throw new RuleError('this attachment source is already occupied');
    destination = `player:${owner}:aside`;
    tx.state.instances[anchor].owner_player_id = owner;
    if (kind === 'sapphire') tx.state.instances[anchor].flags.return_at_game_end = true;
    tx.move(anchor, tx.location(anchor)!, destination);
    tx.state.instances[item].owner_player_id = owner;
  }
  tx.move(item, tx.location(item)!, destination);
  records.push({kind, instance_id: item, owner_player_id: owner});
  tx.event('card_attached', {instance_id: item, anchor_instance_id: anchor, attachment_kind: kind, player_id: owner});
}
export function release(tx: Transition, anchor: string, recipient = 'owner', destroyAnchor = true): Record<string, any>[] {
  const records = (tx.state.attachments ??= {})[anchor] ?? [];
  const steps: Record<string, any>[] = [];
  delete tx.state.attachments[anchor];
  delete tx.state.instances[anchor].flags.return_at_game_end;
  for (const record of records) {
    const item = record.instance_id, player = recipient === 'owner' ? record.owner_player_id : tx.playerId;
    const origin = tx.location(item), oldOwner = tx.state.instances[item].owner_player_id;
    tx.state.instances[item].owner_player_id = player;
    tx.move(item, tx.location(item)!, `player:${player}:discard`);
    steps.push(...gainSteps(tx, item, origin, oldOwner, 'attachment_released'));
  }
  if (destroyAnchor) tx.destroyCard(anchor, 'attachment_released');
  else {
    const owner = tx.state.instances[anchor].owner_player_id;
    const origin = tx.location(anchor);
    tx.move(anchor, origin!, `player:${owner}:discard`);
    steps.push(...gainSteps(tx, anchor, origin, owner, 'attachment_released'));
  }
  tx.event('attachment_released', {anchor_instance_id: anchor, recipient, instance_ids: records.map((r: any) => r.instance_id)});
  return steps;
}
/** Destruction removes the saved target reference, not the surviving treasure.
 * An empty sapphire remains set aside and returns alone at game end. */
export function detachDestroyed(tx: Transition, instanceId: string) {
  for (const [anchor, records] of Object.entries(tx.state.attachments ?? {}) as [string, any[]][]) {
    const removed = records.filter(record => record.instance_id === instanceId);
    if (!removed.length) continue;
    tx.state.attachments[anchor] = records.filter(record => record.instance_id !== instanceId);
    if (removed.some(record => record.kind === 'sapphire') && tx.state.instances[anchor])
      tx.state.instances[anchor].flags.return_at_game_end = true;
    tx.event('destroyed_card_detached', {instance_id: instanceId, anchor_instance_id: anchor});
  }
}
export function diseaseGainSteps(tx: Transition, anchor: string, timing: string): Record<string, any>[] {
  const records = (tx.state.attachments ??= {})[anchor] ?? [];
  const steps: Record<string, any>[] = [];
  for (const record of [...records]) if (record.kind === `disease_${timing}`) {
    const item = record.instance_id;
    const origin = tx.location(item), oldOwner = tx.state.instances[item].owner_player_id;
    records.splice(records.indexOf(record), 1);
    tx.state.instances[item].owner_player_id = tx.playerId;
    tx.move(item, tx.location(item)!, `player:${tx.playerId}:discard`);
    steps.push(...gainSteps(tx, item, origin, oldOwner, 'disease_attachment'));
  }
  if (!records.length) {
    delete tx.state.attachments[anchor];
    delete tx.state.zones[`attached:${anchor}`];
  }
  return steps;
}
export function restoreAtGameEnd(tx: Transition) {
  for (const [anchor, records] of Object.entries(tx.state.attachments ?? {}) as [string, any[]][]) {
    if (records.some(record => record.kind === 'sapphire') || tx.state.instances[anchor]?.flags.return_at_game_end)
      release(tx, anchor, 'owner', false);
  }
}
