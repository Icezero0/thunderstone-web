import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCommand, turnOptions, battlePreparation, previewBattleTeam, buildSubmitBattleTeamCommand} from '../dist/index.js';
import {Transition} from '../dist/turn/transaction.js';
import {atom} from '../dist/effects/atoms.js';
import {fixture} from './support/catalog.mjs';
import {affectsBattleOutcome} from '../dist/effects/outcome-impact.js';

test('nested mark-only choices preserve predictability while immediate removal and mixed effects do not', () => {
  const choose = op => ({op: 'if', condition: {exists: {zone: 'active_hand'}}, then: {op: 'select', then: {op}}});
  assert.equal(affectsBattleOutcome(choose('mark_destroy')), false);
  assert.equal(affectsBattleOutcome(choose('destroy')), true);
  assert.equal(affectsBattleOutcome(choose('exclude_combat')), true);
  assert.equal(affectsBattleOutcome({op: 'sequence', children: [choose('mark_destroy'), {op: 'mod_attack', amount: -2}]}), true);
  assert.equal(affectsBattleOutcome({op: 'unknown-op'}), true);
});

test('disease gains to discard are neutral through nested bindings and iterations; combat changes remain uncertain', () => {
  const disease = {op: 'gain_disease', count: 2};
  const nested = child => ({op: 'remember', query: {zone: 'subject_hand'}, bind: 'cards', then: {
    op: 'for_players', scope: 'all', body: {op: 'for_each', query: {zone: 'bound', var: 'cards'}, bind: 'card', body: child}}});
  assert.equal(affectsBattleOutcome(disease), false);
  assert.equal(affectsBattleOutcome({...disease, destination: 'discard'}), false);
  assert.equal(affectsBattleOutcome({...disease, destination: 'hand'}), true);
  assert.equal(affectsBattleOutcome(nested({op: 'sequence', children: [disease, {op: 'mark_destroy'}]})), false);
  for (const op of ['draw', 'destroy', 'discard', 'mod_attack', 'exclude_combat', 'unknown-op'])
    assert.equal(affectsBattleOutcome(nested({op: 'sequence', children: [disease, {op}]})), true, op);
});

for (const monster of ['TS-0479', 'TS-0484', 'TS-0498', 'TS-0524', 'TS-0586', 'TS-0587', 'TS-0588', 'TS-0589', 'TS-0590', 'TS-0591', 'TS-0661', 'TS-0662'])
test(`${monster}: disease/mark-only battle effects do not make the declaration outcome unknown`, () => {
  const f = fixture(['TS-0001', 'TS-0001'], [monster]);
  const prep = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  prep.draft.target_instance_id = f.hall[0];
  const before = structuredClone(f.state), preview = previewBattleTeam(prep.context, prep.draft);
  assert.equal(preview.battle_effects_pending, false);
  assert.deepEqual(f.state, before, 'disease generation still happens only on confirmation');
});

for (const replacement of [null, 'TS-0239', 'TS-0423'])
test(`Deathlord disease gains preserve the forecasted battle total with replacement ${replacement}`, () => {
  const f = fixture(['TS-0001', ...replacement ? [replacement] : []], ['TS-0479', 'TS-0476', 'TS-0477']);
  f.state.battle_context.modifiers = {attack: 100};
  const prep = battlePreparation(f.state, 'alice', f.catalog, f.rules);
  prep.draft.target_instance_id = f.hall[0];
  const preview = previewBattleTeam(prep.context, prep.draft);
  let r = applyCommand(f.state, buildSubmitBattleTeamCommand(prep.context, prep.draft), f.catalog, f.rules);
  r = applyCommand(r.state, {type: 'DeclareBattleTarget', player_id: 'alice', expected_version: r.state.game_version, target_instance_id: f.hall[0]}, f.catalog, f.rules);
  let responses = 0;
  while (r.state.pending_choice && responses++ < 2) {
    assert.equal(r.state.pending_choice.kind, 'disease_replacement');
    r = applyCommand(r.state, {type: 'ResolveDiseaseReplacement', player_id: r.state.pending_choice.player_id}, f.catalog, f.rules);
  }
  assert.equal(responses, replacement === 'TS-0423' ? 2 : 0);
  assert.equal(preview.battle_effects_pending, false);
  assert.equal(r.events.find(event => event.kind === 'battle_resolved').calculation.effective_attack, preview.calculation.effective_attack);
  assert.deepEqual(r.state.zones['player:alice:hand'], f.hand);
  assert.equal(r.state.zones['player:alice:discard'].filter(id => r.state.instances[id].card_id === 'TS-0714').length, replacement === 'TS-0239' ? 0 : 2);
});

test('rations records source and strength on the chosen hero without leaking interpreter bindings', () => {
  const f = fixture(['TS-0004', 'TS-0001', 'TS-0001']);
  let r = applyCommand(f.state, {type: 'ActivateAbility', player_id: 'alice', ability_id: 'TS-0004-A01', source_instance_id: f.hand[0]}, f.catalog, f.rules);
  r = applyCommand(r.state, {type: 'ResolveChoice', player_id: 'alice', instance_ids: [f.hand[1]]}, f.catalog, f.rules);
  const statuses = turnOptions(r.state, 'alice', f.catalog, f.rules).card_statuses;
  assert.deepEqual(statuses[f.hand[1]], [{kind: 'buff', source_card_id: 'TS-0004', source_name: '应急干粮', description: '力量 +2'}]);
  assert.equal(statuses[f.hand[2]], undefined);
  assert.equal(JSON.stringify(statuses[f.hand[1]]).includes(f.hand[0]), false);
  statuses[f.hand[1]][0].description = 'changed';
  assert.equal(turnOptions(r.state, 'alice', f.catalog, f.rules).card_statuses[f.hand[1]][0].description, '力量 +2');
});

test('debuffs, delayed destruction and zero-strength markers have separate visible categories', () => {
  const f = fixture(['TS-0004', 'TS-0001']);
  const tx = new Transition(f.state, f.catalog, f.rules), bindings = {source: f.hand[0], chosen: f.hand[1]};
  atom(tx, {op: 'mod_card', target: {var: 'chosen'}, stat: 'strength', amount: -1}, bindings, 'TS-0004-A01');
  atom(tx, {op: 'mark_destroy', target: {var: 'chosen'}}, bindings, 'TS-0004-A01');
  let statuses = turnOptions(tx.state, 'alice', f.catalog, f.rules).card_statuses[f.hand[1]];
  assert.deepEqual(statuses.map(item => item.kind), ['debuff', 'destroy']);
  assert.equal(statuses[0].description, '力量 -1'); assert.match(statuses[1].description, /仍参与/);
  delete tx.state.instances[f.hand[1]].flags.pending_after_battle_destruction;
  statuses = turnOptions(tx.state, 'alice', f.catalog, f.rules).card_statuses[f.hand[1]];
  assert.deepEqual(statuses.map(item => item.kind), ['debuff']);
  tx.state.instances[f.hand[1]].flags.pending_turn_end_destruction = true;
  assert.equal(turnOptions(tx.state, 'alice', f.catalog, f.rules).card_statuses[f.hand[1]].at(-1).kind, 'destroy');
});

test('Tyxr delayed-destruction choice is predictable and its marked hero contributes until after outcome', () => {
  const f = fixture(['TS-0001', 'TS-0001'], ['TS-0666', 'TS-0476', 'TS-0477']);
  f.state.battle_context.modifiers = {attack: 100};
  const prep = battlePreparation(f.state, 'alice', f.catalog, f.rules); prep.draft.hero_instance_ids = [...f.hand];
  let r = applyCommand(f.state, buildSubmitBattleTeamCommand(prep.context, prep.draft), f.catalog, f.rules);
  const declaration = battlePreparation(r.state, 'alice', f.catalog, f.rules); declaration.draft.target_instance_id = f.hall[0];
  const preview = previewBattleTeam(declaration.context, declaration.draft);
  assert.equal(preview.battle_effects_pending, false);
  r = applyCommand(r.state, {type: 'DeclareBattleTarget', player_id: 'alice', expected_version: r.state.game_version, target_instance_id: f.hall[0]}, f.catalog, f.rules);
  assert.equal(r.state.pending_choice.kind, 'effect_select');
  r = applyCommand(r.state, {type: 'ResolveChoice', player_id: 'alice', instance_ids: [f.hand[0]]}, f.catalog, f.rules);
  const battle = r.events.find(event => event.kind === 'battle_resolved');
  assert.equal(battle.calculation.effective_attack, preview.calculation.effective_attack);
  assert.ok(battle.calculation.components.some(item => item.instance_id === f.hand[0] && item.attack === 1));
  assert.ok(r.events.findIndex(event => event.kind === 'card_destroyed') > r.events.indexOf(battle));
  assert.ok(r.events.findIndex(event => event.kind === 'card_destroyed') < r.events.findIndex(event => event.kind === 'monster_defeated'));
});

for (const attack of [0, 100]) test(`deferred destruction belongs after outcome and before monster departure: attack bonus ${attack}`, () => {
  const f = fixture(['TS-0001', 'TS-0001'], ['TS-0666', 'TS-0476', 'TS-0477']);
  f.state.battle_context.modifiers = {attack};
  const prep = battlePreparation(f.state, 'alice', f.catalog, f.rules); prep.draft.hero_instance_ids = [...f.hand];
  let r = applyCommand(f.state, buildSubmitBattleTeamCommand(prep.context, prep.draft), f.catalog, f.rules);
  r = applyCommand(r.state, {type: 'DeclareBattleTarget', player_id: 'alice', expected_version: r.state.game_version, target_instance_id: f.hall[0]}, f.catalog, f.rules);
  r = applyCommand(r.state, {type: 'ResolveChoice', player_id: 'alice', instance_ids: [f.hand[0]]}, f.catalog, f.rules);
  const events = r.events;
  const outcome = events.findIndex(event => event.kind === 'battle_resolved');
  const destroyed = events.findIndex(event => event.kind === 'card_destroyed' && event.reason === 'after_battle');
  const departed = events.findIndex(event => ['monster_defeated', 'monster_returned_to_deck'].includes(event.kind));
  const refill = events.findIndex(event => event.kind === 'rule_timing' && event.event === 'BEFORE_HALL_REFILL');
  assert.ok(outcome >= 0 && outcome < destroyed && destroyed < departed && departed < refill);
  assert.equal(events[outcome].outcome, attack ? 'win' : 'loss');
});
