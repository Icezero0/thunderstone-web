import assert from 'node:assert/strict';
import test from 'node:test';
import * as nodeEngine from '../dist/index.js';
import * as browserEngine from '../dist/browser/engine.js';

const card = (id, values) => ({card_id: id, card_type: '村庄牌', subcategory: '', tags: '', name: id, effect_text: '',
  '正文_基础攻击': '', '正文_基础魔法攻击': '', 'wiki_光照': '', 'wiki_力量': '', 'wiki_重量': '',
  'wiki_金币值': '', 'wiki_英雄等级': '', 'wiki_购买价格': '', 'wiki_生命值': '', 'wiki_胜利点': '', ...values});
function context() {
  return {schema_version: 'thunderstone.preview/1', engine_version: nodeEngine.ENGINE_VERSION, game_version: 42, catalog_version: 'catalog-v1', effects_version: 'rules-v1', player_id: 'alice',
    cards: {
      militia: card('militia', {card_type: '基础牌', tags: '民兵|英雄', '正文_基础攻击': '1', 'wiki_力量': '2'}),
      dagger: card('dagger', {tags: '武器|锋利', '正文_基础攻击': '1', 'wiki_重量': '1'}),
      fireball: card('fireball', {tags: '法术', '正文_基础魔法攻击': '3', 'wiki_光照': '1'}),
      monster: card('monster', {card_type: '地下城牌', subcategory: '怪物', tags: '龙|红龙|怪物', 'wiki_生命值': '3'}),
      disease: card('disease', {card_type: '疾病牌', tags: '疾病', '正文_基础攻击': '-1'}),
    }, mechanics: [], state: {active_player_id: 'alice', players: {alice: {xp: 0}}, active_settings: [],
      zones: {'player:alice:hand': ['h','w','s'], 'hall:main': ['m']},
      instances: {h: {card_id: 'militia'}, w: {card_id: 'dagger'}, s: {card_id: 'fireball'}, m: {card_id: 'monster'}, d: {card_id: 'disease'}},
      battle_context: {equipped_weapon_by_hero: {}}}};
}
function freeze(value) {
  if (value && typeof value === 'object') {Object.freeze(value); for (const child of Object.values(value)) freeze(child);}
  return value;
}

test('monster identity tag does not merge printed families or split color dragons', () => {
  for (const engine of [nodeEngine, browserEngine]) {
    const red = card('red', {card_type: '地下城牌', subcategory: '怪物', tags: '龙|红龙|怪物'});
    const white = card('white', {card_type: '地下城牌', subcategory: '怪物', tags: '龙|白龙|怪物'});
    const humanoid = card('humanoid', {card_type: '地下城牌', subcategory: '怪物', tags: '龙|类人生物|怪物'});
    const guardian = card('guardian', {card_type: '地下城牌', subcategory: '守护者', tags: '守护者|怪物'});
    assert.deepEqual(engine.monsterFamily(red), engine.monsterFamily(white));
    assert.notDeepEqual(engine.monsterFamily(red), engine.monsterFamily(humanoid));
    assert.equal(engine.matches(red, {tag: '怪物'}), true);
    assert.equal(engine.matches(guardian, {tag: '怪物'}), true);
    assert.equal(engine.matches(guardian, {subcategory: '守护者'}), true);
  }
});
test('browser bundle and Node module calculate identical immutable snapshots', () => {
  const input = freeze(context());
  const result = nodeEngine.previewBattle(input, 'm');
  assert.deepEqual(browserEngine.previewBattle(input, 'm'), result);
  assert.equal(result.calculation.attack, 1);
  assert.equal(result.calculation.magic_attack, 3);
  assert.equal(result.calculation.light, 1);
  assert.equal(result.game_version, 42);
  assert.equal(result.outcome_before_battle_effects, 'win');
});
test('equipment and repeated local calculations have no sticky effects', () => {
  const input = context();
  input.state.zones['player:alice:hand'] = ['h','w'];
  assert.equal(nodeEngine.combatValues(input, 0).attack, 1);
  input.state.battle_context.equipped_weapon_by_hero = {h: 'w'};
  assert.equal(nodeEngine.combatValues(input, 0).attack, 2);
  input.state.battle_context.equipped_weapon_by_hero = {};
  assert.equal(nodeEngine.combatValues(input, 0).attack, 1);
});
test('spells work without heroes and darkness is rank dependent', () => {
  const input = context();
  input.state.zones['player:alice:hand'] = ['s'];
  assert.equal(nodeEngine.combatValues(input, 1).effective_attack, 3);
  assert.equal(nodeEngine.combatValues(input, 2).effective_attack, 1);
  assert.equal(nodeEngine.combatValues(input, 3).effective_attack, 0);
});
test('disease allocations, immunity and rank zero remain distinct', () => {
  const input = context();
  input.state.zones['player:alice:hand'].push('d');
  input.state.battle_context.disease_penalty_assignments = {d: 'magic_attack'};
  const result = nodeEngine.combatValues(input, 0);
  assert.equal(result.attack, 1);
  assert.equal(result.magic_attack, 2);
  assert.equal(result.darkness_penalty, 0);
  input.cards.monster.effect_text = '免疫魔法攻击。';
  assert.throws(() => nodeEngine.combatValues(input, 1, input.cards.monster), /positive attack type/);
});
test('hero identity uses tags, including village heroes, without category inference', () => {
  assert.equal(nodeEngine.isHero(card('v', {tags: '盗贼|英雄'})), true);
  assert.equal(nodeEngine.isHero(card('h', {card_type: '英雄牌', tags: '法师'})), false);
  assert.equal(nodeEngine.matches(card('v', {tags: '盗贼|英雄'}), {tags_any: ['英雄']}), true);
});
test('monster identity and preview use the tag for guardians without category inference', () => {
  for (const engine of [nodeEngine, browserEngine]) {
    const input = context();
    input.cards.monster = card('monster', {subcategory: '守护者', tags: '守护者|怪物', 'wiki_生命值': '3'});
    input.state.zones['hall:main'] = [];
    input.state.zones['hall:main:rank0'] = ['m'];
    assert.equal(engine.isMonster(input.cards.monster), true);
    assert.equal(engine.previewBattle(input, 'm').calculation.darkness_penalty, 0);
    input.cards.monster = {...input.cards.monster, subcategory: '怪物', tags: '守护者'};
    assert.equal(engine.isMonster(input.cards.monster), false);
    assert.throws(() => engine.previewBattle(input, 'm'), /monster/);
  }
});
test('disease tag controls attack allocation without category inference in both runtimes', () => {
  for (const engine of [nodeEngine, browserEngine]) {
    const input = context();
    input.cards.disease = {...input.cards.disease, card_type: '村庄牌'};
    input.state.zones['player:alice:hand'].push('d');
    input.state.battle_context.disease_penalty_assignments = {d: 'magic_attack'};
    assert.equal(engine.isDisease(input.cards.disease), true);
    const trace = engine.combatValues(input, 0);
    assert.equal(trace.attack, 1);
    assert.equal(trace.magic_attack, 2);
    assert.equal(engine.isDisease({...input.cards.disease, card_type: '疾病牌', tags: ''}), false);
  }
});
test('thunderstone tags determine scoring bonus and tie break without category inference', () => {
  for (const engine of [nodeEngine, browserEngine]) {
    const cards = {stone: card('stone', {tags: '雷霆之石'}),
      fake: card('fake', {subcategory: '雷霆之石'})};
    const input = {cards, mechanics: [], state: {player_order: ['alice','bob'], players: {alice: {}, bob: {}},
      instances: {a: {card_id: 'stone', owner_player_id: 'alice'}, b: {card_id: 'fake', owner_player_id: 'bob'}}}};
    assert.equal(engine.isThunderstone(cards.stone), true);
    assert.equal(engine.isThunderstone(cards.fake), false);
    const result = engine.scoreGame(input);
    assert.deepEqual(result.winner_ids, ['alice']);
    assert.equal(result.tie_break, 'thunderstone');
    input.state.instances.second = {card_id: 'stone', owner_player_id: 'alice'};
    input.mechanics.push({id: 'stone-A01', source_card_id: 'stone', op: 'scoring', params: {other_stones: 2}});
    assert.equal(engine.scoreGame(input).players.alice.victory_points, 4);
  }
});
test('preview rejects hidden/non-hall targets and duplicate weapons', () => {
  const input = context();
  assert.throws(() => nodeEngine.previewBattle(input, 'h'), /visible dungeon hall/);
  input.state.battle_context.equipped_weapon_by_hero = {h: ['w','w']};
  assert.throws(() => nodeEngine.previewBattle(input, 'm'), /only be equipped once/);
});
test('browser refuses a context produced by a different engine build', () => {
  const input = context();
  input.engine_version = 'different-build';
  assert.throws(() => browserEngine.previewBattle(input, 'm'), /version mismatch/);
});
