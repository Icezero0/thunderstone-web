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
    active_settings: [], chosen_action: null, battle_context: null, pending_choice: null,
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
  const finish = {type: 'FinishRest', player_id: 'alice', expected_version: 2};
  const completed = server.applyCommand(entered.state, finish, catalog, rules);
  assert.deepEqual(browser.applyCommand(entered.state, finish, catalog, rules), completed);
  assert.equal(completed.state.turn_number, 2);
  assert.equal(completed.state.game_version, 3);
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
