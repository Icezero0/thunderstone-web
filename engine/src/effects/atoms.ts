import {RuleError} from '../types.js';
import {matches} from '../catalog/cards.js';
import {EffectEvaluation} from './evaluator.js';
import {evaluateCost} from './costs.js';
import {planCardModifier, planMonsterHealthModifier} from './modifiers.js';
import {applyResourceEffect, type ResourceOp} from './resources.js';
import {grantTurnBuff} from '../turn/buffs.js';
import {attach} from './ownership.js';
import {destroyMatching, destroyPurchased} from './supply.js';
import {shuffleDestroyedTraps} from '../turn/hall.js';
import {dungeonZone} from './choice-transition.js';
import {reconcileEquipment, equipmentPairs} from '../battle/equipment.js';
import type {Transition} from '../turn/transaction.js';

const evaluator = (tx: Transition) => new EffectEvaluation(tx.evaluation());
const expr = (tx: Transition, spec: any, bindings: any) => evaluator(tx).expression(spec, bindings);
const query = (tx: Transition, spec: any, bindings: any) => evaluator(tx).query(spec, bindings);
export function bound(bindings: Record<string, any>, target: {var: string}): string {
  const instance = bindings[target.var];
  if (typeof instance !== 'string') throw new RuleError(`unbound card target: ${target.var}`);
  return instance;
}
export function atom(tx: Transition, node: any, initialBindings: Record<string, any>, abilityId: string): void {
  const op = node.op;
  let bindings = initialBindings, subject = bindings._subject ?? tx.playerId;
  if (node.as_owner) {
    subject = tx.state.instances[bound(bindings, node.target)].owner_player_id;
    bindings = {...bindings, _subject: subject};
  }
  const player = tx.state.players[subject];
  switch (op) {
    case 'draw': {
      const count = expr(tx, node.count, bindings);
      if (!(0 <= count && count <= 100)) throw new RuleError('invalid effect draw count');
      const taken = tx.draw(count, subject);
      tx.event('effect_draw', {ability_id: abilityId, player_id: subject, requested: count, instance_ids: taken});
      return;
    }
    case 'show': case 'show_hand': {
      const shown = op === 'show_hand' ? [...tx.zone('hand', subject)] : [bound(bindings, node.target)];
      if (shown.some(item => !tx.zone('hand', subject).includes(item))) throw new RuleError("shown card is not in the subject's hand");
      tx.event('cards_shown', {ability_id: abilityId, player_id: subject, instance_ids: shown}); return;
    }
    case 'destroy': case 'discard': {
      const cost = evaluateCost({evaluation: tx.evaluation(), cost: node, bindings});
      if (!cost.payable) throw new RuleError(`effect target cannot be ${op}ed now`);
      const instance = cost.instance_id!, location = cost.location!, cardId = tx.state.instances[instance].card_id;
      let destination: string;
      if (op === 'destroy') destination = tx.destroyCard(instance, abilityId).destination;
      else {destination = `player:${subject}:discard`; tx.move(instance, location, destination);}
      tx.event('effect_card_removed', {ability_id: abilityId, op, instance_id: instance,
        card_id: cardId, source: location, destination}); return;
    }
    case 'gain_xp': case 'spend_xp': case 'lose_xp': case 'mod_gold': case 'grant_buy':
    case 'mod_attack': case 'mod_magic_attack': case 'mod_light': {
      const amount = expr(tx, node.amount, bindings);
      const result = applyResourceEffect({op: op as ResourceOp, amount, subject_id: subject,
        active_player_id: tx.playerId, subject_xp: player.xp, active_gold: tx.player.temporary_gold,
        active_purchases: tx.player.purchases_remaining, chosen_action: tx.state.chosen_action,
        battle_context: tx.state.battle_context, source_instance_id: bindings.source ?? null});
      if ('battle_context' in result) tx.state.battle_context = result.battle_context;
      else tx.state.players[result.player_id][result.field] = result.value;
      tx.event('effect_resource_changed', {ability_id: abilityId, op, player_id: subject, amount}); return;
    }
    case 'mod_card': {
      const patch = planCardModifier({evaluation: tx.evaluation(), node, bindings, subphase: tx.state.subphase});
      const context = tx.state.battle_context;
      ((context.card_modifiers ??= {})[patch.instance_id] ??= {})[patch.field] = patch.value;
      tx.event('effect_card_modified', {ability_id: abilityId, instance_id: patch.instance_id,
        stat: patch.field, amount: patch.amount});
      if (patch.reconcile_equipment) reconcileEquipment(tx, tx.state.subphase === 'BATTLE_EFFECTS');
      return;
    }
    case 'mod_monster_health': {
      const patch = planMonsterHealthModifier({evaluation: tx.evaluation(), node, bindings});
      (tx.state.battle_context.monster_health_modifiers ??= {})[patch.instance_id] = patch.value;
      return;
    }
    case 'collect': case 'clear_collection': {
      const key = `${bindings._ability_id ?? 'None'}:${bindings.source ?? 'None'}:${node.collection}`;
      const collections = tx.state.effect_collections ??= {};
      if (op === 'clear_collection') collections[key] = [];
      else (collections[key] ??= []).push(...query(tx, node.query, bindings));
      return;
    }
    case 'add_global_rule': {
      const rule = Object.fromEntries(['kind', 'until', 'scope', 'amount'].map(key => [key, node[key]]));
      Object.assign(rule, {player_id: tx.playerId, source_instance_id: bindings.source, created_turn: tx.state.turn_number});
      tx.state.continuous_effects.push(rule);
      tx.event('continuous_rule_added', {rule, ability_id: abilityId}); return;
    }
    case 'copy_hero': {
      const target = bound(bindings, node.target), other = bound(bindings, node.other);
      if (target === other || !tx.zone('hand').includes(target) || !tx.zone('hand').includes(other) ||
          tx.card(target).card_id !== 'TS-0001' || !tx.card(other).tags.split('|').includes('英雄'))
        throw new RuleError('hero copying requires a militia and a different hand hero');
      const cardIds = [tx.card(other).card_id, ...(tx.state.copied_heroes?.[other]?.card_ids ?? [])];
      (tx.state.copied_heroes ??= {})[target] = {card_ids: [...new Set(cardIds)],
        preserve_attack: node.preserve_attack, full_card: node.full_card ?? false};
      tx.event('hero_abilities_copied', {instance_id: target, template_instance_id: other,
        preserve_attack: node.preserve_attack}); return;
    }
    case 'remove_listener':
      tx.state.registered_triggers = tx.state.registered_triggers.filter((item: any) =>
        item.ability_id !== abilityId || item.source_instance_id !== bindings.source);
      return;
    case 'attach_card': attach(tx, bound(bindings, node.target), bound(bindings, node.anchor), node.kind, subject); return;
    case 'grant_basic_buy': tx.player.extra_basic_purchases = (tx.player.extra_basic_purchases ?? 0) + 1; return;
    case 'grant_extra_turn':
      tx.player.extra_turns = (tx.player.extra_turns ?? 0) + 1;
      tx.event('extra_turn_granted', {player_id: tx.playerId, ability_id: abilityId}); return;
    case 'shuffle_destroyed_traps': shuffleDestroyedTraps(tx, bindings, dungeonZone); return;
    case 'destroy_matching_supply': {
      const count = expr(tx, node.count, bindings);
      if (!(0 <= count && count <= 100)) throw new RuleError('invalid matching supply destruction count');
      destroyMatching(tx, bound(bindings, node.target), count, node.family ?? false, node.from_bottom ?? false, abilityId); return;
    }
    case 'destroy_purchased_supply': destroyPurchased(tx, abilityId); return;
    case 'destroy_basic_supply': {
      if (!tx.state.supply_rules.basic_card_ids.includes(node.card_id)) throw new RuleError('not an infinite basic supply');
      const count = expr(tx, node.count, bindings);
      if (!(0 <= count && count <= 100)) throw new RuleError('invalid basic supply destruction count');
      tx.event('infinite_supply_destruction', {card_id: node.card_id, count, ability_id: abilityId}); return;
    }
    case 'random_destroy': {
      const hand = tx.zone('hand', subject);
      if (hand.length) {
        const victim = hand[tx.rng.randbelow(hand.length)];
        tx.event('cards_shown', {player_id: subject, instance_ids: [victim], ability_id: abilityId});
        if (!matches(tx.card(victim), node.filter)) tx.destroyCard(victim, abilityId);
      }
      return;
    }
    case 'convert_card_magic':
      (tx.state.battle_context.convert_card_magic ??= []).push(bound(bindings, node.target)); return;
    case 'grant_turn_buff': {
      const instance = bound(bindings, node.target);
      const result = grantTurnBuff({instance: tx.state.instances[instance] ?? null,
        card: tx.state.instances[instance] ? tx.card(instance) : null,
        in_active_hand: tx.zone('hand').includes(instance), turn_number: tx.state.turn_number,
        buff: node.buff, ability_id: abilityId, source_instance_id: bindings.source});
      if (result.granted) {
        tx.state.instances[instance].flags.turn_buffs = result.turn_buffs;
        tx.event('hero_turn_buff_granted', {instance_id: instance, ...result.granted});
      }
      return;
    }
    case 'mark_destroy': case 'exclude_combat': {
      const instance = bound(bindings, node.target);
      if (!tx.state.instances[instance] || tx.location(instance) !== `player:${subject}:hand`)
        throw new RuleError("battle effect needs a card in the affected player's hand");
      if (op === 'mark_destroy') tx.state.instances[instance].flags[
        (node.when ?? 'after_battle') === 'after_battle' ? 'pending_after_battle_destruction' : 'pending_turn_end_destruction'] = true;
      else (tx.state.battle_context.excluded_participants ??= []).push(instance);
      tx.event('effect_card_marked', {ability_id: abilityId, instance_id: instance,
        mark: op, timing: node.when ?? 'after_battle'}); return;
    }
    case 'move': {
      const instance = bound(bindings, node.target), location = tx.location(instance);
      if (!location) throw new RuleError('moved card has no location');
      const recipient = node.recipient ?? 'subject';
      if (recipient === 'active') subject = tx.playerId;
      else if (recipient === 'owner') subject = tx.state.instances[instance].owner_player_id;
      else if (typeof recipient === 'object') subject = bindings[recipient.var];
      if (!tx.state.players[subject]) throw new RuleError('invalid card recipient');
      const part = node.destination === 'draw_top' ? 'draw' : node.destination;
      const destination = `player:${subject}:${part}`;
      tx.state.instances[instance].owner_player_id = subject;
      tx.state.zones[destination] ??= [];
      tx.move(instance, location, destination);
      if (node.destination === 'draw_top') {
        const pile = tx.state.zones[destination]; pile.splice(pile.indexOf(instance), 1); pile.unshift(instance);
      }
      return;
    }
    case 'destroy_supply': {
      const instance = bound(bindings, node.target), zone = tx.location(instance);
      if (!zone?.startsWith('village_supply:') && !zone?.startsWith('hero_supply:')) throw new RuleError('destroy_supply needs a supply card');
      const count = expr(tx, node.count, bindings);
      if (!(0 <= count && count <= 10000)) throw new RuleError('invalid supply destruction count');
      const pile = tx.state.zones[zone!], victims = (node.from_bottom ? [...pile].reverse() : [...pile]).slice(0, count);
      for (const victim of victims) tx.destroyCard(victim, abilityId);
      return;
    }
    case 'random_discard': {
      const count = expr(tx, node.count, bindings);
      if (!(0 <= count && count <= 100)) throw new RuleError('invalid random discard count');
      const actual = Math.min(count, tx.zone('hand', subject).length);
      for (let i = 0; i < actual; i++) {
        const hand = tx.zone('hand', subject), item = hand[tx.rng.randbelow(hand.length)];
        tx.move(item, `player:${subject}:hand`, `player:${subject}:discard`);
      }
      return;
    }
    case 'mod_next_hand': case 'mod_next_gold': case 'force_dungeon': {
      const key = op === 'mod_next_hand' ? 'next_hand_bonus' : op === 'mod_next_gold' ? 'turn_gold_adjustment' : 'forced_dungeon';
      const amount = op === 'force_dungeon' ? 1 : expr(tx, node.amount, bindings);
      player[key] = (player[key] ?? 0) + amount;
      tx.event('effect_player_rule_changed', {player_id: subject, rule: key, amount, ability_id: abilityId}); return;
    }
    case 'set_battle_flag':
      if (!tx.state.battle_context) throw new RuleError('battle flag needs dungeon preparation');
      tx.state.battle_context[node.flag] = node.value; return;
    case 'scale_damage': {
      const context = tx.state.battle_context, divisor = node.divisor;
      if (!context || !Number.isSafeInteger(divisor) || divisor < 1 || divisor > 100)
        throw new RuleError('invalid battle damage divisor');
      const combined = (context.damage_divisor ?? 1) * divisor;
      if (!Number.isSafeInteger(combined)) throw new RuleError('battle damage divisor exceeds numeric bounds');
      context.damage_divisor = combined;
      tx.event('effect_damage_scaled', {ability_id: abilityId, divisor, combined_divisor: combined});
      return;
    }
    case 'set_retreat_position': {
      const position = expr(tx, node.amount, bindings);
      if (!tx.state.battle_context || !(1 <= position && position <= 100)) throw new RuleError('invalid monster retreat position');
      tx.state.battle_context.retreat_position = position; return;
    }
    default: throw new RuleError(`unhandled atom: ${op}`);
  }
}
