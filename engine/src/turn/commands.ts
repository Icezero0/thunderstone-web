import {RuleError} from '../types.js';
import {RULESET_VERSION} from '../setup/rules.js';
import {validateTurnBuffs} from './buffs.js';
import {isMonster} from '../catalog/cards.js';
import {Transition, type GameCatalog, type GameRules, type GameState} from './transaction.js';
import {available, activate} from '../effects/execute.js';
import {resolveResponse} from '../effects/responses.js';
import {resolveReplacement} from '../effects/disease-transition.js';
import {resolveValue, resolveReorder, resolveSelection, resolvePurchase, resolveUpgrade,
  resolveReuse, resolveOrder} from '../effects/choice-transition.js';
import {mustEnterDungeon} from '../effects/durations.js';
import {queueSteps} from './workflow.js';
import {advanceVillageStages, buyCard, finishAbilities, finishBuying, goldIncomePreview, purchaseOptions, upgradeOptions,
  upgradeHero, restDestroy} from './village.js';
import {attackTargets, declareBattleTarget} from './dungeon.js';
import {equipmentOptions, equipWeapon, reconcileEquipment} from '../battle/equipment.js';
import {submitBattleTeam} from '../battle/team-transition.js';
import {battlePreparationResult} from '../battle/preparation.js';
import {spellUseOptions, useSpell} from '../effects/spell-use.js';

const SUBPHASES = new Set(['TURN_START', 'VILLAGE_ABILITIES', 'VILLAGE_BUY', 'VILLAGE_UPGRADE', 'REST', 'ACTION_END',
  'DUNGEON_PREPARE', 'BATTLE_COMMIT', 'ACTION_EXIT_EFFECTS', 'TURN_END_EFFECTS', 'GAME_END', 'BATTLE_EFFECTS', 'BATTLE_AFTER_EFFECTS']);
const CHOICES = new Set(['effect_select', 'effect_order', 'effect_purchase', 'effect_value',
  'effect_reorder', 'effect_upgrade', 'disease_replacement', 'effect_reuse', 'effect_response']);
export function validateTurnState(state: GameState, cards: GameCatalog['cards']) {
  if (!['PLAYING', 'SETTLING'].includes(state.phase)) throw new RuleError('game is not in a turn or settlement phase');
  if (!SUBPHASES.has(state.subphase)) throw new RuleError('unknown turn subphase');
  if (state.turn_hand_public !== undefined && typeof state.turn_hand_public !== 'boolean')
    throw new RuleError('invalid turn hand visibility');
  if (state.phase === 'SETTLING' && state.subphase !== 'GAME_END') throw new RuleError('settling game has no end subphase');
  const order = state.player_order;
  if (!Array.isArray(order) || !order.length || new Set(order).size !== order.length ||
      !order.includes(state.active_player_id) || Object.keys(state.players).length !== order.length ||
      !order.every((id: string) => state.players[id])) throw new RuleError('invalid player order or active player');
  if (state.phase === 'PLAYING' && state.players[state.active_player_id].eliminated) throw new RuleError('eliminated player cannot have an active turn');
  for (const name of ['game_version', 'turn_number', 'round_number', 'next_instance_sequence', 'next_event_sequence'])
    if (!Number.isSafeInteger(state[name]) || state[name] < 1) throw new RuleError(`invalid ${name}`);
  const choice = state.pending_choice, frames = state.resolution_frames;
  if (!Array.isArray(frames) || !Array.isArray(state.scheduled_effects)) throw new RuleError('invalid effect continuation or schedule');
  if (typeof (state.ability_uses ?? {}) !== 'object') throw new RuleError('invalid ability usage record');
  if ((choice === null) !== (frames.length === 0)) throw new RuleError('effect choice and continuation must occur together');
  if (choice !== null && (typeof choice !== 'object' || !order.includes(choice.player_id) ||
      !CHOICES.has(choice.kind) || frames.length !== 1)) throw new RuleError('invalid pending effect choice');
  const seen = new Set<string>();
  for (const [zone, pile] of Object.entries(state.zones) as [string, string[]][]) {
    if (!Array.isArray(pile)) throw new RuleError(`invalid zone: ${zone}`);
    for (const id of pile) {
      if (seen.has(id) || !state.instances[id]) throw new RuleError(`duplicate or unknown instance: ${id}`);
      seen.add(id);
      const instance = state.instances[id], card = cards[instance.card_id];
      if (!card) throw new RuleError(`unknown card: ${instance.card_id}`);
      validateTurnBuffs(state.turn_number, instance, card);
      if (zone.startsWith('player:')) {
        const parts = zone.split(':');
        if (parts.length !== 3 || instance.owner_player_id !== parts[1]) throw new RuleError(`wrong instance owner in ${zone}: ${id}`);
      } else if (instance.owner_player_id !== null) throw new RuleError(`owned instance outside player zone: ${id}`);
    }
  }
  if (seen.size !== Object.keys(state.instances).length) throw new RuleError('some instances have no zone');
  for (const playerId of order) {
    for (const part of ['draw', 'hand', 'discard', 'control'])
      if (!state.zones[`player:${playerId}:${part}`]) throw new RuleError(`missing player zone: ${playerId}:${part}`);
    const player = state.players[playerId];
    if (['xp', 'temporary_gold', 'purchases_remaining'].some(key => !Number.isSafeInteger(player[key]) || player[key] < 0))
      throw new RuleError(`invalid player resources: ${playerId}`);
    if (player.eliminated !== undefined && typeof player.eliminated !== 'boolean')
      throw new RuleError(`invalid player elimination status: ${playerId}`);
  }
}
function checkVersions(state: GameState, catalog: GameCatalog, rules: GameRules) {
  if (state.catalog_version !== catalog.setup_index.cards_csv_sha256) throw new RuleError('game state uses a different card catalog revision');
  if (state.ruleset_version !== RULESET_VERSION) throw new RuleError('unsupported ruleset version');
  if (state.effects_version !== rules.version) throw new RuleError('game state uses a different executable effect revision');
}
function legal(tx: Transition): Record<string, any>[] {
  const state = tx.state, choice = state.pending_choice;
  if (choice !== null) {
    switch (choice.kind) {
      case 'effect_response': return [{type: 'ResolveResponse', player_id: choice.player_id,
        stage: choice.stage, options: choice.options, may_decline: true}];
      case 'effect_reuse': return [{type: 'ResolveReusedAbility', player_id: choice.player_id, ability_ids: choice.options}];
      case 'disease_replacement': return [{type: 'ResolveDiseaseReplacement', player_id: choice.player_id,
        stage: choice.stage, options: choice.options}];
      case 'effect_upgrade': return [{type: 'ResolveEffectUpgrade', player_id: choice.player_id,
        options: choice.options, may_skip: true}];
      case 'effect_value': return [{type: 'ResolveValueChoice', player_id: choice.player_id, options: choice.options}];
      case 'effect_reorder': return [{type: 'ResolveCardOrder', player_id: choice.player_id,
        instance_ids: choice.candidate_instance_ids}];
      case 'effect_purchase': return [{type: 'ResolveEffectPurchase', player_id: choice.player_id,
        options: choice.options, may_skip: true}];
      case 'effect_order': return [{type: 'ResolveEffectOrder', player_id: choice.player_id,
        effects: choice.effects.map((item: any) => ({effect_id: item.effect_id,
          ability_id: item.ability_id, source_instance_id: item.source_instance_id}))}];
      default: return [{type: 'ResolveChoice', instance_ids: [...choice.candidate_instance_ids],
        ability_id: choice.ability_id, player_id: choice.player_id,
        min_count: choice.min_count ?? 1, max_count: choice.max_count ?? 1,
        highest_by: choice.highest_by ?? null, constraints: choice.constraints ?? []}];
    }
  }
  if (state.phase !== 'PLAYING') return [];
  switch (state.subphase) {
    case 'TURN_START': {
      let actions = ['village', 'rest'];
      if (attackTargets(tx).length) actions.splice(1, 0, 'dungeon');
      if (mustEnterDungeon(tx)) actions = ['dungeon'];
      return [{type: 'ChooseAction', actions}];
    }
    case 'VILLAGE_ABILITIES': {
      const options = available(tx);
      return [...(options.length ? [{type: 'ActivateAbility', options}] : []), {type: 'FinishAbilities'}];
    }
    case 'VILLAGE_BUY': {
      const options = purchaseOptions(tx);
      return [...(options.length ? [{type: 'BuyCard', card_ids: options.map(item => item.card_id), options}] : []),
        {type: 'FinishBuying'}];
    }
    case 'VILLAGE_UPGRADE': {
      const options = upgradeOptions(tx);
      return [...(options.length ? [{type: 'UpgradeHero', options}] : []), {type: 'FinishUpgrading'}];
    }
    case 'REST': return [...(tx.zone('hand').length && tx.player.rest_destroyed_on_turn !== state.turn_number ? [{type: 'RestDestroy', instance_ids: [...tx.zone('hand')]}] : []),
      {type: 'SkipRestDestroy'}];
    case 'ACTION_END': return [{type: 'FinishTurn'}];
    case 'DUNGEON_PREPARE': {
      const equipment = equipmentOptions(tx), abilities = available(tx), trace = tx.combat(1), spells = spellUseOptions(tx);
      return [...(trace.strength_penalties.length ? [{type: 'AssignStrengthPenalty', penalties: trace.strength_penalties,
        hero_instance_ids: Object.keys(trace.hero_strength)}] : []),
        ...(trace.disease_penalties.length ? [{type: 'AssignDiseasePenalty',
          instance_ids: trace.disease_penalties.map(item => item.instance_id), attack_types: ['attack', 'magic_attack']}] : []),
        ...(abilities.length ? [{type: 'ActivateAbility', options: abilities}] : []),
        ...(spells.length ? [{type: 'UseSpell', instance_ids: spells}] : []),
        ...(equipment.length ? [{type: 'EquipWeapon', options: equipment}] : []),
        {type: 'DeclareBattleTarget', instance_ids: attackTargets(tx)},
        {type: 'SubmitBattleTeam', target_instance_ids: attackTargets(tx), requires_draft: true}];
    }
    default: throw new RuleError(`unknown turn subphase: ${state.subphase}`);
  }
}
export function legalCommands(state: GameState, catalog: GameCatalog, rules: GameRules) {
  checkVersions(state, catalog, rules); validateTurnState(state, catalog.cards);
  return legal(new Transition(state, catalog, rules));
}
/** Read-only per-player options; the worker returns them together in one request. */
export function turnOptions(state: GameState, playerId: string, catalog: GameCatalog, rules: GameRules) {
  checkVersions(state, catalog, rules); validateTurnState(state, catalog.cards);
  const tx = new Transition(state, catalog, rules);
  return {legal_commands: legal(tx), gold_income_preview: goldIncomePreview(tx, playerId)};
}
/** Server entry point: validates authority before returning only visible preview data. */
export function battlePreparation(state: GameState, playerId: string, catalog: GameCatalog, rules: GameRules) {
  checkVersions(state, catalog, rules); validateTurnState(state, catalog.cards);
  if (state.phase !== 'PLAYING' || state.subphase !== 'DUNGEON_PREPARE' || state.pending_choice !== null)
    throw new RuleError('battle preparation requires an uninterrupted dungeon preparation phase');
  if (playerId !== state.active_player_id) throw new RuleError('only the active player can prepare a battle team');
  return battlePreparationResult(state, catalog, rules);
}
export function applyCommand(state: GameState, command: Record<string, any>, catalog: GameCatalog,
                             rules: GameRules, traceEffects = false) {
  checkVersions(state, catalog, rules); validateTurnState(state, catalog.cards);
  if (state.phase !== 'PLAYING') throw new RuleError('game is already settling');
  if (!command || typeof command.type !== 'string') throw new RuleError('command requires a type');
  const actor = state.pending_choice?.player_id ?? state.active_player_id;
  if (command.player_id !== actor) throw new RuleError('only the active or chosen player may submit this command');
  if (command.expected_version !== undefined && command.expected_version !== state.game_version)
    throw new RuleError('stale game version');
  const tx = new Transition(state, catalog, rules, traceEffects), kind = command.type, phase = state.subphase;
  if (state.pending_choice !== null) {
    const choice = state.pending_choice;
    const routes: Record<string, [string, () => boolean]> = {
      effect_response: ['ResolveResponse', () => resolveResponse(tx, command.source_instance_id ?? null, command.recipient_id ?? null)],
      effect_reuse: ['ResolveReusedAbility', () => resolveReuse(tx, command.ability_id)],
      disease_replacement: ['ResolveDiseaseReplacement', () => resolveReplacement(tx, command.source_instance_id ?? null, command.recipient_id ?? null)],
      effect_upgrade: ['ResolveEffectUpgrade', () => resolveUpgrade(tx, command.source_instance_id ?? null, command.target_card_id ?? null)],
      effect_value: ['ResolveValueChoice', () => resolveValue(tx, command.value)],
      effect_reorder: ['ResolveCardOrder', () => resolveReorder(tx, command.instance_ids)],
      effect_purchase: ['ResolveEffectPurchase', () => resolvePurchase(tx, command.card_id ?? null)],
      effect_order: ['ResolveEffectOrder', () => resolveOrder(tx, command.effect_ids)],
      effect_select: ['ResolveChoice', () => resolveSelection(tx, command.instance_ids ?? command.instance_id)],
    };
    const route = routes[choice.kind];
    if (!route || kind !== route[0]) throw new RuleError('an effect choice must be resolved first');
    const completed = route[1]();
    if (completed && tx.state.effect_resume !== undefined) tx.resumeAfterEffects();
  } else if (phase === 'TURN_START' && kind === 'ChooseAction') {
    const action = command.action;
    if (!legal(tx)[0].actions.includes(action)) throw new RuleError('action is not available in the current game state');
    const steps = tx.state.started_turn === tx.state.turn_number ? [] : [{op: 'event', event: 'TURN_START'}];
    queueSteps(tx, [...steps, {op: 'enter_action', action}]);
  } else if (phase === 'VILLAGE_BUY' && kind === 'BuyCard') buyCard(tx, command.card_id);
  else if (phase === 'VILLAGE_ABILITIES' && kind === 'FinishAbilities') finishAbilities(tx);
  else if (['VILLAGE_ABILITIES', 'DUNGEON_PREPARE'].includes(phase) && kind === 'ActivateAbility')
    activate(tx, command.ability_id, command.source_instance_id);
  else if (phase === 'VILLAGE_BUY' && kind === 'FinishBuying') finishBuying(tx);
  else if (phase === 'VILLAGE_UPGRADE' && kind === 'UpgradeHero') upgradeHero(tx, command.source_instance_id, command.target_card_id);
  else if (phase === 'VILLAGE_UPGRADE' && kind === 'FinishUpgrading') tx.awaitTurnEnd();
  else if (phase === 'REST' && kind === 'RestDestroy') restDestroy(tx, command.instance_id);
  else if (phase === 'REST' && kind === 'SkipRestDestroy') tx.awaitTurnEnd();
  else if (phase === 'ACTION_END' && kind === 'FinishTurn') tx.finishTurn();
  else if (phase === 'DUNGEON_PREPARE' && kind === 'EquipWeapon') equipWeapon(tx, command.hero_instance_id, command.weapon_instance_id);
  else if (phase === 'DUNGEON_PREPARE' && kind === 'UseSpell') useSpell(tx, command.instance_id);
  else if (phase === 'DUNGEON_PREPARE' && kind === 'DeclareBattleTarget') declareBattleTarget(tx, command.target_instance_id);
  else if (phase === 'DUNGEON_PREPARE' && kind === 'SubmitBattleTeam') {
    if (command.expected_version !== state.game_version) throw new RuleError('battle submission requires the current expected_version');
    submitBattleTeam(tx, command.draft);
  }
  else if (phase === 'DUNGEON_PREPARE' && kind === 'AssignDiseasePenalty') {
    const diseaseIds = tx.combat(1).disease_penalties.map(item => item.instance_id);
    if (!diseaseIds.includes(command.instance_id) || !['attack', 'magic_attack'].includes(command.attack_type))
      throw new RuleError('invalid disease penalty assignment');
    const context = tx.state.battle_context;
    (context.disease_penalty_assignments ??= {})[command.instance_id] = command.attack_type;
    if (command.order !== undefined) {
      if (!Array.isArray(command.order) || command.order.length !== diseaseIds.length ||
          !diseaseIds.every(id => command.order.includes(id))) throw new RuleError('disease order must contain every disease once');
      context.disease_order = command.order;
    }
    tx.combat(1);
    tx.event('disease_penalty_assigned', {instance_id: command.instance_id, attack_type: command.attack_type});
  } else if (phase === 'DUNGEON_PREPARE' && kind === 'AssignStrengthPenalty') {
    const trace = tx.combat(1);
    if (!trace.strength_penalties.some(row => row.instance_id === command.instance_id) ||
        !Object.hasOwn(trace.hero_strength, command.hero_instance_id)) throw new RuleError('invalid single-hero strength penalty assignment');
    (tx.state.battle_context.strength_penalty_assignments ??= {})[command.instance_id] = command.hero_instance_id;
    tx.event('strength_penalty_assigned', {instance_id: command.instance_id, hero_instance_id: command.hero_instance_id});
  } else throw new RuleError(`${kind} is not allowed during ${phase}`);
  if (tx.state.battle_context) reconcileEquipment(tx);
  advanceVillageStages(tx);
  const result = tx.finish();
  validateTurnState(result.state, catalog.cards);
  return {...result, legal_commands: legal(tx)};
}

/** Server-side supply request; the ordinary command path resumes any replacement choice. */
export function takeDisease(state: GameState, playerId: string, destination: string,
                            catalog: GameCatalog, rules: GameRules) {
  if (state.phase !== 'PLAYING') throw new RuleError('disease can only be taken during play');
  if (!state.players?.[playerId]) throw new RuleError(`unknown disease recipient: ${playerId}`);
  if (state.pending_choice !== null) throw new RuleError('resolve the pending choice before taking another disease');
  if (state.players[playerId].eliminated) throw new RuleError('eliminated player cannot receive a disease');
  const zone = `player:${playerId}:${destination}`;
  if (!['hand', 'discard'].includes(destination) || !state.zones[zone])
    throw new RuleError(`invalid disease destination: ${zone}`);
  if (state.rng_state?.algorithm !== 'sha256-counter-v1' ||
      !Number.isSafeInteger(state.rng_state.counter) || state.rng_state.counter < 0)
    throw new RuleError('invalid random state for disease draw');
  for (const name of ['next_instance_sequence', 'next_event_sequence', 'game_version'])
    if (!Number.isSafeInteger(state[name]) || state[name] < 1) throw new RuleError('invalid game sequence for disease draw');
  if (state.catalog_version !== catalog.setup_index.cards_csv_sha256 || state.effects_version !== rules.version)
    throw new RuleError('disease request uses a different catalog or effect revision');
  validateTurnState(state, catalog.cards);
  const tx = new Transition(state, catalog, rules);
  const instanceId = tx.takeDisease(destination, playerId), result = tx.finish();
  validateTurnState(result.state, catalog.cards);
  return {...result, instance_id: instanceId,
    instance: result.state.instances[instanceId] ? structuredClone(result.state.instances[instanceId]) : null};
}
