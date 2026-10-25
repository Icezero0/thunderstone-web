import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../dist/index.js';
import {Transition} from '../dist/turn/transaction.js';
import {reconcileEquipment} from '../dist/battle/equipment.js';
import {fixture} from './support/catalog.mjs';

const command = (f, state, type, fields = {}) => engine.applyCommand(state,
  {type, player_id: 'alice', expected_version: state.game_version, ...fields}, f.catalog, f.rules);

for (const protectedHero of [false, true]) test(`zero strength shares battle destruction, survives recovery and resolves once: protection ${protectedHero}`, () => {
  const f = fixture(['TS-0302', 'TS-0247'], ['TS-0476', 'TS-0477', 'TS-0476']);
  const [hero, blade] = f.hand;
  f.state.battle_context.card_modifiers = {[hero]: {strength: 100}};
  if (protectedHero) f.state = command(f, f.state, 'EquipWeapon', {hero_instance_id: hero, weapon_instance_id: blade}).state;
  const tx = new Transition(f.state, f.catalog, f.rules);
  tx.state.battle_context.card_modifiers[hero].strength = -100;
  reconcileEquipment(tx, true); reconcileEquipment(tx, true);
  assert.equal(tx.state.instances[hero].flags.pending_after_battle_destruction, true);
  assert.equal(tx.state.instances[hero].flags.pending_turn_end_destruction, undefined);
  assert.equal(tx.events.filter(event => event.kind === 'hero_zero_strength_marked').length, 1);
  const marker = engine.turnOptions(tx.state, 'alice', f.catalog, f.rules).card_statuses[hero].find(status => status.kind === 'destroy');
  assert.match(marker.description, /本场战斗结束后摧毁/);
  tx.state.battle_context.card_modifiers[hero].strength = 100;
  reconcileEquipment(tx, true); assert.equal(tx.state.instances[hero].flags.pending_after_battle_destruction, true);
  const prepared = engine.battlePreparation(tx.state, 'alice', f.catalog, f.rules);
  let result = engine.applyCommand(tx.state, engine.buildSubmitBattleTeamCommand(prepared.context, prepared.draft), f.catalog, f.rules);
  result = command(f, result.state, 'DeclareBattleTarget', {target_instance_id: f.hall[0]});
  const events = result.events, removedKind = protectedHero ? 'card_destruction_replaced' : 'card_destroyed';
  const removal = events.findIndex(event => event.kind === removedKind && event.instance_id === hero);
  const battle = events.findIndex(event => event.kind === 'battle_resolved');
  const departure = events.findIndex(event => ['monster_defeated', 'monster_returned_to_deck'].includes(event.kind));
  assert.ok(battle < removal && removal < departure);
  assert.ok(events[battle].calculation.components.some(row => row.instance_id === hero));
  assert.equal(result.state.instances[hero].flags.pending_after_battle_destruction, undefined);
  assert.ok(result.state.zones[protectedHero ? 'player:alice:discard' : 'destroyed'].includes(hero));
  const ended = command(f, result.state, 'FinishTurn');
  assert.equal(ended.events.some(event => ['card_destroyed', 'card_destruction_replaced'].includes(event.kind) && event.instance_id === hero), false);
});

test('removing a strength aura creates and drains dependent zero-strength marks before the monster leaves', () => {
  const f = fixture(['TS-0302', 'TS-0001'], ['TS-0476', 'TS-0477', 'TS-0476']), [source, hero] = f.hand;
  f.rules = {...f.rules, mechanics: [...f.rules.mechanics, {id: 'test-strength-aura', source_card_id: 'TS-0302', source_line: '',
    op: 'hero_aura', params: {strength: 2, exclude_source: true, filter: {tag: '英雄'}}}]};
  f.state.instances[source].flags.pending_after_battle_destruction = true;
  f.state.battle_context.card_modifiers = {[hero]: {strength: -2}};
  const prepared = engine.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  let result = engine.applyCommand(f.state, engine.buildSubmitBattleTeamCommand(prepared.context, prepared.draft), f.catalog, f.rules);
  assert.equal(result.state.instances[hero].flags.pending_after_battle_destruction, undefined);
  result = command(f, result.state, 'DeclareBattleTarget', {target_instance_id: f.hall[0]});
  for (const id of [source, hero]) assert.ok(result.state.zones.destroyed.includes(id));
  const deaths = result.events.filter(event => event.kind === 'card_destroyed' && f.hand.includes(event.instance_id));
  assert.deepEqual(deaths.map(event => event.instance_id), [source, hero]);
  assert.ok(deaths.every(event => event.sequence < result.events.find(event => ['monster_defeated', 'monster_returned_to_deck'].includes(event.kind)).sequence));
});

test('preventing zero-strength destruction succeeds without repeatedly marking the same hero during cleanup', () => {
  const f = fixture(['TS-0001', 'TS-0229'], ['TS-0476', 'TS-0477', 'TS-0476']), [hero, protector] = f.hand;
  f.state.battle_context.card_modifiers = {[hero]: {strength: -100}};
  const prepared = engine.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  let result = engine.applyCommand(f.state, engine.buildSubmitBattleTeamCommand(prepared.context, prepared.draft), f.catalog, f.rules);
  result = command(f, result.state, 'DeclareBattleTarget', {target_instance_id: f.hall[0]});
  assert.equal(result.state.pending_choice.kind, 'effect_response');
  result = command(f, result.state, 'ResolveResponse', {source_instance_id: protector, recipient_id: null});
  assert.equal(result.state.pending_choice, null); assert.equal(result.state.subphase, 'ACTION_END');
  assert.ok(result.state.zones['player:alice:hand'].includes(hero));
  assert.equal(result.state.instances[hero].flags.pending_after_battle_destruction, undefined);
  assert.equal(result.events.some(event => event.kind === 'card_destroyed' && event.instance_id === hero), false);
});
