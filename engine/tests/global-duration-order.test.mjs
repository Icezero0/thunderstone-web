import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {fixture} from './support/catalog.mjs';
import {Transition} from '../dist/turn/transaction.js';
import {atom} from '../dist/effects/atoms.js';
import {expireRules} from '../dist/effects/durations.js';

for (const extraTurn of [false, true]) test(`Guiding Light persists through cleanup and expires at caster's next turn end: extra turn ${extraTurn}`, () => {
  const f = fixture(['TS-0288', 'TS-0001'], ['TS-0476', 'TS-0477', 'TS-0478']);
  f.add('TS-0001', 'player:bob:hand');
  if (extraTurn) f.state.players.alice.extra_turns = 1;
  f.state.battle_context.modifiers = {attack: 100};
  const prep = server.battlePreparation(f.state, 'alice', f.catalog, f.rules);
  let result = server.applyCommand(f.state, server.buildSubmitBattleTeamCommand(prep.context, prep.draft), f.catalog, f.rules);
  const run = (type, fields = {}) => result = server.applyCommand(result.state,
    {type, player_id: result.state.pending_choice?.player_id ?? result.state.active_player_id, expected_version: result.state.game_version, ...fields}, f.catalog, f.rules);
  run('DeclareBattleTarget', {target_instance_id: f.hall[0]});
  const buff = () => result.state.continuous_effects.filter(rule => rule.source_card_id === 'TS-0288');
  const marked = () => {
    const options = server.turnOptions(result.state, result.state.active_player_id, f.catalog, f.rules), statuses = options.card_statuses;
    assert.deepEqual(options.public_effects, [{kind: 'buff', source_card_id: 'TS-0288', source_name: '指引之光', description: '所有玩家光照 +1。'}]);
    for (const [zone, hand] of Object.entries(result.state.zones)) if (zone.endsWith(':hand')) for (const id of hand)
      assert.ok(!statuses[id]?.some(row => row.source_name === '指引之光'), `${zone}:${id}`);
  };
  assert.equal(result.state.subphase, 'ACTION_END'); assert.equal(buff().length, 1); marked();
  run('FinishTurn'); assert.equal(buff().length, 1); marked();
  if (!extraTurn) {
    assert.equal(result.state.active_player_id, 'bob');
    run('ChooseAction', {action: 'rest'}); run('SkipRestDestroy'); run('FinishTurn');
  }
  assert.equal(result.state.active_player_id, 'alice'); assert.equal(buff().length, 1); marked();
  run('ChooseAction', {action: 'dungeon'});
  const next = server.battlePreparation(result.state, 'alice', f.catalog, f.rules);
  next.draft.hero_instance_ids = []; next.draft.support_instance_ids = [];
  const preview = server.previewBattleTeam(next.context, next.draft);
  assert.equal(preview.calculation.light, 1, 'global light does not require its source or any card to participate');
  assert.deepEqual(browser.previewBattleTeam(next.context, next.draft), preview);
  // Complete the already-entered action without another victory or reactivation.
  result.state.subphase = 'ACTION_END'; result.state.timing_window = 'ACTION_END';
  run('FinishTurn');
  assert.equal(buff().length, 0);
  assert.ok(result.events.some(event => event.kind === 'continuous_rule_expired' && event.rule.source_card_id === 'TS-0288'));
});

const trigger = (id, source, body = {op: 'mod_attack', amount: 1}) => ({id, source_card_id: source, kind: 'triggered',
  source_zone: 'hall', event: 'DUNGEON_ENTER', usage: 'once_per_event', actions: [], conditions: [], body});

test('global light is added once for either player, independent of team selection and printed light', () => {
  const f = fixture(['TS-0001', 'TS-0001', 'TS-0288']);
  const bobHero = f.add('TS-0001', 'player:bob:hand');
  f.state.continuous_effects = [{kind: 'light', scope: 'all', amount: 1, player_id: 'alice',
    source_card_id: 'TS-0288', until: 'owner_next_turn_end', created_turn: 0}];
  for (const player of ['alice', 'bob']) {
    f.state.active_player_id = player;
    const {context, draft} = server.battlePreparation(f.state, player, f.catalog, f.rules);
    draft.equipment = {}; draft.hero_instance_ids = []; draft.support_instance_ids = [];
    const heroes = player === 'alice' ? f.hand.slice(0, 2) : [bobHero];
    const check = expected => {
      const preview = server.previewBattleTeam(context, draft);
      assert.equal(preview.calculation.light, expected);
      assert.deepEqual(browser.previewBattleTeam(context, draft), preview);
      assert.ok(!Object.values(preview.continuous_card_statuses).flat().some(row => row.source_card_id === 'TS-0288'));
      const submitted = server.applyCommand(f.state, server.buildSubmitBattleTeamCommand(context, draft), f.catalog, f.rules);
      const committed = server.battlePreparation(submitted.state, player, f.catalog, f.rules);
      assert.equal(server.previewBattleTeam(committed.context, committed.draft).calculation.light, expected);
    };
    check(1);
    for (const hero of heroes) {draft.hero_instance_ids.push(hero); check(1);}
    if (player === 'alice') {
      draft.support_instance_ids = [f.hand[2]];
      check(1 + server.stat(f.cards['TS-0288'], 'light'));
      draft.support_instance_ids = []; check(1);
    }
    draft.hero_instance_ids = []; check(1);
  }
});
function dispatch(f, abilities, event = 'DUNGEON_ENTER') {
  return server.planEventDispatch({evaluation: {cards: f.cards, mechanics: [], state: f.state}, abilities, event,
    listeners: [], scheduled: [], turn_number: 1, repeatable_ability_ids: []});
}

test('simultaneous monster effects use ascending rank across dungeons, then each source card line order', () => {
  const f = fixture([], ['TS-0479', 'TS-0476']);
  const guardian = f.add('TS-0680', 'hall:main:rank0');
  const other = f.add('TS-0477', 'hall:b');
  const abilities = [trigger('TS-0476-A01', 'TS-0476'), trigger('TS-0479-A02', 'TS-0479'),
    trigger('TS-0680-A01', 'TS-0680'), trigger('TS-0477-A01', 'TS-0477'), trigger('TS-0479-A01', 'TS-0479')];
  const before = structuredClone(f.state), plan = dispatch(f, abilities);
  assert.equal(plan.mode, 'sequence');
  assert.deepEqual(plan.candidates.map(row => row.source_instance_id), [guardian, other, f.hall[0], f.hall[0], f.hall[1]]);
  assert.deepEqual(plan.candidates.filter(row => row.source_instance_id === f.hall[0]).map(row => row.ability_id), ['TS-0479-A01', 'TS-0479-A02']);
  assert.deepEqual(dispatch(f, [...abilities].reverse()), plan);
  assert.deepEqual(f.state, before);
});

test('only an explicitly player-ordered trigger requests effect order; ordinary simultaneous triggers never do', () => {
  const f = fixture([], ['TS-0479', 'TS-0476']);
  const abilities = [trigger('TS-0479-A01', 'TS-0479'), trigger('TS-0476-A01', 'TS-0476')];
  assert.equal(dispatch(f, abilities).mode, 'sequence');
  abilities[0].resolution_order = 'player';
  assert.equal(dispatch(f, abilities).mode, 'choice');
});

test('stacked global light survives removal of both sources and expires independently for each caster', () => {
  const f = fixture(['TS-0288', 'TS-0001']), bobSource = f.add('TS-0288', 'player:bob:hand');
  f.add('TS-0001', 'player:bob:hand');
  const tx = new Transition(f.state, f.catalog, f.rules), gain = source => atom(tx,
    {op: 'add_global_rule', kind: 'light', scope: 'all', amount: 1, until: 'owner_next_turn_end'}, {source}, 'TS-0288-A01');
  gain(f.hand[0]); tx.state.active_player_id = 'bob'; tx.state.turn_number = 2; gain(bobSource);
  tx.destroyCard(f.hand[0]); tx.destroyCard(bobSource); tx.state.battle_context = null;
  let statuses = server.turnOptions(tx.state, 'bob', f.catalog, f.rules).public_effects;
  assert.equal(statuses.filter(row => row.source_card_id === 'TS-0288').length, 2);
  tx.state.active_player_id = 'alice'; tx.state.turn_number = 3; expireRules(tx, 'owner_next_turn_end');
  assert.equal(tx.state.continuous_effects.length, 1); assert.equal(tx.state.continuous_effects[0].player_id, 'bob');
  statuses = server.turnOptions(tx.state, 'alice', f.catalog, f.rules).public_effects;
  assert.equal(statuses.filter(row => row.source_card_id === 'TS-0288').length, 1);
  tx.state.active_player_id = 'bob'; tx.state.turn_number = 4; expireRules(tx, 'owner_next_turn_end');
  assert.equal(tx.state.continuous_effects.length, 0);
});

test('the rules schema accepts only an explicit player ordering policy on triggered abilities', () => {
  const f = fixture(), raw = trigger('TS-0479-A01', 'TS-0479'); delete raw.actions;
  const compile = resolution_order => server.compileRuleset({schema_version: server.EFFECTS_SCHEMA_VERSION,
    abilities: [{...raw, resolution_order}], mechanics: []}, f.cards);
  assert.equal(compile('player').abilities[0].resolution_order, 'player');
  assert.throws(() => compile('automatic'), /resolution_order/);
});
