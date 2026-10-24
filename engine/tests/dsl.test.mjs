import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';

const card = (id, values = {}) => ({card_id: id, slot_kind: 'front', card_type: '基础牌',
  name: id, subcategory: '', tags: '', effect_text: '', ...values});
function fixture() {
  return {cards: {h: card('h', {tags: '民兵|英雄', '正文_基础攻击': '1', 'wiki_力量': '2'}),
    w: card('w', {tags: '武器', '正文_基础攻击': '1', 'wiki_重量': '1'})}, mechanics: [],
    state: {active_player_id: 'a', player_order: ['a','b','c'],
      players: {a: {xp: 4, temporary_gold: 1}, b: {xp: 2}, c: {xp: 0, eliminated: true}},
      active_settings: [], chosen_action: 'dungeon',
      zones: {'player:a:hand': ['hero','weapon'], 'player:b:hand': ['other'], 'player:c:hand': []},
      instances: {hero: {card_id: 'h'}, weapon: {card_id: 'w'}, other: {card_id: 'h'}},
      battle_context: {equipped_weapon_by_hero: {hero: 'weapon'}}}};
}
function freeze(value) {
  if (value && typeof value === 'object') {Object.freeze(value); Object.values(value).forEach(freeze);}
  return value;
}
function ability(body) {
  return {id: 'h-A01', source_card_id: 'h', kind: 'activated', source_zone: 'active_hand',
    usage: 'once_per_turn', actions: ['dungeon'], conditions: [], body};
}
function compile(engine, body, mechanics = []) {
  return engine.compileRuleset({schema_version: 'thunderstone.effects/1', abilities: [ability(body)], mechanics}, fixture().cards);
}
test('streaming discard validates its filter and continuation binding in both builds', () => {
  const body = {op: 'discard_until', filter: {tag: '英雄'}, bind: 'found',
    then: {op: 'for_each', query: {zone: 'bound', var: 'found'}, bind: 'victim',
      body: {op: 'destroy', target: {var: 'victim'}}}};
  assert.deepEqual(compile(server, body), compile(browser, body));
  for (const engine of [server, browser]) {
    assert.throws(() => compile(engine, {...body, filter: {invalid: true}}));
    assert.throws(() => compile(engine, {...body, then: {op: 'destroy', target: {var: 'unbound'}}}));
  }
});

test('spell immunity filters effect targets and resumed choices without hiding monsters from counts', () => {
  const input = fixture();
  input.cards.w.tags = '法术';
  input.cards.m = card('m', {tags: '怪物', 'wiki_生命值': '5'});
  input.cards.other = card('other', {tags: '怪物', 'wiki_生命值': '5'});
  input.state.instances.immune = {card_id: 'm'};
  input.state.instances.ordinary = {card_id: 'other'};
  input.state.zones['hall:main'] = ['immune', 'ordinary'];
  input.mechanics.push({id: 'm-A01', source_card_id: 'm', source_line: '', op: 'target_restriction', params: {immune_spells: true}});
  for (const engine of [server, browser]) {
    const evaluation = new engine.EffectEvaluation(input), bindings = {source: 'weapon'};
    const query = {zone: 'hall', tag: '怪物'};
    assert.deepEqual(evaluation.query(query, bindings), ['immune', 'ordinary']);
    assert.deepEqual(evaluation.effectTargets(query, bindings), ['ordinary']);
    assert.deepEqual(evaluation.effectTargets(query, {source: 'hero'}), ['immune', 'ordinary']);
    const choice = {kind: 'effect_select', ability_id: 'w-A01', source_instance_id: 'weapon',
      candidate_instance_ids: ['immune', 'ordinary'], query, bindings, min_count: 1, max_count: 1};
    const args = {evaluation: input, choice, source_card_id: 'w', frame: {ability_id: 'w-A01', source_instance_id: 'weapon'}};
    assert.throws(() => engine.validateEffectSelection({...args, selected_id: 'immune'}), /legal candidate/);
    assert.deepEqual(engine.validateEffectSelection({...args, selected_id: 'ordinary'}), ['ordinary']);
  }
});
test('server and browser evaluate immutable queries, expressions and conditions identically', () => {
  const input = freeze(fixture()), bindings = freeze({source: 'hero', n: 3});
  for (const engine of [server, browser]) {
    const evaluator = new engine.EffectEvaluation(input);
    assert.deepEqual(evaluator.query({zone: 'active_hand', tag: '英雄'}), ['hero']);
    assert.deepEqual(evaluator.query({zone: 'other_hand'}), ['other']);
    assert.deepEqual(evaluator.query({zone: 'active_hand', equipment_space: true}), ['weapon']);
    assert.equal(evaluator.expression({div: [-7, 3]}), -3);
    assert.equal(evaluator.expression({div: [0, -3]}), 0);
    assert.equal(evaluator.expression({combat: 'attack'}), 2);
    assert.equal(evaluator.expression({mul: [{value: 'n'}, {players: 'all'}]}, bindings), 6);
    assert.equal(evaluator.condition({compare: {left: {resource: 'xp'}, op: 'gt', right: 2}}), true);
    assert.throws(() => evaluator.expression({div: [1, 0]}), /division by zero/);
    assert.throws(() => evaluator.expression({value: 'missing'}), /unbound numeric/);
    assert.deepEqual(evaluator.query({zone: 'active_hand', equipped: true}), ['hero','weapon']);
  }
});
test('shared compiler accepts every reviewed operation in both browser and server builds', () => {
  const directory = new URL('../../cards/effects/', import.meta.url);
  const files = ['classic-v1.json','simple-reviewed.json','action-reviewed.json','battle-reviewed.json','event-reviewed.json'];
  const abilities = files.flatMap(name => JSON.parse(readFileSync(new URL(name, directory), 'utf8')).abilities);
  const mechanics = JSON.parse(readFileSync(new URL('mechanics.json', directory), 'utf8'));
  // Compiler needs only definition identity and original lines, not a database or DOM.
  const cards = {};
  for (const item of [...abilities, ...mechanics]) cards[item.source_card_id] ??= card(item.source_card_id);
  for (const item of mechanics) cards[item.source_card_id].effect_text += `${item.source_line}\n`;
  const gather = value => {
    if (value && typeof value === 'object') {
      if (value.op === 'gain_card') cards[value.card_id] ??= card(value.card_id);
      Object.values(value).forEach(gather);
    }
  };
  abilities.forEach(gather);
  const source = freeze({schema_version: 'thunderstone.effects/1', abilities, mechanics});
  freeze(cards);
  const expected = server.compileRuleset(source, cards);
  assert.equal(expected.abilities.length, 467);
  assert.equal(expected.mechanics.length, 206);
  assert.deepEqual(browser.compileRuleset(source, cards), expected);
});
test('monster semantic identity includes guardians and rank zero has no normal-rank neighbors', () => {
  const input = fixture();
  input.cards.g = card('g', {subcategory: '守护者', tags: '守护者|怪物'});
  input.cards.m = card('m', {subcategory: '怪物', tags: '龙'});
  input.state.instances.g1 = {card_id: 'g'};
  input.state.instances.g2 = {card_id: 'g'};
  input.state.instances.m = {card_id: 'm'};
  input.state.zones['hall:main:rank0'] = ['g1','g2'];
  input.state.zones['player:a:hand'].push('m');
  for (const engine of [server, browser]) {
    const evaluator = new engine.EffectEvaluation(freeze(input));
    assert.deepEqual(evaluator.query({zone: 'hall', semantic_type: 'monster'}), ['g1','g2']);
    assert.deepEqual(evaluator.query({zone: 'active_hand', semantic_type: 'monster'}), []);
    assert.deepEqual(evaluator.query({zone: 'hall', adjacent_to_var: 'first'}, {first: 'g1'}), []);
  }
});
test('village identity can overlap hero identity and never falls back to category', () => {
  const input = fixture();
  input.cards.h.tags += '|村庄';
  input.cards.w.tags += '|村庄';
  input.cards.u = card('u', {card_type: '村庄牌', tags: '英雄'});
  input.state.instances.untagged = {card_id: 'u'};
  input.state.zones['player:a:hand'].push('untagged');
  for (const engine of [server, browser]) {
    const evaluator = new engine.EffectEvaluation(input);
    assert.equal(engine.isVillage(input.cards.h), true);
    assert.equal(engine.isVillage(input.cards.u), false);
    assert.deepEqual(evaluator.query({zone: 'active_hand', semantic_type: 'village'}), ['hero','weapon']);
    assert.deepEqual(evaluator.query({zone: 'active_hand', semantic_type: 'hero'}), ['hero','untagged']);
    assert.deepEqual(evaluator.query({zone: 'active_hand', tag: '村庄', tags_none: ['英雄']}), ['weapon']);
  }
});
test('compiler rejects unbound variables, unknown ops, type errors and malformed choices', () => {
  const invalid = [
    {op: 'eval'}, {op: 'destroy', target: {var: 'missing'}}, {op: 'draw', count: true},
    {op: 'gain_card', card_id: 'missing'}, {op: 'set_battle_flag', flag: 'cannot_defeat', value: 1},
    {op: 'choose_value', kind: 'enum', bind: 'x', options: ['a','a'], then: {op: 'draw', count: 1}},
    {op: 'select', query: {zone: 'active_hand'}, bind: 'source', then: {op: 'show_hand'}},
    {op: 'select', query: {zone: 'active_hand'}, bind: 'x', min: null, then: {op: 'show_hand'}},
    {op: 'reveal', count: 1, bind: 'x', zone: null, then: {op: 'show_hand'}},
    {op: 'listen', event: 'TURN_START', conditions: null, body: {op: 'show_hand'}},
  ];
  for (const engine of [server, browser]) for (const body of invalid) assert.throws(() => compile(engine, body), engine.EffectCompileError);
});
test('all expression/query recursion paths enforce depth limits and numerical limits', () => {
  let expression = 1;
  for (let i = 0; i < 20; i++) expression = {count: {zone: 'active_hand', compare_stat: {field: 'level', op: 'ge', value: expression}}};
  for (const engine of [server, browser]) {
    assert.throws(() => engine.validateExpression(expression), /too deep/);
    assert.throws(() => engine.validateExpression(10001), /bounded integer/);
    assert.throws(() => compile(engine, {op: 'sequence', children: Array.from({length: 129}, () => ({op: 'show_hand'}))}), /safety bounds/);
    assert.throws(() => engine.validateQuery({zone: 'active_hand', min_by: 'attack', max_by: 'attack'}), /ambiguous/);
    assert.throws(() => engine.validateFilter({tag: ['英雄']}), /invalid filter/);
    assert.throws(() => engine.validateFilter({tags_any: ['英雄','英雄']}), /invalid filter/);
    assert.throws(() => new engine.EffectEvaluation(fixture()).expression({mul: [10000, 2]}), /numeric bounds/);
  }
});
