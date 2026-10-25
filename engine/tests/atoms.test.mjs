import assert from 'node:assert/strict';
import test from 'node:test';
import * as rules from '../dist/index.js';

function evaluation() {
  const cards = {
    hero: {card_id: 'hero', card_type: '英雄牌', subcategory: '甲', tags: '英雄', name: '英雄',
      effect_text: '', 'wiki_力量': '3', 'wiki_英雄等级': '1'},
    weapon: {card_id: 'weapon', card_type: '村庄牌', subcategory: '', tags: '武器', name: '武器',
      effect_text: '', 'wiki_购买价格': '2'},
    monster: {card_id: 'monster', card_type: '地下城牌', subcategory: '怪物', tags: '怪物',
      name: '怪物', effect_text: '', 'wiki_生命值': '3'},
  };
  const state = {active_player_id: 'alice', player_order: ['alice', 'bob'],
    players: {alice: {xp: 4, temporary_gold: 2}, bob: {xp: 1, temporary_gold: 0}},
    instances: {h: {card_id: 'hero', owner_player_id: 'alice', flags: {}},
      w: {card_id: 'weapon', owner_player_id: 'alice', flags: {}},
      m: {card_id: 'monster', owner_player_id: null, flags: {}}},
    zones: {'player:alice:hand': ['h','w'], 'player:alice:control': [],
      'player:bob:hand': [], 'player:bob:control': [], 'hall:main': ['m']},
    active_settings: [], chosen_action: 'dungeon', used_cards: [],
    battle_context: {equipped_weapon_by_hero: {}, card_modifiers: {}}};
  return {cards, mechanics: [], state};
}
const ability = {id: 'hero-A01', source_card_id: 'hero', kind: 'activated',
  source_zone: 'active_hand', usage: 'once_per_turn', actions: ['dungeon'], event: null,
  conditions: [], body: {op: 'draw', count: 1}};
const activation = (input, uses = {}) => ({evaluation: input, abilities: [ability], turn_number: 2, ability_uses: uses});

test('activation availability checks source identity, action and usage', () => {
  const input = evaluation();
  assert.deepEqual(rules.availableActivations(activation(input)), [{ability_id: ability.id, source_instance_id: 'h'}]);
  assert.deepEqual(rules.availableActivations(activation(input, {'h:hero-A01': 2})), []);
  input.state.chosen_action = 'village';
  assert.deepEqual(rules.availableActivations(activation(input)), []);
});
test('reusable ability validates a used hand source and offered choice', () => {
  const input = evaluation();
  input.state.used_cards = ['h'];
  assert.deepEqual(rules.reusableAbilityIds(activation(input), 'h'), ['hero-A01']);
  assert.equal(rules.validateReuseChoice(activation(input), {kind: 'effect_reuse',
    reused_instance_id: 'h', options: ['hero-A01']}, 'hero-A01'), 'hero-A01');
  assert.throws(() => rules.validateReuseChoice(activation(input), {kind: 'effect_reuse',
    reused_instance_id: 'h', options: ['other']}, 'other'), /no longer available/);
});
test('event dispatch selects hand triggers and consumes one-shot listeners', () => {
  const input = evaluation();
  const plan = rules.planEventDispatch({evaluation: input, abilities: [{...ability, kind: 'triggered', event: 'TURN_START'}],
    listeners: [{event: 'TURN_START', ability_id: 'extra', source_instance_id: 'h',
      body: {op: 'draw', count: 1}, bindings: {}, conditions: [], once: true}], scheduled: [],
    event: 'TURN_START', turn_number: 2, repeatable_ability_ids: []});
  assert.equal(plan.mode, 'sequence');
  assert.deepEqual(plan.consumed_listener_indices, [0]);
  assert.equal(plan.candidates.length, 2);
});
test('event ordering requires every offered effect exactly once', () => {
  const effects = [{effect_id: 'a'}, {effect_id: 'b'}];
  assert.deepEqual(rules.resolveEventOrder({kind: 'effect_order', effects}, ['b','a']), [effects[1], effects[0]]);
  assert.throws(() => rules.resolveEventOrder({kind: 'effect_order', effects}, ['a','a']), /every effect once/);
});
test('selection revalidates live candidates and source continuation', () => {
  const input = evaluation();
  const choice = {kind: 'effect_select', ability_id: 'hero-A01', source_instance_id: 'h',
    candidate_instance_ids: ['h','w'], min_count: 1, max_count: 1,
    query: {zone: 'active_hand'}, bindings: {source: 'h'}, constraints: []};
  const request = {evaluation: input, choice, frame: {ability_id: 'hero-A01', source_instance_id: 'h'},
    source_card_id: 'hero', selected_id: 'w'};
  assert.deepEqual(rules.validateEffectSelection(request), ['w']);
  input.state.zones['player:alice:hand'].pop();
  assert.throws(() => rules.validateEffectSelection(request), /no longer a legal candidate/);
});
test('effect purchase checks fixed choice and live payment card', () => {
  const input = evaluation();
  const choice = {kind: 'effect_purchase', ability_id: 'hero-A01', source_instance_id: 'h',
    options: [{card_id: 'weapon'}], payment: 'discard_source', bindings: {source: 'h'}};
  assert.deepEqual(rules.validateEffectPurchase({evaluation: input, choice,
    source_card_id: 'hero', card_id: 'weapon'}), {payment_op: 'discard'});
  input.state.zones['player:alice:hand'].shift();
  assert.throws(() => rules.validateEffectPurchase({evaluation: input, choice,
    source_card_id: 'hero', card_id: 'weapon'}), /payment is unavailable/);
});
test('card costs distinguish XP and removal from current hand', () => {
  const input = evaluation();
  assert.equal(rules.evaluateCost({evaluation: input, cost: {op: 'spend_xp', amount: 4}, bindings: {_subject: 'alice'}}).payable, true);
  assert.equal(rules.evaluateCost({evaluation: input, cost: {op: 'spend_xp', amount: 5}, bindings: {_subject: 'alice'}}).payable, false);
  assert.equal(rules.evaluateCost({evaluation: input, cost: {op: 'discard', target: {var: 'source'}}, bindings: {source: 'h'}}).payable, true);
});
test('card-local modifiers accumulate without mutating the evaluation snapshot', () => {
  const input = evaluation();
  const patch = rules.planCardModifier({evaluation: input, node: {op: 'mod_card', target: {var: 'hero'}, stat: 'attack', amount: 2},
    bindings: {hero: 'h'}, subphase: 'DUNGEON_PREPARE'});
  assert.deepEqual(patch, {instance_id: 'h', field: 'attack', amount: 2, value: 2, reconcile_equipment: false});
  assert.deepEqual(input.state.battle_context.card_modifiers, {});
});
test('draw reshuffles discard only when the draw pile is exhausted', () => {
  const result = rules.drawCards({draw: ['a'], discard: ['b','c'], hand: [], count: 3,
    rng: {algorithm: rules.RNG_VERSION, seed: 'draw', counter: 0}});
  assert.equal(result.taken[0], 'a');
  assert.equal(result.taken.length, 3);
  assert.equal(result.shuffle_orders.length, 1);
  assert.deepEqual(result.discard, []);
});
test('empty draws keep the zones and counter stable', () => {
  const result = rules.drawCards({draw: [], discard: [], hand: ['a'], count: 4,
    rng: {algorithm: rules.RNG_VERSION, seed: 'empty', counter: 0}});
  assert.deepEqual(result.taken, []);
  assert.deepEqual(result.hand, ['a']);
  assert.equal(result.counter, 0);
});
test('weighted disease sampling is deterministic and within its supply', () => {
  const supply = {disease_infinite: true, disease_card_ids: ['a','b'], disease_weights: {a: 1,b: 3}};
  const rng = {algorithm: rules.RNG_VERSION, seed: 'disease', counter: 0};
  const first = rules.sampleDisease(supply, rng);
  assert.deepEqual(rules.sampleDisease(supply, rng), first);
  assert.ok(['a','b'].includes(first.card_id));
  assert.equal(first.total_weight, 4);
});
test('resource effects target the subject XP and active player gold', () => {
  const base = {amount: 2, subject_id: 'bob', active_player_id: 'alice', subject_xp: 1,
    active_gold: 3, active_purchases: 1, chosen_action: 'village', battle_context: null,
    source_instance_id: null};
  assert.deepEqual(rules.applyResourceEffect({...base, op: 'gain_xp'}), {player_id: 'bob', field: 'xp', value: 3});
  assert.deepEqual(rules.applyResourceEffect({...base, op: 'mod_gold'}), {player_id: 'alice', field: 'temporary_gold', value: 5});
  assert.throws(() => rules.applyResourceEffect({...base, op: 'spend_xp'}), /insufficient XP/);
});
test('turn rotation skips eliminated seats and honors extra turns', () => {
  const base = {player_order: ['alice','bob','cara'], first_player_id: 'alice', current_player_id: 'alice',
    players: {alice: {extra_turns: 1}, bob: {eliminated: true}, cara: {}}, turn_number: 2, round_number: 1};
  assert.equal(rules.advanceTurn(base).next_player_id, 'alice');
  assert.equal(rules.advanceTurn({...base, players: {...base.players, alice: {extra_turns: 0}}}).next_player_id, 'cara');
});
test('hero destruction buff grants once, substitutes discard and expires', () => {
  const card = evaluation().cards.hero, instance = {owner_player_id: 'alice', flags: {}};
  const input = {instance, card, in_active_hand: true, turn_number: 2,
    buff: 'discard_instead_of_destroy', ability_id: 'buff', source_instance_id: 'h'};
  const granted = rules.grantTurnBuff(input);
  assert.equal(granted.turn_buffs.length, 1);
  assert.equal(rules.grantTurnBuff({...input, instance: {...instance, flags: {turn_buffs: granted.turn_buffs}}}).granted, null);
  assert.ok(rules.destructionReplacement({...instance, flags: {turn_buffs: granted.turn_buffs}}, card, 2));
  assert.equal(rules.expireTurnBuffs({turn_number: 2, instances: [{instance_id: 'h', turn_buffs: granted.turn_buffs}]}).length, 1);
});
function gainInput() {
  return {mode: 'advance', gain: {instance_id: 'd', player_id: 'alice', destination: 'discard', used_sources: []},
    instance_exists: true, instance_count: 2, player_order: ['alice','bob'], players: {alice: {}, bob: {}},
    hands: {alice: ['h'], bob: []}, source_card_ids: {h: ['hero']},
    rules: [{id: 'replace', source_card_id: 'hero', action: 'redirect'}]};
}
test('disease gain replacement redirects once per source and completes', () => {
  const input = gainInput(), plan = rules.planDiseaseGain(input);
  assert.equal(plan.done, false);
  assert.deepEqual(plan.actions.map(item => item.op), ['apply_source','pause']);
  const pause = plan.actions.at(-1);
  const resolved = rules.planDiseaseGain({...input, mode: 'resolve', pending_choice: {kind: 'disease_replacement', player_id: 'alice', stage: 'recipient', options: ['bob']},
    resolution_frames: [{kind: 'disease_gain', gain: pause.gain}], source_instance_id: null, recipient_id: 'bob'});
  assert.equal(resolved.done, true); assert.deepEqual(resolved.actions.map(item => item.op), ['redirect', 'complete']);
  assert.equal(resolved.actions.at(-1).gain.player_id, 'bob');
});
test('disease replacement rejects stale source choices', () => {
  const input = gainInput();
  input.mode = 'resolve';
  input.pending_choice = {kind: 'disease_replacement', player_id: 'alice', stage: 'source',
    options: [{source_instance_id: 'h', ability_id: 'replace', action: 'redirect'}]};
  input.resolution_frames = [{kind: 'disease_gain', gain: input.gain}];
  input.source_instance_id = 'missing';
  assert.throws(() => rules.planDiseaseGain(input), /invalid disease replacement source/);
});
