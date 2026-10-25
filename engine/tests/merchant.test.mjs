import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture} from './support/catalog.mjs';

function merchant(victim = 'TS-0001') {
  const f = fixture(['TS-0221', victim]);
  f.state.chosen_action = 'village'; f.state.subphase = f.state.timing_window = 'VILLAGE_ABILITIES';
  f.state.battle_context = null;
  f.play = command => {
    const input = {...command, player_id: 'alice', expected_version: f.state.game_version};
    const result = server.applyCommand(f.state, input, f.catalog, f.rules);
    assert.deepEqual(browser.applyCommand(f.state, input, f.catalog, f.rules), result);
    f.state = result.state; return result;
  };
  f.play({type: 'ActivateAbility', ability_id: 'TS-0221-A01', source_instance_id: f.hand[0]});
  return f;
}

test('merchant must gain a nonhero after destruction, including rations after destroying a zero-cost militia', () => {
  const f = merchant(), victim = f.hand[1];
  const destroyed = f.play({type: 'ResolveChoice', instance_ids: [victim]});
  assert.ok(destroyed.state.zones.destroyed.includes(victim));
  const command = server.legalCommands(f.state, f.catalog, f.rules)[0];
  assert.equal(command.type, 'ResolveEffectPurchase'); assert.equal(command.may_skip, false);
  assert.deepEqual(command.options.map(option => option.card_id), ['TS-0004']);
  assert.equal(command.options[0].budget, 2);
  const before = structuredClone(f.state);
  for (const card_id of [null, 'TS-0001', 'TS-0002']) {
    assert.throws(() => f.play({type: 'ResolveEffectPurchase', card_id}));
    assert.deepEqual(f.state, before);
  }
  const gained = f.play({type: 'ResolveEffectPurchase', card_id: 'TS-0004'});
  assert.equal(gained.state.pending_choice, null);
  assert.equal(gained.state.subphase, 'VILLAGE_ABILITIES');
  assert.equal(gained.state.zones['player:alice:discard'].length, 1);
  assert.equal(gained.state.instances[gained.state.zones['player:alice:discard'][0]].card_id, 'TS-0004');
  assert.equal(gained.state.players.alice.purchases_remaining, 1);
  assert.equal(gained.state.players.alice.temporary_gold, 0);
  assert.deepEqual(gained.state.supply_rules.basic_card_ids, before.supply_rules.basic_card_ids);
  assert.ok(gained.events.some(event => event.kind === 'effect_card_gained' && event.player_id === 'alice'
    && event.source === 'basic_supply:TS-0004' && event.destination === 'player:alice:discard'));
});

test('merchant takes the actual finite supply top without using the regular purchase', () => {
  const f = merchant('TS-0002'), top = f.add('TS-0221', 'village_supply:merchant');
  f.play({type: 'ResolveChoice', instance_ids: [f.hand[1]]});
  const gained = f.play({type: 'ResolveEffectPurchase', card_id: 'TS-0221'});
  assert.deepEqual(gained.state.zones['village_supply:merchant'], []);
  assert.ok(gained.state.zones['player:alice:discard'].includes(top));
  assert.equal(gained.state.players.alice.purchases_remaining, 1);
  assert.ok(gained.events.some(event => event.kind === 'effect_card_gained' && event.source === 'village_supply:merchant'));
});

test('buy DSL may_skip is strictly boolean and other effects retain optional purchase semantics', () => {
  const ability = {id: 'TS-0221-A99', source_card_id: 'TS-0221', kind: 'activated', source_zone: 'active_hand',
    actions: ['village'], usage: 'once_per_turn', conditions: [], body: {op: 'buy', filter: {tag: '村庄'}, destination: 'discard', maximum_cost: 2, may_skip: 'false'}};
  const f = fixture();
  assert.throws(() => server.compileRuleset({schema_version: server.EFFECTS_SCHEMA_VERSION, abilities: [ability], mechanics: []}, f.cards), /boolean/);
  ability.body.may_skip = true;
  const rules = {...server.compileRuleset({schema_version: server.EFFECTS_SCHEMA_VERSION, abilities: [ability], mechanics: []}, f.cards), version: f.rules.version};
  const other = fixture(['TS-0221']);
  Object.assign(other.state, {chosen_action: 'village', subphase: 'VILLAGE_ABILITIES', timing_window: 'VILLAGE_ABILITIES', battle_context: null});
  // A different optional effect still offers its skip even with affordable cards.
  const result = server.applyCommand(other.state, {type: 'ActivateAbility', player_id: 'alice', ability_id: ability.id,
    source_instance_id: other.hand[0]}, other.catalog, rules);
  assert.equal(result.state.pending_choice.may_skip, true);
  const skipped = server.applyCommand(result.state, {type: 'ResolveEffectPurchase', player_id: 'alice', card_id: null}, other.catalog, rules);
  assert.equal(skipped.state.pending_choice, null);
});
