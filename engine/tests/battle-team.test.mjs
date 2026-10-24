import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';

const card = (id, fields) => ({card_id: id, name: id, card_type: '村庄牌', subcategory: '', tags: '', effect_text: '',
  '正文_基础攻击': '', '正文_基础魔法攻击': '', 'wiki_力量': '', 'wiki_重量': '', 'wiki_光照': '',
  'wiki_生命值': '', 'wiki_金币值': '', 'wiki_英雄等级': '', 'wiki_购买价格': '', 'wiki_胜利点': '', ...fields});
function fixture(hand = ['h', 'g', 'w', 's', 'l']) {
  const cards = {
    h: card('h', {tags: '民兵|英雄', '正文_基础攻击': '1', 'wiki_力量': '3'}),
    g: card('g', {tags: '法师|英雄', '正文_基础魔法攻击': '2', 'wiki_力量': '2'}),
    w: card('w', {tags: '武器', '正文_基础攻击': '1', 'wiki_重量': '1'}),
    s: card('s', {tags: '法术', '正文_基础魔法攻击': '3', 'wiki_光照': '1'}),
    l: card('l', {tags: '物品', 'wiki_光照': '1'}),
    d: card('d', {tags: '疾病', '正文_基础攻击': '-1'}),
    t: card('t', {tags: '怪物', '正文_基础攻击': '-1'}),
    m: card('m', {card_type: '地下城牌', tags: '怪物', 'wiki_生命值': '3', defeat_xp_reward: '1'}),
    x: card('x', {tags: '物品', 'wiki_光照': '1'}),
  };
  const catalog = {cards, setup_index: {cards_csv_sha256: 'catalog', groups: []}};
  const rules = {version: 'effects', abilities: [], mechanics: []};
  const instances = {}, zones = {'player:alice:hand': [...hand], 'player:alice:draw': [], 'player:alice:discard': [],
    'player:alice:control': [], 'player:bob:hand': ['secret'], 'player:bob:draw': [], 'player:bob:discard': [],
    'player:bob:control': [], 'hall:main': ['m'], 'dungeon:main': ['m2', 'm3', 'm4'], destroyed: [], 'pending:disease': []};
  for (const [zone, pile] of Object.entries(zones)) for (const id of pile) instances[id] = {
    card_id: id === 'secret' ? 'x' : id.startsWith('m') ? 'm' : id,
    owner_player_id: zone.startsWith('player:') ? zone.split(':')[1] : null, origin: 'fixture', flags: {}};
  const state = {phase: 'PLAYING', subphase: 'DUNGEON_PREPARE', timing_window: 'DUNGEON_PREPARE', chosen_action: 'dungeon',
    ruleset_version: server.RULESET_VERSION, catalog_version: 'catalog', effects_version: 'effects',
    game_version: 4, turn_number: 1, round_number: 1, started_turn: 1, next_instance_sequence: 100, next_event_sequence: 1,
    active_player_id: 'alice', first_player_id: 'alice', player_order: ['alice', 'bob'],
    players: {alice: {xp: 0, temporary_gold: 0, purchases_remaining: 1}, bob: {xp: 0, temporary_gold: 0, purchases_remaining: 1}},
    instances, zones, active_settings: [], battle_context: {equipped_weapon_by_hero: {}},
    pending_choice: null, resolution_frames: [], registered_triggers: [], scheduled_effects: [], workflow_steps: [],
    continuous_effects: [], ability_uses: {}, used_cards: [],
    supply_rules: {basic_card_ids: [], disease_infinite: true, disease_card_ids: ['d'], disease_weights: {d: 1}},
    rng_state: {algorithm: 'sha256-counter-v1', seed: 'battle-team', counter: 0}};
  return {state, catalog, rules};
}
const prepare = (f, engine = server) => engine.battlePreparation(f.state, 'alice', f.catalog, f.rules);
const submit = (f, context, draft, engine = server) => engine.applyCommand(f.state,
  engine.buildSubmitBattleTeamCommand(context, draft), f.catalog, f.rules);
const trigger = (id, source, event, body, zone = 'active_hand') => ({id, source_card_id: source,
  kind: 'triggered', source_zone: zone, event, body, conditions: [], actions: [], usage: 'once_per_event'});
function freeze(value) {
  if (value && typeof value === 'object') {Object.freeze(value); Object.values(value).forEach(freeze);} return value;
}

test('each local selection updates attack and light, with identical immutable Node/browser results', () => {
  const f = fixture(['h', 'w', 'l']);
  const {context, draft: original} = prepare(f);
  freeze(context); freeze(original);
  let draft = {...original, hero_instance_ids: [], support_instance_ids: [], equipment: {}};
  for (const action of [
    {type: 'set_hero', instance_id: 'h', selected: true},
    {type: 'equip', hero_instance_id: 'h', weapon_instance_id: 'w'},
    {type: 'set_support', instance_id: 'l', selected: true},
  ]) {
    const next = server.updateBattleDraft(context, draft, action);
    assert.deepEqual(browser.updateBattleDraft(context, draft, action), next);
    draft = next;
    assert.deepEqual(browser.previewBattleTeam(context, draft), server.previewBattleTeam(context, draft));
  }
  assert.equal(server.previewBattleTeam(context, draft).calculation.attack, 2);
  assert.equal(server.previewBattleTeam(context, draft).calculation.light, 1);
  draft = server.updateBattleDraft(context, draft, {type: 'set_hero', instance_id: 'h', selected: false});
  assert.deepEqual(draft.equipment, {});
  assert.equal(server.previewBattleTeam(context, draft).calculation.attack, 0);
  assert.deepEqual(f.state.battle_context, {equipped_weapon_by_hero: {}});
  assert.equal(f.state.rng_state.counter, 0);
});

test('visible preparation excludes opponents, decks, RNG, continuation and private flags', () => {
  const f = fixture(); f.state.instances.h.flags.private_marker = 'hidden';
  const result = prepare(f);
  assert.deepEqual(browser.battlePreparation(f.state, 'alice', f.catalog, f.rules), result);
  assert.equal(result.context.state.rng_state, undefined);
  assert.equal(result.context.state.zones['player:bob:hand'], undefined);
  assert.equal(result.context.state.zones['dungeon:main'], undefined);
  assert.equal(result.context.state.instances.secret, undefined);
  assert.equal(result.context.state.instances.h.flags, undefined);
  assert.equal(result.context.state.players.bob, undefined);
});

test('nested preparation references cannot reveal hidden sources and preserve resolved global bonuses', () => {
  const f = fixture(['h', 'w']);
  Object.assign(f.state.battle_context, {
    modifiers: {attack: 4, private: 'private-marker'},
    modifier_sources: [{source_instance_id: 'secret', field: 'attack', amount: 4, private: 'private-marker'}],
    card_modifiers: {h: {strength: 1, private: 'private-marker'}, secret: {attack: 99}},
    monster_health_modifiers: {m: 1, secret: 99},
    strength_penalty_assignments: {secret: 'h', h: 'secret'},
    disease_penalty_assignments: {secret: 'attack'},
    equipment_draw_counts: {w: 1, secret: 9}, spell_cast_counts: {secret: 9},
    excluded_participants: ['m2'], convert_card_magic: ['secret'], disease_order: ['secret'],
  });
  f.state.copied_heroes = {h: {card_ids: ['h'], preserve_attack: true, source_instance_id: 'secret', private: 'private-marker'},
    secret: {card_ids: ['x'], preserve_attack: false}};
  const before = structuredClone(f);
  const {context, draft} = prepare(f);
  assert.equal(JSON.stringify(context).includes('secret'), false);
  assert.equal(JSON.stringify(context).includes('private-marker'), false);
  assert.equal(context.state.battle_context.modifiers.attack, 4);
  assert.deepEqual(context.state.battle_context.modifier_sources, [{source_instance_id: null, field: 'attack', amount: 4}]);
  assert.equal(server.previewBattleTeam(context, draft).calculation.attack, 5);
  assert.equal(server.previewBattleTeam(context, draft).calculation.attack,
    server.combatValues({state: f.state, cards: f.catalog.cards, mechanics: f.rules.mechanics}, 0).attack);
  assert.deepEqual(browser.previewBattleTeam(context, draft), server.previewBattleTeam(context, draft));
  assert.deepEqual(f, before);
  f.state.battle_context.excluded_participants.push('secret');
  const excluded = prepare(f);
  assert.equal(JSON.stringify(excluded.context).includes('secret'), false);
  assert.equal(excluded.context.state.battle_context.modifiers.attack, 0);
  assert.equal(server.previewBattleTeam(excluded.context, excluded.draft).calculation.attack,
    server.combatValues({state: f.state, cards: f.catalog.cards, mechanics: f.rules.mechanics}, 0).attack);
});

test('benching a mage avoids magic-triggered monster health while hand heroes remain queryable', () => {
  const f = fixture(['h', 'g', 'l']); f.catalog.cards.h['正文_基础攻击'] = '3';
  f.rules.abilities.push(trigger('double', 'm', 'BATTLE_BEFORE_OUTCOME', {
    op: 'if', condition: {compare: {left: {combat: 'magic_attack'}, op: 'gt', right: 0}},
    then: {op: 'mod_monster_health', target: {var: 'source'}, amount: 3},
  }, 'battle_target'));
  const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.hero_instance_ids = ['h'];
  const result = submit(f, context, draft);
  const battle = result.events.find(e => e.kind === 'battle_resolved');
  assert.equal(battle.outcome, 'win'); assert.equal(battle.health, 3);
  assert.equal(battle.calculation.magic_attack, 0);
  const full = submit(f, context, {...draft, hero_instance_ids: ['h', 'g']});
  assert.equal(full.events.find(e => e.kind === 'battle_resolved').outcome, 'loss');
  const input = server.battleDraftInput(context, draft);
  input.state.player_order = ['alice'];
  const evaluation = new server.EffectEvaluation(input);
  assert.deepEqual(evaluation.query({zone: 'active_hand', tag: '英雄'}), ['h', 'g']);
  assert.deepEqual(evaluation.query({zone: 'active_hand', tag: '英雄', participating: true}), ['h']);
});

test('a spell can win with zero heroes, and negative trophies/diseases remain mandatory', () => {
  const f = fixture(['h', 's', 'd', 't']); f.catalog.cards.m['wiki_生命值'] = '1';
  const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.hero_instance_ids = [];
  const preview = server.previewBattleTeam(context, draft);
  assert.equal(preview.calculation.magic_attack, 2); assert.equal(preview.calculation.attack, -1);
  assert.equal(preview.outcome_before_battle_effects, 'win');
  const result = submit(f, context, draft);
  assert.deepEqual(result.events.find(e => e.kind === 'battle_resolved').calculation, preview.calculation);
  assert.throws(() => server.updateBattleDraft(context, draft, {type: 'set_support', instance_id: 'd', selected: false}), /not an optional/);
  assert.throws(() => server.previewBattleTeam(context, {...draft, support_instance_ids: ['d']}), /invalid battle support/);
});

test('bench heroes skip battle and victory triggers but can activate dungeon abilities beforehand', () => {
  const f = fixture(['h', 'g', 'l']);
  f.rules.abilities.push({id: 'dungeon', source_card_id: 'g', kind: 'activated', source_zone: 'active_hand',
    actions: ['dungeon'], usage: 'once_per_turn', event: null, conditions: [], body: {op: 'mod_attack', amount: 2}});
  f.rules.abilities.push(trigger('battle', 'g', 'BATTLE_BEFORE_OUTCOME', {op: 'mod_attack', amount: 100}));
  f.rules.abilities.push(trigger('victory', 'g', 'MONSTER_DEFEATED', {op: 'gain_xp', amount: 50}));
  f.state = server.applyCommand(f.state, {type: 'ActivateAbility', player_id: 'alice', ability_id: 'dungeon', source_instance_id: 'g'}, f.catalog, f.rules).state;
  const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.hero_instance_ids = ['h'];
  const result = submit(f, context, draft);
  assert.equal(result.events.find(e => e.kind === 'battle_resolved').calculation.attack, 3);
  assert.equal(result.state.players.alice.xp, 1);
  assert.equal(result.events.some(e => ['battle', 'victory'].includes(e.ability_id)), false);
});

for (const victim of ['h', 'g']) test(`team selection keeps every card in hand and hand effects can destroy ${victim === 'h' ? 'a selected' : 'an unselected'} hero`, () => {
  const f = fixture();
  const originalHand = [...f.state.zones['player:alice:hand']];
  f.rules.abilities.push(trigger('hand-destruction', 'm', 'BATTLE_BEFORE_OUTCOME', {op: 'select',
    query: {zone: 'active_hand', tag: '英雄'}, bind: 'chosen', min: 1, max: 1,
    then: {op: 'mark_destroy', target: {var: 'chosen'}}}, 'battle_target'));
  const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.hero_instance_ids = ['h'];
  draft.support_instance_ids = ['l']; draft.equipment = {h: ['w']};
  for (const engine of [server, browser]) {
    const input = engine.battleDraftInput(context, draft);
    assert.deepEqual(input.state.zones['player:alice:hand'], originalHand);
    assert.deepEqual(new engine.EffectEvaluation(input).query({zone: 'active_hand'}), originalHand);
  }
  const entered = submit(f, context, draft);
  // Selected hero h, benched hero g, equipped weapon w, unselected spell s,
  // and selected support l all stay in the same hand during battle resolution.
  assert.deepEqual(entered.state.zones['player:alice:hand'], originalHand);
  assert.deepEqual(entered.state.battle_context.battle_team, {hero_instance_ids: ['h'], support_instance_ids: ['l']});
  for (const id of originalHand) {
    assert.equal(entered.state.instances[id].owner_player_id, 'alice');
    assert.deepEqual(Object.entries(entered.state.zones).filter(([, pile]) => pile.includes(id)).map(([zone]) => zone), ['player:alice:hand']);
  }
  assert.deepEqual(entered.state.pending_choice.candidate_instance_ids, ['h', 'g']);
  const completed = server.applyCommand(JSON.parse(JSON.stringify(entered.state)), {type: 'ResolveChoice', player_id: 'alice', instance_id: victim}, f.catalog, f.rules);
  assert.ok(completed.state.zones.destroyed.includes(victim));
  assert.deepEqual(f.state.zones['player:alice:hand'], originalHand);
});

test('forced combat exclusions cannot be overridden, and bench auras supply no combat bonus', () => {
  const f = fixture(['h', 'g', 'l']);
  f.rules.mechanics.push({id: 'aura', source_card_id: 'g', source_line: '', op: 'hero_aura', params: {attack: 10}});
  const {context, draft} = prepare(f); draft.hero_instance_ids = ['h'];
  assert.equal(server.previewBattleTeam(context, draft).calculation.attack, 1);
  context.state.battle_context.excluded_participants = ['h'];
  assert.equal(server.previewBattleTeam(context, draft).calculation.attack, 0);
});

test('in-play hero limits use the team while an explicit hand element condition uses the whole hand', () => {
  const f = fixture(['h', 'g', 'l']);
  f.catalog.cards.h['正文_基础攻击'] = '4'; f.catalog.cards.g.tags = '元素|英雄';
  f.rules.mechanics.push({id: 'restrictions', source_card_id: 'm', source_line: '', op: 'target_restriction',
    params: {min_heroes: 2, half_no_element: true}});
  const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.hero_instance_ids = ['h'];
  const result = server.previewBattleTeam(context, draft);
  assert.equal(result.calculation.can_defeat, false);
  assert.equal(result.calculation.attack, 4);
  context.cards.g.tags = '法师|英雄';
  assert.equal(server.previewBattleTeam(context, draft).calculation.attack, 2);
});

test('passive spell selection counts as use and earlier spell activations cannot be undone by deselection', () => {
  const f = fixture(['h', 's', 'l']);
  f.rules.mechanics.push({id: 'no-spells', source_card_id: 'm', source_line: '', op: 'target_restriction', params: {forbid_used_spell: true}});
  const {context, draft} = prepare(f); draft.target_instance_id = 'm';
  assert.equal(server.previewBattleTeam(context, draft).calculation.can_attack, false);
  draft.support_instance_ids = ['l'];
  assert.equal(server.previewBattleTeam(context, draft).calculation.can_attack, true);
  context.state.battle_context.used_card_tags = ['法术'];
  assert.equal(server.previewBattleTeam(context, draft).calculation.can_attack, false);
  assert.throws(() => submit({...f, state: {...f.state, battle_context: {...f.state.battle_context, used_card_tags: ['法术']}}}, context, draft), /attack restrictions/);
});

test('rank zero preview and capacity checks use the shared equipment rules', () => {
  const f = fixture(['h', 'w', 'l']);
  f.state.zones['hall:main'] = []; f.state.zones['hall:main:rank0'] = ['m'];
  f.state.instances.w2 = {card_id: 'w', owner_player_id: 'alice', origin: 'fixture', flags: {}};
  f.state.zones['player:alice:hand'].push('w2');
  const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.support_instance_ids = [];
  assert.equal(server.previewBattleTeam(context, draft).calculation.darkness_penalty, 0);
  assert.throws(() => server.previewBattleTeam(context, {...draft, equipment: {h: ['w', 'w2']}}), /capacity/);
  f.rules.mechanics.push({id: 'two-weapons', source_card_id: 'h', source_line: '', op: 'extra_equipment', params: {capacity: 2}});
  const prepared = prepare(f); prepared.draft.target_instance_id = 'm'; prepared.draft.equipment = {h: ['w', 'w2']};
  assert.equal(server.previewBattleTeam(prepared.context, prepared.draft).calculation.attack, 3);
});

test('draft validation rejects foreign cards, duplicates, overweight equipment, capacity, targets and stale versions', () => {
  const f = fixture(); const {context, draft} = prepare(f);
  for (const broken of [
    {...draft, hero_instance_ids: ['secret']}, {...draft, hero_instance_ids: ['h', 'h']},
    {...draft, support_instance_ids: ['d']}, {...draft, equipment: {h: ['w'], g: ['w']}},
    {...draft, equipment: {h: ['w', 'w']}}, {...draft, target_instance_id: 'secret'},
    {...draft, game_version: 0}, {...draft, engine_version: 'old'}, {...draft, player_id: 'bob'},
  ]) assert.throws(() => server.previewBattleTeam(context, broken));
  context.cards.w['wiki_重量'] = '10';
  assert.throws(() => server.previewBattleTeam(context, {...draft, equipment: {h: ['w']}}), /too heavy/);
  assert.throws(() => server.buildSubmitBattleTeamCommand(context, draft), /select a battle target/);
  assert.throws(() => server.battlePreparation(f.state, 'bob', f.catalog, f.rules), /active player/);
  assert.throws(() => server.battlePreparation({...f.state, subphase: 'TURN_START'}, 'alice', f.catalog, f.rules), /preparation phase/);
  const command = server.buildSubmitBattleTeamCommand(context, {...draft, target_instance_id: 'm'});
  assert.throws(() => server.applyCommand(f.state, {...command, expected_version: undefined}, f.catalog, f.rules), /expected_version/);
  assert.throws(() => server.applyCommand(f.state, {...command, player_id: 'bob'}, f.catalog, f.rules), /active or chosen/);
});

test('equipment draw effects require a fresh team confirmation without replaying equip events', () => {
  const f = fixture(['h', 'w', 'l']);
  f.state.instances.x = {card_id: 'x', owner_player_id: 'alice', flags: {}, origin: 'fixture'};
  f.state.zones['player:alice:draw'].push('x');
  f.rules.abilities.push(trigger('draw-on-equip', 'w', 'CARD_EQUIPPED', {op: 'draw', count: 1}, 'event_source'));
  const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.equipment = {h: ['w']};
  const result = submit(f, context, draft);
  assert.equal(result.state.subphase, 'DUNGEON_PREPARE');
  assert.ok(result.events.some(e => e.kind === 'battle_team_revision_required'));
  assert.equal(result.events.some(e => e.kind === 'battle_resolved'), false);
  f.state = result.state;
  const fresh = prepare(f); fresh.draft.target_instance_id = 'm';
  const completed = submit(f, fresh.context, fresh.draft);
  assert.ok(completed.events.some(e => e.kind === 'battle_resolved'));
  assert.equal(completed.events.some(e => e.kind === 'weapon_equipped'), false);
});

test('equipment choices retain the submission workflow and commit only after the choice resolves', () => {
  const f = fixture(['h', 'g', 'w', 'l']);
  f.rules.abilities.push(trigger('choose-on-equip', 'w', 'CARD_EQUIPPED', {op: 'select',
    query: {zone: 'active_hand', tag: '英雄'}, bind: 'chosen', min: 1, max: 1,
    then: {op: 'gain_xp', amount: 1}}, 'event_source'));
  const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.equipment = {h: ['w']};
  const result = submit(f, context, draft);
  assert.ok(result.state.pending_choice); assert.equal(result.events.some(e => e.kind === 'battle_team_submitted'), false);
  const command = {type: 'ResolveChoice', player_id: 'alice', instance_id: 'h'};
  const resumed = server.applyCommand(JSON.parse(JSON.stringify(result.state)), command, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(result.state, command, f.catalog, f.rules), resumed);
  assert.ok(resumed.events.some(e => e.kind === 'battle_team_submitted'));
  assert.ok(resumed.events.some(e => e.kind === 'battle_resolved'));
});

test('equipment events settle one pair at a time and later invalid pairs return to preparation', () => {
  for (const destroySecondHero of [false, true]) {
    const f = fixture(['h', 'g', 'w', 'l']);
    f.state.instances.w2 = {card_id: 'w', owner_player_id: 'alice', origin: 'fixture', flags: {}};
    f.state.zones['player:alice:hand'].push('w2');
    f.rules.abilities.push(trigger('equip-count', 'w', 'CARD_EQUIPPED', destroySecondHero
      ? {op: 'for_each', query: {zone: 'active_hand', card_id: 'g'}, bind: 'victim', body: {op: 'destroy', target: {var: 'victim'}}}
      : {op: 'gain_xp', amount: {count: {zone: 'active_hand', tag: '武器', equipped: true}}}, 'event_source'));
    const {context, draft} = prepare(f); draft.target_instance_id = 'm'; draft.equipment = {h: ['w'], g: ['w2']};
    const result = submit(f, context, draft);
    if (destroySecondHero) {
      assert.equal(result.state.subphase, 'DUNGEON_PREPARE');
      assert.ok(result.events.some(e => e.kind === 'battle_team_revision_required'));
      assert.equal(result.events.some(e => e.kind === 'weapon_equipped' && e.weapon_instance_id === 'w2'), false);
      assert.equal(result.events.some(e => e.kind === 'battle_resolved'), false);
    } else {
      assert.equal(result.state.players.alice.xp, 4); // one equip, then two equips, then monster XP
      const firstTiming = result.events.findIndex(e => e.kind === 'rule_timing' && e.event === 'CARD_EQUIPPED');
      const secondEquip = result.events.findIndex(e => e.kind === 'weapon_equipped' && e.weapon_instance_id === 'w2');
      assert.ok(firstTiming < secondEquip);
    }
  }
});
