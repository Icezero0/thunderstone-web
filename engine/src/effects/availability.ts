import {EffectEvaluation} from './evaluator.js';
import type {Ability, EffectNode, EvaluationInput} from './dsl.js';
import {RuleError} from '../types.js';
import {teamSourceSelected} from '../battle/participation.js';
import {combatValues} from '../battle/combat.js';
import {isHero, tags} from '../catalog/cards.js';
import {equipmentPairs} from './context.js';

export interface ActivationInput {
  evaluation: EvaluationInput;
  abilities: Ability[];
  turn_number: number;
  ability_uses: Record<string, number>;
}

function targetsDungeonDeck(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(targetsDungeonDeck);
  if (value === null || typeof value !== 'object') return false;
  const node = value as EffectNode;
  return node.op === 'reveal' && node.zone === 'dungeon' ||
    node.destination === 'dungeon_top' || node.destination === 'dungeon_bottom' ||
    ['shuffle_hall_top', 'swap_dungeon_top', 'shuffle_destroyed_traps'].includes(node.op) ||
    Object.values(node).some(item => typeof item === 'object' && targetsDungeonDeck(item));
}

export function sourceInstances(evaluation: EffectEvaluation, ability: Ability): string[] {
  const state = evaluation.evaluationState, zones = state.zones;
  let pool: string[];
  switch (ability.source_zone) {
    case 'active_hand': pool = zones[`player:${evaluation.playerId}:hand`] ?? []; break;
    case 'active_control': pool = zones[`player:${evaluation.playerId}:control`] ?? []; break;
    case 'battle_target': {
      const target = state.battle_context?.target_instance_id;
      pool = target && Object.hasOwn(state.instances, target) ? [target] : [];
      break;
    }
    case 'hall': pool = Object.entries(zones).filter(([zone]) => zone.startsWith('hall:'))
      .flatMap(([, pile]) => pile); break;
    case 'event_source': {
      const source = state.event_context?.source_instance_id;
      pool = typeof source === 'string' && Object.hasOwn(state.instances, source) ? [source] : [];
      break;
    }
    case 'attached': pool = Object.keys(state.attachments ?? {}); break;
    default:
      if (!state.active_settings.includes(ability.source_card_id)) return [];
      pool = zones.settings ?? [];
  }
  const combatTiming = ['BATTLE_BEFORE_OUTCOME', 'BATTLE_TRIUMPH', 'BATTLE_AFTER_OUTCOME', 'MONSTER_DEFEATED'].includes(ability.event ?? '');
  const targetId = state.battle_context?.target_instance_id;
  const excluded = combatTiming && ability.source_zone === 'active_hand' && state.battle_context?.battle_team
    ? combatValues(evaluation.input, state.battle_context.target_rank ?? 1,
      targetId && state.instances[targetId] ? evaluation.card(targetId) : null).excluded_instance_ids : [];
  return pool.filter(instance => Object.hasOwn(state.instances, instance) &&
    (!combatTiming || ability.source_zone !== 'active_hand' || teamSourceSelected(evaluation, instance)) &&
    (!excluded.includes(instance) || !isHero(evaluation.card(instance))) &&
    (evaluation.card(instance).card_id === ability.source_card_id ||
      (state.copied_heroes?.[instance]?.card_ids ?? []).includes(ability.source_card_id)));
}

/** Return authoritative activation choices from one immutable rule snapshot. */
export function availableActivations(input: ActivationInput): {ability_id: string; source_instance_id: string}[] {
  const evaluation = new EffectEvaluation(input.evaluation);
  const action = evaluation.evaluationState.chosen_action;
  if (action !== 'village' && action !== 'dungeon') return [];
  const dungeonLocked = evaluation.hallRules('dungeon_deck_lock').length > 0;
  const options: {ability_id: string; source_instance_id: string}[] = [];
  for (const ability of input.abilities) {
    if (ability.kind !== 'activated' || !ability.actions.includes(action)) continue;
    if (dungeonLocked && targetsDungeonDeck(ability.body)) continue;
    for (const source of sourceInstances(evaluation, ability)) {
      if (action === 'dungeon' && tags(evaluation.card(source)).includes('武器') &&
          ability.id !== 'TS-0257-A02' && !equipmentPairs(evaluation.state.battle_context ?? {})
            .some(([, weapon]) => weapon === source)) continue;
      if (!ability.conditions.every(condition => evaluation.condition(condition,
        {source, _subject: evaluation.playerId}))) continue;
      if (ability.usage === 'once_per_turn' &&
          input.ability_uses[`${source}:${ability.id}`] === input.turn_number) continue;
      options.push({ability_id: ability.id, source_instance_id: source});
    }
  }
  return options;
}

/** Recasting selects a real used spell, including spells with only printed/dynamic values. */
export function canReuseSpell(input: ActivationInput, instanceId: string): boolean {
  const evaluation = new EffectEvaluation(input.evaluation), state = evaluation.evaluationState;
  return state.chosen_action === 'dungeon' &&
    (state.zones[`player:${evaluation.playerId}:hand`] ?? []).includes(instanceId) &&
    (state.used_cards ?? []).includes(instanceId) && tags(evaluation.card(instanceId)).includes('法术');
}

/** A used hand card may offer its own dungeon abilities again at a destruction cost. */
export function reusableAbilityIds(input: ActivationInput, instanceId: string): string[] {
  const evaluation = new EffectEvaluation(input.evaluation);
  const state = evaluation.evaluationState;
  if (!(state.zones[`player:${evaluation.playerId}:hand`] ?? []).includes(instanceId) ||
      !(state.used_cards ?? []).includes(instanceId)) return [];
  const cardId = evaluation.card(instanceId).card_id;
  const dungeonLocked = evaluation.hallRules('dungeon_deck_lock').length > 0;
  return input.abilities.filter(ability => ability.kind === 'activated' &&
    ability.source_card_id === cardId && ability.actions.includes('dungeon') &&
    (!dungeonLocked || !targetsDungeonDeck(ability.body)) &&
    ability.conditions.every(condition => evaluation.condition(condition,
      {source: instanceId, _subject: evaluation.playerId})))
    .map(ability => ability.id);
}

/** Recheck an offered ability against the current hand and conditions on resume. */
export function validateReuseChoice(input: ActivationInput,
                                    choice: {kind: string; reused_instance_id: string; options: string[]}|null,
                                    selected: unknown): string {
  if (!choice || choice.kind !== 'effect_reuse') throw new RuleError('no reused ability is pending');
  if (typeof selected !== 'string' || !choice.options.includes(selected) ||
      !reusableAbilityIds(input, choice.reused_instance_id).includes(selected)) {
    throw new RuleError('reused ability is no longer available');
  }
  return selected;
}
