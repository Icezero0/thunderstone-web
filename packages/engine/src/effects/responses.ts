import {RuleError} from '../types.js';
import {isHero} from '../catalog/cards.js';
import {destructionReplacement} from '../turn/buffs.js';
import {activePlayers, type Transition} from '../turn/transaction.js';
import {runEffect, sourceMatches} from './execute.js';

export function hasGlobalWork(node: any): boolean {
  if (Array.isArray(node)) return node.some(hasGlobalWork);
  return node && typeof node === 'object' &&
    (['for_players', 'reveal_cycle', 'clear_collection', 'collect'].includes(node.op) || node.zone === 'collection' ||
      Object.values(node).some(value => typeof value === 'object' && hasGlobalWork(value)));
}
function sources(tx: Transition, plan: any, recipient: string): Record<string, any>[] {
  const options = [];
  for (const rule of tx.ruleset.mechanics) {
    if (rule.op !== 'response') continue;
    const action = rule.params.action;
    const valid = plan.mode === 'destroy' ? action === 'prevent_destroy' && recipient === tx.playerId :
      plan.trap ? action === 'ignore_trap' || action === 'redirect_trap' && recipient === tx.playerId :
      plan.battle ? action === 'ignore_battle' && recipient === tx.playerId :
      action === 'redirect_opponent' && recipient !== tx.playerId && plan.opponent_effect;
    if (!valid) continue;
    const zone = action === 'ignore_battle' ? 'control' : 'hand';
    for (const source of tx.zone(zone, recipient)) {
      if (!sourceMatches(tx, source, rule.source_card_id) || plan.used_sources.includes(source) ||
          rule.params.once_per_turn && tx.state.ability_uses?.[`${source}:${rule.id}`] === tx.state.turn_number ||
          action === 'redirect_trap' && activePlayers(tx.state).length < 2) continue;
      options.push({source_instance_id: source, ability_id: rule.id, action});
    }
  }
  return options;
}
function pause(tx: Transition, plan: any, stage: string, options: any[]) {
  tx.state.pending_choice = {kind: 'effect_response', player_id: plan.recipient,
    ability_id: plan.ability_id ?? null, stage, options: structuredClone(options)};
  tx.state.resolution_frames = [{kind: 'response', plan: structuredClone(plan)}];
  tx.event('response_requested', {player_id: plan.recipient, stage, options,
    ability_id: plan.ability_id ?? null, response_mode: plan.mode});
}
export function offerEffect(tx: Transition, body: any, bindings: any, stack: any[],
                            abilityId: string, sourceId: string, subjectWindow = false): boolean {
  const ability = tx.ruleset.abilities.find(item => item.id === abilityId)!;
  const trap = ability.event === 'TRAP_REVEALED';
  const battle = ability.source_zone === 'battle_target' && ability.event === 'BATTLE_BEFORE_OUTCOME';
  const owner = tx.state.instances[sourceId]?.owner_player_id ?? null;
  const saved = trap ? tx.state.trap_responses?.[sourceId] ?? {} : {};
  const plan = {mode: 'effect', trap, battle,
    opponent_effect: owner === tx.playerId && ['active_hand', 'active_control'].includes(ability.source_zone),
    queue: subjectWindow ? [bindings._subject ?? tx.playerId] : trap || battle ?
      hasGlobalWork(body) ? activePlayers(tx.state) : [tx.playerId] : [],
    visited: [], used_sources: [...(saved.used_sources ?? [])], immune: [...(saved.immune ?? [])],
    redirects: {...(saved.redirects ?? {})}, body, bindings, stack: structuredClone(stack),
    ability_id: abilityId, source_id: sourceId};
  return advance(tx, plan);
}
export function offerDestroy(tx: Transition, item: string, reason: string,
                             stack: any[]|null = null, bindings: any = null,
                             abilityId: string|null = null, sourceId: string|null = null): boolean {
  if (!tx.state.instances[item] || !isHero(tx.card(item)) || tx.state.instances[item].owner_player_id !== tx.playerId ||
      !['BATTLE_EFFECTS', 'BATTLE_AFTER_EFFECTS'].includes(tx.state.subphase) ||
      destructionReplacement(tx.state.instances[item], tx.card(item), tx.state.turn_number)) return false;
  const plan = {mode: 'destroy', trap: false, battle: true, opponent_effect: false,
    queue: [tx.playerId], visited: [], used_sources: [], immune: [], redirects: {},
    item, reason, prevented: false, stack: structuredClone(stack), bindings,
    ability_id: abilityId, source_id: sourceId};
  if (!sources(tx, plan, tx.playerId).length) return false;
  advance(tx, plan);
  return true;
}
function complete(tx: Transition, plan: any): boolean {
  if (plan.mode === 'effect') {
    if (plan.trap) (tx.state.trap_responses ??= {})[plan.source_id] =
      Object.fromEntries(['used_sources', 'immune', 'redirects'].map(key => [key, structuredClone(plan[key])]));
    const bindings = {...plan.bindings, _responses: {immune: plan.immune, redirects: plan.redirects}};
    const subject = bindings._subject ?? tx.playerId;
    bindings._subject = plan.redirects[subject] ?? subject;
    const stack = structuredClone(plan.stack);
    stack.push({node: plan.body, bindings});
    return runEffect(tx, plan.ability_id, plan.source_id, stack);
  }
  const item = plan.item;
  if (plan.prevented) {
    delete tx.state.instances[item].flags.pending_after_battle_destruction;
    delete tx.state.instances[item].flags.pending_turn_end_destruction;
    tx.event('hero_destruction_prevented', {instance_id: item});
  } else {
    const result = tx.destroyCard(item, plan.reason);
    if (plan.stack !== null) tx.event('effect_card_removed', {ability_id: plan.ability_id, op: 'destroy', ...result});
  }
  return plan.stack !== null ? runEffect(tx, plan.ability_id, plan.source_id, plan.stack) : true;
}
function advance(tx: Transition, plan: any): boolean {
  while (plan.queue.length) {
    const recipient = plan.queue.shift();
    if (plan.visited.includes(recipient)) continue;
    plan.recipient = recipient; plan.visited.push(recipient);
    if (plan.immune.includes(recipient) || plan.redirects[recipient]) continue;
    const options = sources(tx, plan, recipient);
    if (options.length) {pause(tx, plan, 'source', options); return false;}
  }
  return complete(tx, plan);
}
export function resolveResponse(tx: Transition, sourceId: string|null = null, recipientId: string|null = null): boolean {
  const choice = tx.state.pending_choice, frames = tx.state.resolution_frames;
  if (choice?.kind !== 'effect_response') throw new RuleError('no response is pending');
  if (frames.length !== 1 || frames[0].kind !== 'response') throw new RuleError('invalid response continuation');
  const plan = structuredClone(frames[0].plan);
  if (plan.recipient !== choice.player_id || plan.ability_id !== choice.ability_id) throw new RuleError('invalid response continuation recipient');
  if (plan.ability_id) {
    const ability = tx.ruleset.abilities.find(item => item.id === plan.ability_id);
    if (!ability || !sourceMatches(tx, plan.source_id, ability.source_card_id)) throw new RuleError('invalid response continuation source');
  }
  if (choice.stage === 'recipient') {
    if (sourceId !== null || !choice.options.includes(recipientId) || !activePlayers(tx.state).includes(recipientId!))
      throw new RuleError('invalid redirected recipient');
    plan.redirects[plan.recipient] = recipientId; plan.queue.push(recipientId);
  } else if (sourceId !== null) {
    const option = sources(tx, plan, plan.recipient).find(item => item.source_instance_id === sourceId);
    if (!option || recipientId !== null) throw new RuleError('response source is no longer available');
    plan.used_sources.push(sourceId);
    (tx.state.ability_uses ??= {})[`${sourceId}:${option.ability_id}`] = tx.state.turn_number;
    tx.event('response_used', {player_id: plan.recipient, ...option});
    const action = option.action;
    if (['ignore_trap', 'redirect_opponent', 'redirect_trap'].includes(action))
      tx.event('cards_shown', {player_id: plan.recipient, instance_ids: [sourceId], ability_id: option.ability_id});
    if (['ignore_battle', 'prevent_destroy'].includes(action)) tx.destroyCard(sourceId, option.ability_id);
    if (action.startsWith('ignore_')) plan.immune.push(plan.recipient);
    else if (action === 'redirect_opponent') plan.redirects[plan.recipient] = tx.playerId;
    else if (action === 'prevent_destroy') plan.prevented = true;
    else {
      const targets = activePlayers(tx.state).filter(player => player !== plan.recipient);
      tx.state.pending_choice = null; tx.state.resolution_frames = [];
      pause(tx, plan, 'recipient', targets);
      return false;
    }
  } else if (recipientId !== null) throw new RuleError('choose a source before redirecting');
  tx.state.pending_choice = null; tx.state.resolution_frames = [];
  tx.event('response_resolved', {player_id: choice.player_id,
    declined: sourceId === null && choice.stage === 'source'});
  return advance(tx, plan);
}
