import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';

function fixture() {
  const catalog = {cards: {
    'TS-0001': {card_id: 'TS-0001', card_type: '基础牌', subcategory: '', tags: '民兵|英雄',
      name: '民兵', effect_text: '攻击 +1。', '正文_基础攻击': '1', 'wiki_力量': '2'},
    'TS-0714': {card_id: 'TS-0714', card_type: '疾病牌', subcategory: '', tags: '疾病',
      name: '疾病', effect_text: ''},
  }, setup_index: {cards_csv_sha256: 'catalog-v1', groups: []}};
  const rules = {version: 'effects-v1', abilities: [], mechanics: []};
  const state = {phase: 'PLAYING', subphase: 'TURN_START', timing_window: 'TURN_START_BEFORE',
    ruleset_version: server.RULESET_VERSION, catalog_version: 'catalog-v1', effects_version: 'effects-v1',
    game_version: 1, turn_number: 1, round_number: 1, next_instance_sequence: 2,
    next_event_sequence: 1, player_order: ['alice'], first_player_id: 'alice', active_player_id: 'alice',
    players: {alice: {xp: 0, temporary_gold: 0, purchases_remaining: 1, eliminated: false}},
    instances: {'CI-000001': {card_id: 'TS-0001', owner_player_id: 'alice', origin: 'starter', flags: {}}},
    zones: {'player:alice:draw': [], 'player:alice:hand': ['CI-000001'], 'player:alice:discard': [],
      'player:alice:control': [], destroyed: [], 'hall:main': [], 'dungeon:main': [], 'pending:disease': []},
    active_settings: [], chosen_action: null, turn_hand_public: true, battle_context: null, pending_choice: null,
    resolution_frames: [], registered_triggers: [], scheduled_effects: [], workflow_steps: [],
    continuous_effects: [], ability_uses: {}, used_cards: [],
    supply_rules: {basic_card_ids: ['TS-0001'], disease_infinite: true,
      disease_card_ids: ['TS-0714'], disease_weights: {'TS-0714': 1}, disease_mode: 'ordinary'},
    rng_state: {algorithm: 'sha256-counter-v1', seed: 'turn-test', counter: 0}};
  return {catalog, rules, state};
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('Node and browser execute an immutable rest turn with identical state and events', () => {
  const {catalog, rules, state} = fixture();
  freeze(state);
  const choose = {type: 'ChooseAction', player_id: 'alice', expected_version: 1, action: 'rest'};
  const entered = server.applyCommand(state, choose, catalog, rules);
  assert.deepEqual(browser.applyCommand(state, choose, catalog, rules), entered);
  assert.equal(state.subphase, 'TURN_START');
  assert.equal(entered.state.subphase, 'REST');
  assert.equal(entered.state.turn_hand_public, true);
  assert.throws(() => server.applyCommand(entered.state,
    {type: 'FinishTurn', player_id: 'alice', expected_version: 2}, catalog, rules), /not allowed during REST/);
  const skip = {type: 'SkipRestDestroy', player_id: 'alice', expected_version: 2};
  const ready = server.applyCommand(entered.state, skip, catalog, rules);
  assert.deepEqual(browser.applyCommand(entered.state, skip, catalog, rules), ready);
  assert.equal(ready.state.subphase, 'ACTION_END'); assert.equal(ready.state.turn_number, 1);
  assert.equal(ready.state.turn_hand_public, true);
  assert.deepEqual(ready.legal_commands, [{type: 'FinishTurn'}]);
  assert.throws(() => server.applyCommand(ready.state,
    {type: 'RestDestroy', player_id: 'alice', expected_version: 3, instance_id: 'CI-000001'}, catalog, rules), /not allowed during ACTION_END/);
  const finish = {type: 'FinishTurn', player_id: 'alice', expected_version: 3};
  const completed = server.applyCommand(ready.state, finish, catalog, rules);
  assert.deepEqual(browser.applyCommand(ready.state, finish, catalog, rules), completed);
  assert.equal(completed.state.turn_number, 2);
  assert.equal(completed.state.turn_hand_public, true);
  assert.equal(completed.state.game_version, 4);
  assert.deepEqual(completed.legal_commands, [{type: 'ChooseAction', actions: ['village', 'rest']}]);
  assert.throws(() => server.applyCommand(entered.state, {...finish, expected_version: 1}, catalog, rules), /stale game version/);
});

test('standalone disease gain creates one instance and leaves the input unchanged', () => {
  const {catalog, rules, state} = fixture();
  freeze(state);
  const result = server.takeDisease(state, 'alice', 'hand', catalog, rules);
  assert.deepEqual(browser.takeDisease(state, 'alice', 'hand', catalog, rules), result);
  assert.equal(state.next_instance_sequence, 2);
  assert.equal(result.instance.card_id, 'TS-0714');
  assert.equal(result.state.zones['player:alice:hand'].at(-1), result.instance_id);
  assert.equal(result.state.game_version, 2);
});

test('rest destruction is once per turn and waits for an explicit FinishTurn in Node and browser', () => {
  const {catalog, rules, state} = fixture();
  state.instances['CI-000002'] = {...structuredClone(state.instances['CI-000001']), card_id: 'TS-0714'};
  state.zones['player:alice:hand'].push('CI-000002'); state.next_instance_sequence = 3;
  const entered = server.applyCommand(state, {type: 'ChooseAction', player_id: 'alice', expected_version: 1, action: 'rest'}, catalog, rules);
  const command = {type: 'RestDestroy', player_id: 'alice', expected_version: 2, instance_id: 'CI-000001'};
  const destroyed = server.applyCommand(entered.state, command, catalog, rules);
  assert.deepEqual(browser.applyCommand(entered.state, command, catalog, rules), destroyed);
  assert.equal(destroyed.state.turn_number, 1); assert.equal(destroyed.state.subphase, 'ACTION_END');
  assert.deepEqual(destroyed.state.zones['player:alice:hand'], ['CI-000002']);
  assert.deepEqual(destroyed.legal_commands, [{type: 'FinishTurn'}]);
  assert.equal(destroyed.events.some(event => event.kind === 'turn_hand_discarded' || event.kind === 'TURN_ENDED'), false);
  const before = structuredClone(destroyed.state);
  assert.throws(() => server.applyCommand(destroyed.state, {...command, expected_version: 3, instance_id: 'CI-000002'}, catalog, rules), /not allowed during ACTION_END/);
  assert.deepEqual(destroyed.state, before);
  const finish = {type: 'FinishTurn', player_id: 'alice', expected_version: 3};
  const finished = server.applyCommand(destroyed.state, finish, catalog, rules);
  assert.deepEqual(browser.applyCommand(destroyed.state, finish, catalog, rules), finished);
  assert.equal(finished.state.turn_number, 2);
  const next = server.applyCommand(finished.state, {type: 'ChooseAction', player_id: 'alice', expected_version: 4, action: 'rest'}, catalog, rules);
  assert.deepEqual(next.legal_commands.find(command => command.type === 'RestDestroy').instance_ids, ['CI-000002']);
});

test('purchase options quote effective prices and agree with the authoritative charge', () => {
  for (const discount of [0, 2, 8]) {
    const {catalog, rules, state} = fixture();
    catalog.cards['TS-0001']['wiki_购买价格'] = '3';
    state.subphase = state.timing_window = 'VILLAGE_BUY';
    state.players.alice.temporary_gold = 5;
    rules.mechanics = [{id: 'test-price', source_card_id: 'TS-0001', op: 'economy',
      params: {hero_discount: discount, all_surcharge: 1}}];
    const expected = Math.max(0, 4 - discount);
    const options = server.legalCommands(state, catalog, rules);
    assert.deepEqual(browser.legalCommands(state, catalog, rules), options);
    assert.deepEqual(options.find(item => item.type === 'BuyCard').options,
      [{card_id: 'TS-0001', price: expected}]);
    const bought = server.applyCommand(state, {type: 'BuyCard', player_id: 'alice',
      expected_version: 1, card_id: 'TS-0001'}, catalog, rules);
    assert.equal(bought.state.players.alice.temporary_gold, 5 - expected);
    assert.equal(bought.events.find(event => event.kind === 'card_bought').price, expected);
  }
});
