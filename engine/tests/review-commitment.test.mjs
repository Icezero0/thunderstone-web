import assert from 'node:assert/strict';
import test from 'node:test';
import * as engine from '../dist/index.js';
import {fixture} from './support/catalog.mjs';

function run(f, type, fields = {}) {
  const result = engine.applyCommand(f.state, {type, player_id: f.state.pending_choice?.player_id ?? 'alice',
    expected_version: f.state.game_version, ...fields}, f.catalog, f.rules);
  f.state = result.state;
  return result;
}
function submit(f, edit = draft => draft) {
  const {draft} = engine.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  edit(draft);
  return run(f, 'SubmitBattleTeam', {draft});
}
function finishChoices(f, result, pick) {
  const events = [...result.events]; let steps = 0;
  while (f.state.pending_choice || f.state.subphase === 'DUNGEON_DECLARE') {
    assert.ok(++steps < 20, 'a committed battle must not loop or strand a choice');
    const c = f.state.pending_choice;
    const next = !c ? run(f, 'DeclareBattleTarget', {target_instance_id: f.hall[0]}) : c.kind === 'effect_order'
      ? run(f, 'ResolveEffectOrder', {effect_ids: c.effects.map(e => e.effect_id)})
      : c.kind === 'effect_select'
        ? run(f, 'ResolveChoice', {instance_id: pick ?? c.candidate_instance_ids[0]})
        : assert.fail(`unexpected choice ${c.kind}`);
    events.push(...next.events);
  }
  return events;
}

test('plague is deferred until commitment and a preparation buff can prevent zero strength', () => {
  const f = fixture(['TS-0001', 'TS-0717', 'TS-0717', 'TS-0004'], ['TS-0476']);
  const [hero, , , ration] = f.hand;
  assert.equal(engine.combatValues(f).hero_strength[hero], 2);
  assert.equal(f.state.instances[hero].flags.pending_after_battle_destruction, undefined);
  run(f, 'ActivateAbility', {ability_id: 'TS-0004-A01', source_instance_id: ration});
  assert.equal(engine.combatValues(f).hero_strength[hero], 4);
  const events = finishChoices(f, submit(f));
  assert.equal(events.filter(e => e.kind === 'ability_resolved' && e.ability_id === 'TS-0717-A01').length, 2);
  assert.equal(events.find(e => e.kind === 'battle_resolved').calculation.hero_strength[hero], 2);
  assert.equal(events.some(e => e.kind === 'hero_zero_strength_marked'), false);
  assert.ok(!f.state.zones.destroyed.includes(hero));
});

test('commitment applies each plague once and marks a zero-strength benched hero', () => {
  const f = fixture(['TS-0001', 'TS-0717', 'TS-0717'], ['TS-0476']);
  const hero = f.hand[0];
  const events = finishChoices(f, submit(f, draft => {draft.hero_instance_ids = [];}));
  assert.equal(events.filter(e => e.kind === 'ability_resolved' && e.ability_id === 'TS-0717-A01').length, 2);
  assert.equal(events.filter(e => e.kind === 'hero_zero_strength_marked' && e.instance_id === hero).length, 1);
  assert.equal(f.state.subphase, 'ACTION_END');
  assert.ok(f.state.zones.destroyed.includes(hero));
  const battle = events.findIndex(e => e.kind === 'battle_resolved');
  const destroyed = events.findIndex(e => e.kind === 'card_destroyed' && e.instance_id === hero);
  const departed = events.findIndex(e => ['monster_defeated', 'monster_returned_to_deck'].includes(e.kind));
  assert.ok(battle < destroyed && destroyed < departed);
  assert.equal(run(f, 'FinishTurn').events.some(e => e.kind === 'card_destroyed' && e.instance_id === hero), false);
});

test('fatigue requests a hand-hero choice after submit, then drops overweight equipment and finishes', () => {
  const f = fixture(['TS-0001', 'TS-0001', 'TS-0718', 'TS-0002'], ['TS-0476']);
  const [hero, bench, , dagger] = f.hand;
  const submitted = submit(f, draft => {draft.hero_instance_ids = [hero]; draft.equipment = {[hero]: [dagger]};});
  assert.equal(f.state.subphase, 'BATTLE_COMMIT');
  assert.equal(f.state.pending_choice.ability_id, 'TS-0718-A01');
  assert.equal(f.state.battle_context.target_instance_id, undefined);
  assert.deepEqual(new Set(f.state.pending_choice.candidate_instance_ids), new Set([hero, bench]));
  assert.throws(() => run(f, 'ActivateAbility', {ability_id: 'TS-0004-A01', source_instance_id: dagger}), /choice must be resolved/);
  const events = finishChoices(f, submitted, hero);
  assert.ok(events.some(e => e.kind === 'weapon_dropped' && e.weapon_instance_id === dagger));
  assert.equal(f.state.subphase, 'ACTION_END');
  run(f, 'FinishTurn');
  assert.ok(f.state.zones.destroyed.includes(hero));
  assert.ok(!f.state.zones.destroyed.includes(bench));
});

test('fatigue with no heroes skips its empty target and cannot block a spell-only battle', () => {
  const f = fixture(['TS-0272', 'TS-0718'], ['TS-0476']);
  const result = submit(f);
  assert.equal(f.state.pending_choice, null);
  assert.equal(f.state.subphase, 'DUNGEON_DECLARE');
  assert.ok(finishChoices(f, result).some(e => e.kind === 'battle_resolved'));
});

test('village/rest actions do not force the dungeon-commitment disease penalties', () => {
  const f = fixture(['TS-0001', 'TS-0717', 'TS-0717'], ['TS-0476']);
  f.state.subphase = f.state.timing_window = 'TURN_START'; f.state.chosen_action = null; f.state.battle_context = null;
  run(f, 'ChooseAction', {action: 'rest'});
  run(f, 'SkipRestDestroy');
  const result = run(f, 'FinishTurn');
  assert.equal(result.events.some(e => e.kind === 'hero_zero_strength_marked'), false);
  assert.ok(!f.state.zones.destroyed.includes(f.hand[0]));
});

test('clan dungeon bonus is an optional activation and survives its source being benched', () => {
  const f = fixture(['TS-0330', 'TS-0001', 'TS-0002'], ['TS-0476']);
  const [clan, hero, dagger] = f.hand;
  run(f, 'EquipWeapon', {hero_instance_id: hero, weapon_instance_id: dagger});
  const preview = () => {
    const {context, draft} = engine.battlePreparation(f.state, 'alice', f.catalog, f.rules);
    draft.hero_instance_ids = [hero]; draft.equipment = {[hero]: [dagger]};
    return engine.previewBattleTeam(context, draft).calculation.attack;
  };
  const before = preview();
  run(f, 'ActivateAbility', {ability_id: 'TS-0330-A02', source_instance_id: clan});
  assert.equal(preview(), before + 1);
  assert.throws(() => run(f, 'ActivateAbility', {ability_id: 'TS-0330-A02', source_instance_id: clan}), /unavailable/);
});

test('spell selection and cancellation stay unused; only a selected submission records use', () => {
  const f = fixture(['TS-0272'], ['TS-0476']); const spell = f.hand[0];
  assert.equal(engine.legalCommands(f.state, f.catalog, f.rules).some(c => c.type === 'UseSpell'), false);
  const {context, draft} = engine.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  for (const selected of [[], [spell], [], [spell], []]) {
    assert.equal(engine.previewBattleTeam(context, {...draft, support_instance_ids: selected}).calculation.magic_attack, selected.length ? 3 : 0);
    assert.deepEqual(f.state.used_cards, []);
    assert.equal(f.state.battle_context.spell_cast_counts, undefined);
  }
  assert.throws(() => run(f, 'UseSpell', {instance_id: spell}), /not available|unsupported|invalid|not allowed/i);
  const unselected = submit(f, draft => {draft.support_instance_ids = [];});
  assert.deepEqual(f.state.used_cards, []);
  assert.equal(unselected.events.some(event => event.kind === 'spell_used'), false);
  run(f, 'ReviseBattleTeam');
  const selected = submit(f);
  assert.deepEqual(f.state.used_cards, [spell]);
  assert.equal(f.state.battle_context.spell_cast_counts[spell], 1);
  assert.equal(selected.events.filter(event => event.kind === 'spell_used').length, 1);
  run(f, 'ReviseBattleTeam');
  const prepared = engine.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  assert.equal(engine.previewBattleTeam(prepared.context, {...prepared.draft, support_instance_ids: []}).calculation.magic_attack, 0);
  assert.deepEqual(f.state.used_cards, [spell], 'revising a committed team cannot undo an actual use');
  assert.equal(submit(f).events.some(event => event.kind === 'spell_used'), false, 'resubmitting does not count another cast');
});

test('activating a spell records use even without participation; later selection does not duplicate it', () => {
  const f = fixture(['TS-0269', 'TS-0435'], ['TS-0476']), [spell] = f.hand;
  run(f, 'ActivateAbility', {ability_id: 'TS-0269-A02', source_instance_id: spell});
  assert.ok(f.state.used_cards.includes(spell));
  const {context, draft} = engine.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  for (const support_instance_ids of [[spell], []]) engine.previewBattleTeam(context, {...draft, support_instance_ids});
  assert.ok(f.state.used_cards.includes(spell), 'cancelling participation cannot undo an activated ability');
  const result = submit(f);
  assert.equal(f.state.used_cards.filter(id => id === spell).length, 1);
  assert.equal(result.events.some(event => event.kind === 'spell_used'), false);
});

test('committing a selected passive spell records its use before the battle', () => {
  const f = fixture(['TS-0272'], ['TS-0476']);
  const result = submit(f);
  assert.equal(f.state.subphase, 'DUNGEON_DECLARE');
  const events = finishChoices(f, result);
  const used = events.findIndex(e => e.kind === 'spell_used');
  const battle = events.findIndex(e => e.kind === 'battle_resolved');
  assert.ok(used >= 0 && battle > used);
});
