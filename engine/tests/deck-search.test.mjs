import assert from 'node:assert/strict';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {DeckSearchProgress} from '../dist/effects/deck-search.js';
import {Transition} from '../dist/turn/transaction.js';

const firstHero = {op: 'discard_until', filter: {tag: '英雄'}, bind: 'found',
  then: {op: 'for_each', query: {zone: 'bound', var: 'found'}, bind: 'victim',
    body: {op: 'destroy', target: {var: 'victim'}}}};
function fixture(body = firstHero, players = ['alice', 'bob'], seed = 'deck-search') {
  const card = (id, tags) => ({card_id: id, name: id, tags, card_type: '村庄牌',
    subcategory: '', slot_kind: 'front', effect_text: '', 'wiki_力量': '2'});
  const catalog = {cards: {source: card('source', '物品'), hero: card('hero', '英雄'),
    weapon: card('weapon', '武器'), miss: card('miss', '物品'), disease: card('disease', '疾病')},
    setup_index: {cards_csv_sha256: 'catalog', groups: []}};
  const rules = {...server.compileRuleset({schema_version: 'thunderstone.effects/1', abilities: [{
    id: 'source-A01', source_card_id: 'source', kind: 'activated', source_zone: 'active_hand',
    usage: 'once_per_turn', actions: ['dungeon'], conditions: [], body}]}, catalog.cards), version: 'effects'};
  const zones = {destroyed: [], 'hall:main': [], 'dungeon:main': [], 'pending:disease': []};
  for (const player of players) for (const part of ['hand', 'draw', 'discard', 'control']) zones[`player:${player}:${part}`] = [];
  zones['player:alice:hand'] = ['source'];
  const state = {phase: 'PLAYING', subphase: 'DUNGEON_PREPARE', timing_window: 'DUNGEON_PREPARE', chosen_action: 'dungeon',
    ruleset_version: server.RULESET_VERSION, catalog_version: 'catalog', effects_version: 'effects',
    game_version: 1, turn_number: 1, round_number: 1, started_turn: 1, next_instance_sequence: 10000, next_event_sequence: 1,
    active_player_id: 'alice', first_player_id: 'alice', player_order: players,
    players: Object.fromEntries(players.map(id => [id, {xp: 0, temporary_gold: 0, purchases_remaining: 1}])),
    zones, instances: {source: {card_id: 'source', owner_player_id: 'alice', flags: {}, origin: 'fixture'}},
    active_settings: [], battle_context: {equipped_weapon_by_hero: {}}, pending_choice: null,
    resolution_frames: [], registered_triggers: [], scheduled_effects: [], workflow_steps: [],
    continuous_effects: [], ability_uses: {}, used_cards: [], supply_rules: {basic_card_ids: [],
      disease_infinite: true, disease_card_ids: ['disease'], disease_weights: {disease: 1}},
    rng_state: {algorithm: server.RNG_VERSION, seed, counter: 0}};
  return {catalog, rules, state};
}
function add(f, id, card = 'miss', player = 'alice', part = 'draw') {
  f.state.instances[id] = {card_id: card, owner_player_id: player, flags: {}, origin: 'fixture'};
  f.state.zones[`player:${player}:${part}`].push(id);
}
function freeze(value) {
  if (value && typeof value === 'object') {Object.freeze(value); Object.values(value).forEach(freeze);}
}
function run(f) {
  const before = JSON.stringify(f.state);
  freeze(f.state);
  const command = {type: 'ActivateAbility', player_id: 'alice', ability_id: 'source-A01', source_instance_id: 'source'};
  const result = server.applyCommand(f.state, command, f.catalog, f.rules);
  assert.deepEqual(browser.applyCommand(f.state, command, f.catalog, f.rules), result);
  assert.equal(JSON.stringify(f.state), before);
  return result;
}
const revealed = result => result.events.filter(e => e.kind === 'cards_revealed').flatMap(e => e.instance_ids);

test('continuous searches reshuffle discard and find a target absent from the original draw pile', () => {
  const f = fixture(); add(f, 'miss'); add(f, 'target', 'hero', 'alice', 'discard');
  const result = run(f);
  assert.ok(result.state.zones.destroyed.includes('target'));
  assert.equal(result.events.filter(e => e.kind === 'player_deck_shuffled').length, 1);
  assert.equal(result.events.some(e => e.kind === 'effect_search_stopped'), false);
});

test('a previously checked instance is processed again after shuffling while another target remains', () => {
  const f = fixture(firstHero, ['alice', 'bob'], 'repeat-miss');
  add(f, 'miss'); add(f, 'target', 'hero', 'alice', 'discard');
  // Arrange a deterministic shuffle that puts the previously checked miss first.
  for (let seed = 0; seed < 50; seed++) {
    const rng = new server.RandomStream(String(seed)), order = ['target', 'miss'];
    rng.shuffle(order);
    if (order[0] === 'miss') {f.state.rng_state.seed = String(seed); break;}
  }
  assert.deepEqual(revealed(run(f)), ['miss', 'miss', 'target']);
});

test('no-target search checks distinct instances of the same card and terminates after covering both piles', () => {
  const f = fixture(); add(f, 'copy1'); add(f, 'copy2', 'miss', 'alice', 'discard');
  const result = run(f), seen = revealed(result);
  assert.deepEqual(new Set(seen), new Set(['copy1', 'copy2']));
  assert.ok(seen.length <= 3);
  assert.deepEqual(new Set(result.state.zones['player:alice:discard'].concat(result.state.zones['player:alice:draw'])), new Set(['copy1', 'copy2']));
  assert.equal(result.events.filter(e => e.kind === 'effect_search_stopped').length, 1);
});

test('an empty search has no shuffle, and hand/control cards do not enter its search pool', () => {
  const f = fixture(); add(f, 'held', 'hero', 'alice', 'hand'); add(f, 'control', 'hero', 'alice', 'control');
  const result = run(f);
  assert.deepEqual(revealed(result), []);
  assert.equal(result.events.some(e => e.kind === 'player_deck_shuffled'), false);
  assert.deepEqual(result.state.zones['player:alice:hand'], ['source', 'held']);
});

test('continuous search can find a target beyond the former 1000-card limit', () => {
  const f = fixture();
  for (let i = 0; i < 1001; i++) add(f, `miss${i}`);
  add(f, 'target', 'hero');
  const result = run(f);
  assert.ok(result.state.zones.destroyed.includes('target'));
  assert.equal(revealed(result).length, 1002);
});

for (const tag of ['英雄', '武器']) test(`multiplayer ${tag} checks preserve reverse seat order and keep already-checked players in the rotation`, () => {
  const f = fixture({op: 'reveal_cycle', filter: {tag}, goal: 3}, ['alice', 'bob', 'cara']);
  add(f, 'a'); add(f, 'c', 'miss', 'cara');
  for (let i = 0; i < 3; i++) add(f, `target${i}`, tag === '英雄' ? 'hero' : 'weapon', 'bob', 'discard');
  const result = run(f), events = result.events.filter(e => e.kind === 'cards_revealed');
  assert.deepEqual(events.map(e => e.player_id), ['alice', 'cara', 'bob', 'alice', 'cara', 'bob', 'alice', 'cara', 'bob']);
  assert.equal(result.state.zones.destroyed.length, 3);
  assert.equal(result.events.some(e => e.kind === 'effect_search_stopped'), false);
});

test('multiplayer checks end with a partial total after all reachable failures are known', () => {
  const f = fixture({op: 'reveal_cycle', filter: {tag: '英雄'}, goal: 3});
  add(f, 'a'); add(f, 'b', 'miss', 'bob');
  add(f, 'target1', 'hero', 'bob', 'discard'); add(f, 'target2', 'hero', 'bob', 'discard');
  const result = run(f);
  assert.equal(result.events.find(e => e.kind === 'trap_reveal_cycle_completed').destroyed_count, 2);
  assert.equal(result.events.filter(e => e.kind === 'effect_search_stopped').length, 1);
  assert.ok(result.events.some(e => e.kind === 'player_deck_shuffled' && e.player_id === 'bob'));
});

test('successful checks retained by a replacement are not recorded as failures', () => {
  const f = fixture({op: 'reveal_cycle', filter: {tag: '英雄'}, goal: 3});
  add(f, 'target', 'hero');
  const buff = server.grantTurnBuff({instance: f.state.instances.target, card: f.catalog.cards.hero,
    in_active_hand: true, turn_number: 1, buff: 'discard_instead_of_destroy',
    ability_id: 'source-A01', source_instance_id: 'source'});
  f.state.instances.target.flags.turn_buffs = buff.turn_buffs;
  const result = run(f);
  assert.deepEqual(revealed(result), ['target', 'target', 'target']);
  assert.equal(result.events.find(e => e.kind === 'trap_reveal_cycle_completed').destroyed_count, 3);
});

test('failure records survive other successes, while card/state changes and new instances invalidate only their coverage', () => {
  const f = fixture(); add(f, 'miss'); add(f, 'target', 'hero');
  const tx = new Transition(f.state, f.catalog, f.rules), progress = new DeckSearchProgress(tx);
  progress.recordNoProgress('alice', 'miss');
  assert.equal(progress.canContinue(['alice']), true);
  tx.destroyCard('target');
  assert.equal(progress.canContinue(['alice']), false);
  tx.state.instances.miss.flags.changed = true;
  assert.equal(progress.canContinue(['alice']), true);
  progress.recordNoProgress('alice', 'miss');
  assert.equal(progress.canContinue(['alice']), false);
  tx.state.copied_heroes = {miss: {full_card: true, card_ids: ['hero']}};
  assert.equal(progress.canContinue(['alice']), true);
  progress.recordNoProgress('alice', 'miss');
  assert.equal(progress.canContinue(['alice']), false);
  tx.createOwned('miss', 'player:alice:discard', 'new-card');
  assert.equal(progress.canContinue(['alice']), true);
});

test('fixed-size reveals use the same refill rule and stop naturally when both piles are empty', () => {
  const f = fixture({op: 'reveal', count: 5, bind: 'cards', then: {op: 'sequence', children: []}});
  add(f, 'one'); add(f, 'two', 'miss', 'alice', 'discard');
  const result = run(f);
  assert.deepEqual(new Set(revealed(result)), new Set(['one', 'two']));
  assert.equal(revealed(result).length, 2);
  assert.equal(result.events.filter(e => e.kind === 'player_deck_shuffled').length, 1);
});
