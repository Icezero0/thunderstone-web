/** JSON-lines transport only. The shared rules package never imports Node APIs. */
import {createInterface} from 'node:readline';
import {combatValues, monsterHealth, equipmentCapacity, previewBattle, scoreGame, Calculation, printedGold, purchasePrice, stat, ENGINE_VERSION,
  compileRuleset, EffectEvaluation, availableActivations, reusableAbilityIds, validateReuseChoice, planEventDispatch, resolveEventOrder, validateEffectSelection, validateEffectPurchase, evaluateCost, planCardModifier, planMonsterHealthModifier, validateQuery, validateExpression, validateCondition,
  RandomStream, exactInteger, wireInteger, startGame, SetupBuilder, validateRulesConfig, effectiveCopyCount, effectiveGroupCounts, validateSetupState,
  drawCards, sampleDisease, applyResourceEffect, advanceTurn, applyCommand, legalCommands, turnOptions, takeDisease, battlePreparation,
  validateTurnBuffs, grantTurnBuff, destructionReplacement, expireTurnBuffs, planDiseaseGain}
  from '../../engine/dist/index.js';

const operations = {
  runtime_info: () => ({engine_version: ENGINE_VERSION}),
  card_stat: p => stat(p.card, p.key),
  combat_values: p => combatValues(p.input, p.rank, p.target ?? null),
  monster_health: p => monsterHealth(p.input, p.target, p.rank ?? 1, p.target_id),
  equipment_capacity: p => equipmentCapacity(p.input, p.hero_id),
  preview_battle: p => previewBattle(p.context, p.target_id),
  score_game: p => scoreGame(p),
  printed_gold: p => printedGold(new Calculation(p.input), p.card),
  purchase_price: p => purchasePrice(p.input, p.card),
  compile_ruleset: p => compileRuleset(p.source, p.cards),
  effect_query: p => {validateQuery(p.spec); return new EffectEvaluation(p.input).query(p.spec, p.bindings);},
  effect_expression: p => {validateExpression(p.spec); return new EffectEvaluation(p.input).expression(p.spec, p.bindings);},
  effect_condition: p => {validateCondition(p.spec); return new EffectEvaluation(p.input).condition(p.spec, p.bindings);},
  available_activations: p => availableActivations(p),
  reusable_abilities: p => reusableAbilityIds(p, p.instance_id),
  validate_reuse_choice: p => validateReuseChoice(p, p.choice, p.selected),
  plan_event_dispatch: p => planEventDispatch(p),
  resolve_event_order: p => resolveEventOrder(p.choice, p.effect_ids),
  validate_effect_selection: p => validateEffectSelection(p),
  validate_effect_purchase: p => validateEffectPurchase(p),
  evaluate_cost: p => evaluateCost(p),
  plan_card_modifier: p => planCardModifier(p),
  plan_monster_health_modifier: p => planMonsterHealthModifier(p),
  start_game: p => startGame(p),
  validate_config: p => validateRulesConfig(p.config, p.panel),
  effective_group_counts: p => effectiveGroupCounts(p.counts, p.environment),
  effective_copy_count: p => effectiveCopyCount(p.card, p.config),
  validate_setup_state: p => {validateSetupState(p.state, p.cards); return null;},
  random_below: p => {
    const rng = new RandomStream(p.seed, p.counter);
    const value = rng.randbelow(exactInteger(p.size));
    return {value: wireInteger(value), counter: rng.counter};
  },
  random_shuffle: p => {
    const rng = new RandomStream(p.seed, p.counter);
    rng.shuffle(p.values);
    return {values: p.values, counter: rng.counter};
  },
  draw_cards: p => drawCards(p),
  sample_disease: p => sampleDisease(p.supply, p.rng),
  apply_resource_effect: p => applyResourceEffect(p),
  advance_turn: p => advanceTurn(p),
  validate_turn_buffs: p => {validateTurnBuffs(p.turn_number, p.instance, p.card); return null;},
  grant_turn_buff: p => grantTurnBuff(p),
  destruction_replacement: p => destructionReplacement(p.instance, p.card, p.turn_number),
  expire_turn_buffs: p => expireTurnBuffs(p),
  plan_disease_gain: p => planDiseaseGain(p),
  apply_command: p => applyCommand(p.state, p.command, p.catalog, p.ruleset, p.trace_effects ?? false),
  legal_commands: p => legalCommands(p.state, p.catalog, p.ruleset),
  turn_options: p => turnOptions(p.state, p.player_id, p.catalog, p.ruleset, p.prediction ?? false),
  battle_preparation: p => battlePreparation(p.state, p.player_id, p.catalog, p.ruleset),
  take_disease: p => takeDisease(p.state, p.player_id, p.destination ?? 'discard', p.catalog, p.ruleset),
  setup_step: p => {
    const builder = new SetupBuilder(p.input, p.draft);
    const steps = {
      choose_monsters: () => builder.chooseMonsters(),
      choose_feature: () => builder.chooseFeature(p.args[0]),
      draw_features: () => builder.drawFeatures(p.args[0]),
      create: () => builder.create(p.args[0], p.args[1], p.options),
      fill_hall: () => builder.fillHall(p.args[0]),
      build: () => builder.build(),
    };
    if (!Object.hasOwn(steps, p.operation)) throw new Error('unsupported setup step');
    const result = steps[p.operation]();
    return {draft: builder.snapshot(), result: result ?? null};
  },
};
const resources = new Map();
for await (const line of createInterface({input: process.stdin, crlfDelay: Infinity})) {
  let request;
  try {
    request = JSON.parse(line);
    if (request.protocol !== 1 || !Object.hasOwn(operations, request.op)) throw new Error('unsupported engine request');
    let payload = request.payload;
    if (payload.resource_key) {
      const key = payload.resource_key;
      if (payload.resource_definitions) resources.set(key, payload.resource_definitions);
      const definitions = resources.get(key);
      if (!definitions) {const error = new Error('engine resource was evicted'); error.name = 'MissingResource'; throw error;}
      resources.delete(key); resources.set(key, definitions);
      while (resources.size > 4) resources.delete(resources.keys().next().value);
      payload = {...payload, ...definitions};
    }
    const result = operations[request.op](payload);
    process.stdout.write(JSON.stringify({id: request.id, ok: true, result}) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({id: request?.id ?? null, ok: false,
      error: {name: error.name, message: error.message,
        ...(error.issues ? {issues: error.issues} : {}), ...(error.choice ? {choice: error.choice} : {})}}) + '\n');
  }
}
