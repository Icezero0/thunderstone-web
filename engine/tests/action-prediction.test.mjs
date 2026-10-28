import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCommand, projectActionPrediction, predictAction, RULESET_VERSION} from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';

function fixture(phase = 'VILLAGE_ABILITIES') {
  const base = {card_type: '基础牌', tags: '英雄|民兵', subcategory: '', name: '民兵', 'wiki_金币值': '2',
    'wiki_购买价格': '0', 'wiki_英雄等级': '0', upgrade_xp_cost: '2'};
  const catalog = {cards: {m: {...base, card_id: 'm'}, h: {...base, card_id: 'h', name: '英雄', tags: '英雄',
    card_type: '英雄牌', subcategory: '测试', 'wiki_英雄等级': '1', 'wiki_购买价格': '2'}},
    setup_index: {cards_csv_sha256: 'catalog', groups: [{kind: 'hero', randomizer_id: 'r', members: ['h']}]}};
  const rules = {version: 'rules', abilities: [], mechanics: []};
  const state = {phase: 'PLAYING', subphase: phase, timing_window: phase, game_version: 1, turn_number: 1, round_number: 1,
    next_instance_sequence: 6, next_event_sequence: 1, ruleset_version: RULESET_VERSION, effects_version: 'rules', catalog_version: 'catalog',
    player_order: ['a', 'b'], first_player_id: 'a', active_player_id: 'a', chosen_action: 'village', turn_hand_public: true,
    players: {a: {xp: 3, temporary_gold: 0, purchases_remaining: 2}, b: {xp: 0, temporary_gold: 0, purchases_remaining: 1}},
    zones: {'player:a:hand': ['hand'], 'player:a:draw': ['secret-draw'], 'player:a:discard': [], 'player:a:control': [],
      'player:b:hand': ['secret-hand'], 'player:b:draw': [], 'player:b:discard': [], 'player:b:control': [],
      'hero_supply:r': ['supply1', 'supply2'], 'dungeon:main': ['secret-dungeon'], 'hall:main': [], destroyed: []},
    instances: Object.fromEntries([['hand','m','a'], ['secret-draw','m','a'], ['secret-hand','m','b'],
      ['supply1','h',null], ['supply2','h',null], ['secret-dungeon','m',null]].map(([id,card_id,owner_player_id]) =>
        [id, {card_id, owner_player_id, origin: 'test', flags: {}}])),
    pending_choice: null, battle_context: null, active_settings: [], resolution_frames: [], registered_triggers: [], scheduled_effects: [],
    workflow_steps: [], ability_uses: {}, used_cards: [], supply_rules: {basic_card_ids: ['m']},
    rng_state: {algorithm: 'sha256-counter-v1', seed: 'private-random-seed', counter: 17}};
  return {state, catalog, rules};
}

test('projection excludes RNG, all draw piles, hidden hands, private flags and unrelated catalogue data', () => {
  const {state, catalog, rules} = fixture();
  state.secret = 'private'; catalog.cards.secret = {...catalog.cards.m, card_id: 'secret'};
  const context = projectActionPrediction(state, 'a', catalog, rules), wire = JSON.stringify(context);
  for (const secret of ['private-random-seed', 'secret-draw', 'secret-hand', 'secret-dungeon', 'private']) assert.ok(!wire.includes(secret));
  assert.equal(projectActionPrediction(state, 'b', catalog, rules), null);
  assert.deepEqual(context.state.zones['player:a:draw'], []);
  context.state.zones['player:a:hand'].pop(); assert.deepEqual(state.zones['player:a:hand'], ['hand']);
});

test('browser predictions match real village transitions, gold accounting, purchases and upgrades across several commands', () => {
  let {state, catalog, rules} = fixture();
  let context = projectActionPrediction(state, 'a', catalog, rules);
  for (const command of [{type: 'FinishAbilities'}, {type: 'BuyCard', card_id: 'm'}, {type: 'FinishBuying'},
    {type: 'UpgradeHero', source_instance_id: 'hand', target_card_id: 'h'}]) {
    const prediction = browser.predictAction(context, command); assert.ok(prediction, command.type);
    const actual = applyCommand(state, {...command, player_id: 'a', expected_version: state.game_version}, catalog, rules);
    assert.deepEqual(prediction.events, actual.events); assert.deepEqual(prediction.legal_commands, actual.legal_commands);
    for (const key of ['subphase', 'players', 'next_instance_sequence', 'next_event_sequence']) assert.deepEqual(prediction.state[key], actual.state[key]);
    for (const zone of ['player:a:hand', 'player:a:discard', 'hero_supply:r']) assert.deepEqual(prediction.state.zones[zone], actual.state.zones[zone]);
    context = prediction.context; state = actual.state;
  }
  assert.equal(predictAction(context, {type: 'FinishTurn'}), null);
});

test('rest destruction is predicted but random draws, activated effects and trigger-dependent purchases are barriers', () => {
  const {state, catalog, rules} = fixture('REST'); state.chosen_action = 'rest';
  const context = projectActionPrediction(state, 'a', catalog, rules);
  const result = predictAction(context, {type: 'RestDestroy', instance_id: 'hand'});
  assert.equal(result.state.subphase, 'ACTION_END'); assert.deepEqual(result.state.zones['player:a:hand'], []);
  assert.deepEqual(result.events, applyCommand(state, {type: 'RestDestroy', instance_id: 'hand', player_id: 'a'}, catalog, rules).events);
  assert.equal(predictAction(context, {type: 'ActivateAbility'}), null);
  assert.equal(predictAction({...context, engine_version: 'old-build'}, {type: 'SkipRestDestroy'}), null);
  rules.abilities = [{source_card_id: 'm', kind: 'triggered', event: 'CARD_PURCHASED'}];
  assert.equal(predictAction(projectActionPrediction(state, 'a', catalog, rules), {type: 'BuyCard', card_id: 'm'}), null);
  for (const field of ['scheduled_effects', 'registered_triggers', 'continuous_effects', 'attachments', 'copied_heroes']) {
    assert.equal(projectActionPrediction({...state, [field]: [{private: 'condition'}]}, 'a', catalog, rules), null);
  }
  state.instances.hand.flags.turn_buffs = [{private: true}];
  assert.equal(projectActionPrediction(state, 'a', catalog, rules), null);
});
