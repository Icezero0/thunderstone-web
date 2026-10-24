import {RuleError} from '../types.js';
import {matches} from '../catalog/cards.js';
import {EffectEvaluation} from './evaluator.js';
import {availableActivations, canReuseSpell, reusableAbilityIds} from './availability.js';
import {planEventDispatch, resolveEventOrder} from './events.js';
import {evaluateCost} from './costs.js';
import {activePlayers, type Transition} from '../turn/transaction.js';
import {queueSteps} from '../turn/workflow.js';
import {reconcileEquipment, equipmentPairs} from '../battle/equipment.js';
import {equipWeapon} from '../battle/equipment.js';
import {borrow, release} from './ownership.js';
import {offerPurchase} from './purchase-transition.js';
import {upgradeOptions} from '../turn/village.js';
import {relocate, swapHall, exchangeHall, shuffleHallTop} from '../turn/hall.js';
import {offerEffect, offerDestroy, hasGlobalWork} from './responses.js';
import {pause, valueOptions, valueBindings, reorderCards, dungeonZone} from './choice-transition.js';
import {atom, bound} from './atoms.js';
import {resolveRevealCycle} from './reveal-cycle.js';
import {immuneToSource} from './immunity.js';
import {DeckSearchProgress} from './deck-search.js';
import {gainSteps} from './gain.js';

const evaluation = (tx: Transition) => new EffectEvaluation(tx.evaluation());
const expression = (tx: Transition, spec: any, bindings: any) => evaluation(tx).expression(spec, bindings);
const query = (tx: Transition, spec: any, bindings: any) => evaluation(tx).query(spec, bindings);
const condition = (tx: Transition, spec: any, bindings: any) => evaluation(tx).condition(spec, bindings);
export {atom};
export function sourceMatches(tx: Transition, instance: string, cardId: string): boolean {
  return Boolean(tx.state.instances[instance] && (tx.card(instance).card_id === cardId ||
    (tx.state.copied_heroes?.[instance]?.card_ids ?? []).includes(cardId)));
}
export function available(tx: Transition) {
  return availableActivations({evaluation: tx.evaluation(), abilities: tx.ruleset.abilities,
    turn_number: tx.state.turn_number, ability_uses: tx.state.ability_uses ?? {}});
}
export function abilityFrames(abilityId: string, sourceId: string, body: any, bindings: Record<string, any>) {
  const bound = {...bindings, source: sourceId, _ability_id: abilityId};
  return [{node: {op: '_ability_end'}, bindings: bound},
    {node: {op: '_offer_effect', body}, bindings: bound}];
}
export function activate(tx: Transition, abilityId: string, sourceId: string): boolean {
  const ability = tx.ruleset.abilities.find(item => item.id === abilityId);
  if (!ability || ability.kind !== 'activated' ||
      !available(tx).some(item => item.ability_id === abilityId && item.source_instance_id === sourceId))
    throw new RuleError('ability is unavailable in this action');
  if (ability.usage === 'once_per_turn') (tx.state.ability_uses ??= {})[`${sourceId}:${abilityId}`] = tx.state.turn_number;
  tx.event('ability_activated', {ability_id: abilityId, source_instance_id: sourceId, player_id: tx.playerId});
  const used = tx.state.used_cards ??= [];
  if (!used.includes(sourceId)) used.push(sourceId);
  if (tx.state.battle_context) {
    const tags = tx.state.battle_context.used_card_tags ??= [];
    for (const tag of tx.card(sourceId).tags.split('|')) if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return runEffect(tx, abilityId, sourceId, abilityFrames(abilityId, sourceId, ability.body, {_subject: tx.playerId}));
}
export function dispatchEvent(tx: Transition, event: string): boolean {
  const plan = planEventDispatch({evaluation: tx.evaluation(),
    abilities: tx.ruleset.abilities.filter(item => item.kind === 'triggered' && item.event === event),
    listeners: tx.state.registered_triggers, scheduled: tx.state.scheduled_effects,
    event, turn_number: tx.state.turn_number,
    repeatable_ability_ids: tx.ruleset.abilities.filter(item => item.source_zone === 'battle_target').map(item => item.id)});
  if (plan.mode === 'none') return true;
  tx.state.registered_triggers = tx.state.registered_triggers.filter((_: any, i: number) =>
    !plan.consumed_listener_indices.includes(i));
  tx.state.scheduled_effects = tx.state.scheduled_effects.filter((_: any, i: number) =>
    !plan.consumed_scheduled_indices.includes(i));
  const candidates = plan.candidates;
  if (plan.mode === 'battle') {
    const stack: Record<string, any>[] = [];
    for (const item of [...candidates].reverse()) stack.push(...abilityFrames(item.ability_id,
      item.source_instance_id, item.body, {_subject: tx.playerId, ...item.bindings}));
    return runEffect(tx, candidates[0].ability_id, candidates[0].source_instance_id, stack);
  }
  if (plan.mode === 'choice') {
    const effects = candidates.map((item, i) => ({effect_id: `${item.source_instance_id}:${item.ability_id}:${i}`,
      ...item, bindings: {_subject: tx.playerId, ...item.bindings}}));
    tx.state.pending_choice = {kind: 'effect_order', player_id: tx.playerId, event, effects};
    tx.state.resolution_frames = [{kind: 'event_order', event, stack: []}];
    tx.event('effect_order_requested', {event, effects: effects.map(item => ({effect_id: item.effect_id,
      ability_id: item.ability_id, source_instance_id: item.source_instance_id}))});
    return false;
  }
  const first = candidates[0];
  tx.event('ability_triggered', {ability_id: first.ability_id, source_instance_id: first.source_instance_id, event});
  return runEffect(tx, first.ability_id, first.source_instance_id,
    abilityFrames(first.ability_id, first.source_instance_id, first.body,
      {_subject: tx.playerId, ...first.bindings}));
}
export function runEffect(tx: Transition, initialAbilityId: string, initialSourceId: string,
                          stack: Record<string, any>[]): boolean {
  let steps = 0;
  while (stack.length) {
    if (++steps > 4096 || ++tx.effectSteps > 4096) throw new RuleError('effect execution step limit reached');
    const frame = stack.pop()!, node = frame.node, bindings = frame.bindings;
    const abilityId = bindings._ability_id ?? initialAbilityId, sourceId = bindings.source ?? initialSourceId, op = node.op;
    const responses = bindings._responses ?? {};
    let subject = bindings._subject ?? tx.playerId;
    if (node.as_owner && typeof bindings[node.target.var] === 'string')
      subject = tx.state.instances[bindings[node.target.var]].owner_player_id;
    if ((responses.immune ?? []).includes(subject) && !['_ability_end', '_discard_reveal'].includes(op) && !hasGlobalWork(node)) continue;
    const protectedTargets = ['target', 'other', 'anchor'].flatMap(key => node[key]?.var ? [bindings[node[key].var]] : [])
      .filter(target => immuneToSource(evaluation(tx), sourceId, target));
    if (protectedTargets.length) {
      tx.event('effect_immune', {ability_id: abilityId, source_instance_id: sourceId,
        target_instance_ids: protectedTargets, reason: 'immune_spells'});
      continue;
    }
    switch (op) {
      case '_ability_end': tx.event('ability_resolved', {ability_id: abilityId, source_instance_id: sourceId}); break;
      case '_offer_effect': return offerEffect(tx, node.body, bindings, stack, abilityId, sourceId);
      case '_respond_subject': {
        if ((responses.immune ?? []).includes(bindings._subject ?? tx.playerId)) break;
        const ability = tx.ruleset.abilities.find(item => item.id === abilityId)!;
        if (['active_hand', 'active_control'].includes(ability.source_zone) &&
            tx.state.instances[sourceId]?.owner_player_id === tx.playerId &&
            (bindings._subject ?? tx.playerId) !== tx.playerId)
          return offerEffect(tx, node.body, bindings, stack, abilityId, sourceId, true);
        stack.push({node: node.body, bindings}); break;
      }
      case 'destroy':
        if (!node._is_cost && offerDestroy(tx, bound(bindings, node.target), abilityId,
          stack, bindings, abilityId, sourceId)) return false;
        atom(tx, node, bindings, abilityId); break;
      case '_discard_reveal': {
        const zone = node.zone, remaining = [...(tx.state.zones[zone] ?? [])];
        const destination = node.return_to ?? `player:${subject}:discard`;
        for (const item of remaining) tx.move(item, zone, destination);
        if (destination.startsWith('dungeon:')) tx.state.zones[destination] =
          [...remaining, ...tx.state.zones[destination].filter((item: string) => !remaining.includes(item))];
        delete tx.state.zones[zone]; break;
      }
      case 'choose_value': {
        const options = valueOptions(tx, node, bindings);
        tx.trace(abilityId, sourceId, node, bindings, {value_options: options});
        if (!options.length) {tx.event('effect_choice_unavailable', {ability_id: abilityId, choice_kind: node.kind}); break;}
        if (options.length === 1) {
          const body = node.kind === 'player' && node.as_subject ? {op: '_respond_subject', body: node.then} : node.then;
          stack.push({node: body, bindings: valueBindings(bindings, node, options[0])});
        } else {pause(tx, 'effect_value', node, bindings, stack, abilityId, sourceId, {options}); return false;}
        break;
      }
      case 'remember': {
        const candidates = query(tx, node.query, bindings);
        tx.trace(abilityId, sourceId, node, bindings, {candidate_instance_ids: candidates});
        const owners = [...new Set(candidates.map(item => tx.state.instances[item].owner_player_id)
          .filter(owner => typeof owner === 'string' && tx.state.players[owner]))];
        stack.push({node: node.then, bindings: {...bindings, [node.bind]: candidates,
          ...(node.owners_bind ? {[node.owners_bind]: owners} : {})}}); break;
      }
      case 'reorder': {
        const candidates = query(tx, node.query, bindings);
        tx.trace(abilityId, sourceId, node, bindings, {candidate_instance_ids: candidates});
        if (candidates.length <= 1) reorderCards(tx, node, bindings, candidates);
        else {pause(tx, 'effect_reorder', node, bindings, stack, abilityId, sourceId,
          {candidate_instance_ids: candidates}); return false;}
        break;
      }
      case 'draw':
        if ('bind' in node) {
          const count = expression(tx, node.count, bindings);
          if (!(0 <= count && count <= 100)) throw new RuleError('invalid effect draw count');
          const taken = tx.draw(count, subject);
          tx.event('effect_draw', {ability_id: abilityId, player_id: subject, requested: count, instance_ids: taken});
          stack.push({node: node.then, bindings: {...bindings, [node.bind]: taken}});
        } else {
          tx.trace(abilityId, sourceId, node, bindings);
          atom(tx, node, bindings, abilityId);
        }
        break;
      case 'move': {
        const item = bound(bindings, node.target), oldOwner = tx.state.instances[item].owner_player_id,
          origin = tx.location(item);
        // A reveal buffer is temporary storage, not a new source of cards.
        const revealed = bindings._reveal_origins?.[item];
        const fromReveal = revealed?.temporary_zone === origin;
        atom(tx, node, bindings, abilityId);
        const gained = gainSteps(tx, item, fromReveal ? revealed.origin : origin,
          fromReveal ? revealed.owner_player_id : oldOwner, abilityId);
        if (gained.length) {
          queueSteps(tx, [...gained,
            {op: 'effect_continuation', ability_id: abilityId, source_instance_id: sourceId,
              stack: structuredClone(stack)}], true);
          return tx.state.pending_choice === null;
        }
        break;
      }
      case 'release_attachment': {
        const steps = release(tx, bound(bindings, node.target), node.recipient ?? 'owner', node.destroy_anchor ?? true);
        if (steps.length) {
          steps.push({op: 'effect_continuation', ability_id: abilityId,
            source_instance_id: sourceId, stack: structuredClone(stack)});
          queueSteps(tx, steps, true); return tx.state.pending_choice === null;
        }
        break;
      }
      case 'reuse_ability': {
        const item = bound(bindings, node.target);
        if (!canReuseSpell({evaluation: tx.evaluation(), abilities: tx.ruleset.abilities,
          turn_number: tx.state.turn_number, ability_uses: tx.state.ability_uses}, item)) break;
        tx.state.instances[item].flags.pending_turn_end_destruction = true;
        tx.event('spell_recast_started', {player_id: tx.playerId, instance_id: item, source_instance_id: sourceId, ability_id: abilityId});
        const recastBindings = {...bindings, _recast_spell: item};
        stack.push({node: {op: '_spell_recast_end'}, bindings: recastBindings});
        for (const ability of [...tx.ruleset.abilities].reverse()) if (ability.kind === 'activated' &&
            ability.source_card_id === tx.card(item).card_id && ability.actions.includes('dungeon'))
          stack.push({node: {op: '_spell_recast_ability', ability_id: ability.id}, bindings: recastBindings});
        break;
      }
      case '_spell_recast_ability': {
        const item = bindings._recast_spell;
        if (!tx.zone('hand').includes(item)) break;
        const ability = tx.ruleset.abilities.find(candidate => candidate.id === node.ability_id)!;
        const replayBindings = {_subject: tx.playerId, source: item};
        if (!reusableAbilityIds({evaluation: tx.evaluation(), abilities: tx.ruleset.abilities,
          turn_number: tx.state.turn_number, ability_uses: tx.state.ability_uses}, item).includes(ability.id)) break;
        (tx.state.ability_uses ??= {})[`${item}:${ability.id}`] = tx.state.turn_number;
        tx.event('ability_activated', {ability_id: ability.id, source_instance_id: item, player_id: tx.playerId, reused: true});
        stack.push(...abilityFrames(ability.id, item, ability.body, replayBindings));
        break;
      }
      case '_spell_recast_end': {
        const item = bindings._recast_spell, context = tx.state.battle_context;
        const counts = context.spell_cast_counts ??= {};
        counts[item] = (counts[item] ?? 1) + 1;
        tx.event('spell_recast_completed', {player_id: tx.playerId, instance_id: item,
          cast_count: counts[item], source_instance_id: sourceId, ability_id: abilityId});
        break;
      }
      case 'borrow_card': case 'equip_from_supply': {
        const item = bound(bindings, node.target), origin = tx.location(item), oldOwner = tx.state.instances[item].owner_player_id;
        if (op === 'borrow_card') borrow(tx, item, node.when, node.return_destroyed);
        else {
          const zone = tx.location(item);
          if (!zone?.startsWith('village_supply:') || tx.state.zones[zone][0] !== item)
            throw new RuleError('weapon is not on top of its supply');
          tx.state.instances[item].owner_player_id = tx.playerId;
          tx.move(item, zone, `player:${tx.playerId}:hand`);
          tx.state.instances[item].flags.pending_after_battle_destruction = true;
          const carried = new Set(equipmentPairs(tx.state.battle_context).map(([, weapon]) => weapon));
          for (const [source] of tx.handRules('draw_attack')) if (carried.has(source)) {
            const counts = tx.state.battle_context.equipment_draw_counts ??= {};
            counts[source] = (counts[source] ?? 0) + 1;
          }
          tx.event('effect_draw', {ability_id: abilityId, player_id: tx.playerId, requested: 1, instance_ids: [item]});
        }
        const steps = gainSteps(tx, item, origin, oldOwner, abilityId);
        if (node.equipper) steps.push(...equipWeapon(tx, bound(bindings, node.equipper), item, true));
        steps.push({op: 'effect_continuation', ability_id: abilityId, source_instance_id: sourceId,
          stack: structuredClone(stack)});
        queueSteps(tx, steps, true); return tx.state.pending_choice === null;
      }
      case 'redistribute_discards': {
        const remaining = query(tx, node.query, bindings), steps: Record<string, any>[] = [];
        tx.rng.shuffle(remaining);
        const eligible = node.players_var ? bindings[node.players_var] : tx.state.player_order;
        if (!Array.isArray(eligible) || eligible.some(player => typeof player !== 'string' || !tx.state.players[player]))
          throw new RuleError('invalid redistribution contributors');
        const assignments = [];
        for (const other of tx.state.player_order) {
          if (tx.state.players[other].eliminated || other === tx.playerId || !eligible.includes(other) || !remaining.length) continue;
          const item = remaining.shift()!, origin = tx.location(item), owner = tx.state.instances[item].owner_player_id;
          tx.state.instances[item].owner_player_id = other;
          tx.move(item, origin!, `player:${other}:hand`);
          assignments.push({player_id: other, instance_id: item});
          steps.push(...gainSteps(tx, item, origin, owner, abilityId));
        }
        tx.event('cards_randomly_distributed', {assignments, ability_id: abilityId});
        if (steps.length) {
          steps.push({op: 'effect_continuation', ability_id: abilityId, source_instance_id: sourceId, stack: structuredClone(stack)});
          queueSteps(tx, steps, true); return tx.state.pending_choice === null;
        }
        break;
      }
      case 'gain_card': {
        const cardId = node.card_id;
        if (!tx.cards[cardId]) throw new RuleError(`unknown gained card: ${cardId}`);
        const destination = `player:${subject}:${node.destination ?? 'discard'}`;
        let item: string, origin: string|null = null;
        if (tx.state.supply_rules.basic_card_ids.includes(cardId)) item = tx.createOwned(cardId, destination, 'ability_gain', subject);
        else {
          origin = Object.entries(tx.state.zones).find(([zone, pile]) => (zone.startsWith('village_supply:') || zone.startsWith('hero_supply:')) &&
            (pile as string[]).length && tx.state.instances[(pile as string[])[0]].card_id === cardId)?.[0] ?? null;
          if (!origin) {tx.event('effect_gain_unavailable', {ability_id: abilityId, card_id: cardId}); break;}
          item = tx.state.zones[origin][0]; tx.state.instances[item].owner_player_id = subject;
          tx.move(item, origin, destination);
        }
        tx.event('effect_card_gained', {ability_id: abilityId, instance_id: item, card_id: cardId, destination});
        const steps = gainSteps(tx, item, origin, null, abilityId);
        if (steps.length) {
          steps.push({op: 'effect_continuation', ability_id: abilityId, source_instance_id: sourceId, stack: structuredClone(stack)});
          queueSteps(tx, steps, true); return tx.state.pending_choice === null;
        }
        break;
      }
      case 'swap_hall': case 'exchange_hall': case 'shuffle_hall_top': case 'relocate_hall': {
        const first = bound(bindings, node.target);
        const steps = op === 'shuffle_hall_top' ? shuffleHallTop(tx, first, node.count) :
          op === 'relocate_hall' ? relocate(tx, first, node.destination, node.defeat ?? false) :
          op === 'swap_hall' ? swapHall(tx, first, bound(bindings, node.other)) :
          exchangeHall(tx, first, bound(bindings, node.other));
        steps.push({op: 'effect_continuation', ability_id: abilityId,
          source_instance_id: sourceId, stack: structuredClone(stack)});
        queueSteps(tx, steps, true); return tx.state.pending_choice === null;
      }
      case 'gain_disease': {
        const count = expression(tx, node.count, bindings);
        if (!(0 <= count && count <= 100)) throw new RuleError('invalid effect disease count');
        tx.trace(abilityId, sourceId, node, bindings);
        const steps = Array.from({length: count}, () => ({op: 'gain_disease', player_id: subject}));
        steps.push({op: 'effect_continuation', ability_id: abilityId,
          source_instance_id: sourceId, stack: structuredClone(stack)} as any);
        queueSteps(tx, steps, true); return tx.state.pending_choice === null;
      }
      case 'buy': {
        const maximumCost = node.maximum_cost === undefined ? null : expression(tx, node.maximum_cost, bindings);
        const options = offerPurchase(tx, node.filter, maximumCost);
        if (!options.length) {tx.event('effect_purchase_unavailable', {ability_id: abilityId}); break;}
        tx.state.pending_choice = {kind: 'effect_purchase', player_id: tx.playerId,
          ability_id: abilityId, source_instance_id: sourceId, options, filter: node.filter,
          destination: node.destination, payment: node.payment ?? 'none', maximum_cost: maximumCost, bindings};
        tx.state.resolution_frames = [{ability_id: abilityId, source_instance_id: sourceId, stack: structuredClone(stack)}];
        tx.event('effect_purchase_requested', {ability_id: abilityId, options}); return false;
      }
      case 'upgrade': {
        tx.trace(abilityId, sourceId, node, bindings);
        const options = upgradeOptions(tx);
        if (!options.length) {tx.event('effect_upgrade_unavailable', {ability_id: abilityId}); break;}
        pause(tx, 'effect_upgrade', node, bindings, stack, abilityId, sourceId, {options}); return false;
      }
      case 'reveal': {
        const isDungeon = node.zone === 'dungeon', origin = isDungeon ? dungeonZone(tx, bindings) : `player:${subject}:draw`;
        const count = expression(tx, node.count, bindings);
        if (!(0 <= count && count <= 1000)) throw new RuleError('invalid reveal count');
        const zone = isDungeon ? `revealed:${origin.slice(8)}_${tx.state.next_event_sequence}` :
          `player:${subject}:revealed_${tx.state.next_event_sequence}`;
        tx.state.zones[zone] = [];
        const taken = [];
        const origins = {...(bindings._reveal_origins ?? {})};
        for (let i = 0; i < count; i++) {
          const draw = isDungeon ? tx.state.zones[origin] : tx.playerDrawPile(subject);
          if (!draw.length) break;
          const instance = node.from_bottom ? draw[draw.length-1] : draw[0];
          origins[instance] = {origin, temporary_zone: zone,
            owner_player_id: tx.state.instances[instance].owner_player_id};
          tx.move(instance, origin, zone); taken.push(instance);
          if (node.until && matches(tx.card(instance), node.until)) break;
        }
        tx.event('cards_revealed', {ability_id: abilityId, player_id: subject, instance_ids: taken});
        stack.push({node: {op: '_discard_reveal', zone, ...(isDungeon ? {return_to: origin} : {})}, bindings});
        stack.push({node: node.then, bindings: {...bindings, [node.bind]: taken,
          _reveal_zone: zone, _reveal_origins: origins}}); break;
      }
      case 'discard_until': {
        const origin = `player:${subject}:draw`, progress = new DeckSearchProgress(tx);
        const zone = `player:${subject}:revealed_${tx.state.next_event_sequence}`;
        tx.state.zones[zone] = [];
        const found: string[] = [];
        const origins = {...(bindings._reveal_origins ?? {})};
        while (progress.canContinue([subject])) {
          const draw = tx.playerDrawPile(subject);
          if (!draw.length) break;
          const instance = draw[0];
          origins[instance] = {origin, temporary_zone: zone,
            owner_player_id: tx.state.instances[instance].owner_player_id};
          tx.move(instance, origin, zone);
          tx.event('cards_revealed', {ability_id: abilityId, player_id: subject, instance_ids: [instance]});
          if (matches(tx.card(instance), node.filter)) {found.push(instance); break;}
          tx.move(instance, zone, `player:${subject}:discard`);
          progress.recordNoProgress(subject, instance);
        }
        if (!found.length) tx.event('effect_search_stopped', {ability_id: abilityId,
          player_id: subject, reason: 'no_progress'});
        stack.push({node: {op: '_discard_reveal', zone}, bindings});
        if (found.length) stack.push({node: node.then, bindings: {...bindings, [node.bind]: found,
          _reveal_zone: zone, _reveal_origins: origins}});
        break;
      }
      case 'sequence':
        tx.trace(abilityId, sourceId, node, bindings, {child_count: node.children.length});
        for (const child of [...node.children].reverse()) stack.push({node: child, bindings});
        break;
      case 'if': {
        const yes = condition(tx, node.condition, bindings);
        tx.trace(abilityId, sourceId, node, bindings, {condition_result: yes, branch: yes ? 'then' : 'else'});
        const branch = yes ? node.then : node.else;
        if (branch !== undefined) stack.push({node: branch, bindings}); break;
      }
      case 'select': case 'for_each': {
        const original = query(tx, node.query, bindings);
        const candidates = evaluation(tx).effectTargets(node.query, bindings);
        if (original.length && !candidates.length) {
          tx.event('effect_immune', {ability_id: abilityId, source_instance_id: sourceId,
            target_instance_ids: original, reason: 'immune_spells'});
          break;
        }
        let minimum = expression(tx, node.min ?? 1, bindings), maximum = expression(tx, node.max ?? 1, bindings);
        const requiredMinimum = minimum;
        if (op === 'select' && !(0 <= minimum && minimum <= maximum && maximum <= 100)) throw new RuleError('invalid dynamic selection bounds');
        if (candidates.length < original.length) minimum = Math.min(minimum, candidates.length);
        if (op === 'select') {
          let feasible = candidates.length;
          for (const constraint of node.constraints ?? []) {
            const matching = candidates.filter(item => matches(tx.card(item), constraint.filter)).length;
            feasible = Math.min(feasible, candidates.length - matching + Math.min(matching, constraint.maximum));
          }
          maximum = Math.min(maximum, feasible);
          if (node.allow_shortfall) minimum = Math.min(minimum, maximum);
          if (minimum > maximum || maximum === 0 && requiredMinimum > 0) {
            tx.event('effect_choice_unavailable', {ability_id: abilityId, player_id: subject,
              reason: 'insufficient_targets', required: requiredMinimum, available: maximum});
            break;
          }
        }
        tx.trace(abilityId, sourceId, node, bindings, {candidate_instance_ids: [...candidates]});
        if (op === 'for_each') for (const item of [...candidates].reverse())
          stack.push({node: node.body, bindings: {...bindings, [node.bind]: item}});
        else if (!candidates.length && minimum && !node.allow_shortfall) throw new RuleError('required effect choice has no candidate');
        else if (!candidates.length || maximum === 0) stack.push({node: node.then, bindings: {...bindings, [node.bind]: []}});
        else if (candidates.length === 1 && minimum === 1 && maximum === 1)
          stack.push({node: node.then, bindings: {...bindings, [node.bind]: candidates[0]}});
        else {
          tx.state.pending_choice = {kind: 'effect_select', player_id: subject, ability_id: abilityId,
            source_instance_id: sourceId, candidate_instance_ids: candidates, query: node.query,
            bind: node.bind, then: node.then, bindings,
            min_count: node.allow_shortfall ? Math.min(minimum, candidates.length) : minimum,
            max_count: Math.min(maximum, candidates.length), multiple: maximum > 1 || minimum === 0,
            highest_by: node.highest_by ?? null, constraints: node.constraints ?? []};
          tx.state.resolution_frames = [{ability_id: abilityId, source_instance_id: sourceId, stack: structuredClone(stack)}];
          tx.event('effect_choice_requested', {ability_id: abilityId, player_id: subject, candidate_instance_ids: candidates});
          return false;
        }
        break;
      }
      case 'for_players': {
        const players = activePlayers(tx.state).filter(player => node.scope === 'all' ||
          node.scope === 'active' && player === tx.playerId || node.scope === 'others' && player !== tx.playerId);
        const redirects = responses.redirects ?? {};
        for (const player of [...players].reverse()) stack.push({node: {op: '_respond_subject', body: node.body},
          bindings: {...bindings, _subject: redirects[player] ?? player}});
        break;
      }
      case 'let': stack.push({node: node.then, bindings: {...bindings, [node.bind]: expression(tx, node.value, bindings)}}); break;
      case 'cost_gate': {
        const payable = evaluateCost({evaluation: tx.evaluation(), cost: node.cost, bindings}).payable;
        tx.trace(abilityId, sourceId, node, bindings, {payable});
        if (!payable) throw new RuleError('ability cost cannot be paid');
        stack.push({node: node.then, bindings});
        stack.push({node: {...node.cost, _is_cost: true}, bindings}); break;
      }
      case 'repeat': {
        const count = expression(tx, node.times, bindings);
        tx.trace(abilityId, sourceId, node, bindings, {repeat_count: count});
        if (!(0 <= count && count <= node.limit)) throw new RuleError('effect repetition exceeds its bound');
        for (let i = 0; i < count; i++) stack.push({node: node.body, bindings}); break;
      }
      case 'listen':
        tx.state.registered_triggers.push({event: node.event, body: node.body,
          conditions: node.conditions ?? [], once: node.once ?? false,
          ability_id: abilityId, source_instance_id: sourceId, bindings: structuredClone(bindings),
          turn_number: tx.state.turn_number}); break;
      case 'schedule':
        tx.trace(abilityId, sourceId, node, bindings, {scheduled_event: node.event});
        if (tx.state.timing_window === node.event) throw new RuleError('cannot schedule an effect for the current event');
        tx.state.scheduled_effects.push({event: node.event,
          turn_number: tx.state.turn_number + Number(node.event === 'TURN_START'),
          ability_id: abilityId, source_instance_id: sourceId, player_id: tx.playerId,
          body: node.body, bindings: structuredClone(bindings)});
        tx.event('effect_scheduled', {ability_id: abilityId, event: node.event, source_instance_id: sourceId}); break;
      case 'reveal_cycle':
        tx.trace(abilityId, sourceId, node, bindings);
        resolveRevealCycle(tx, node.filter, node.goal, abilityId, responses); break;
      default:
        tx.trace(abilityId, sourceId, node, bindings);
        atom(tx, node, bindings, abilityId);
    }
  }
  return true;
}
