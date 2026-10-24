import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import * as server from '../dist/index.js';
import * as browser from '../dist/browser/engine.js';
import {sha256, utf8} from '../dist/random/sha256.js';
import {cards as realCards, catalog as realCatalog} from './support/catalog.mjs';

function fixture() {
  const card = (id, values = {}) => ({card_id: id, slot_kind: 'front', card_type: '村庄牌',
    tags: '', effect_text: '', name: id, subcategory: '', initial_copy_count: '3', ...values});
  const cards = Object.fromEntries(Object.keys(server.STARTER_CARDS).map(id => [id, card(id, {card_type: '基础牌'})]));
  Object.assign(cards, {v: card('v'), h: card('h', {card_type: '英雄牌', tags: '英雄', 'wiki_英雄等级': '1'}),
    m: card('m', {card_type: '地下城牌', subcategory: '怪物', initial_copy_count: '12'}),
    s: card('s', {card_type: '地下城牌', subcategory: '雷霆之石'}),
    d: card('d', {card_type: '疾病牌', tags: '疾病', initial_copy_count: '24'})});
  const groups = [{randomizer_id: 'rv', kind: 'village', members: ['v']},
    {randomizer_id: 'rh', kind: 'hero', members: ['h']}, {randomizer_id: 'rm', kind: 'monster', members: ['m']}];
  const config = {mode: 'classic', counts: {village_groups: 1, hero_groups: 1, monster_groups: 1},
    selection: {village: {fixed_randomizer_ids: []}, hero: {fixed_randomizer_ids: []}, monster: {fixed_randomizer_ids: []},
      dungeon_features: {mode: 'manual'}, guardian: {random_count: 0, fixed_card_ids: []}, environment: {random_count: 0, fixed_card_ids: []},
      trap: {random_count: 0, fixed_group_ids: []}, treasure: {random_count: 0, fixed_group_ids: []}, thunderstone: {fixed_card_ids: []}},
    instance_multipliers: {village: 1, hero: 1, monster: 1}};
  return {request: {match_id: 'portable', player_ids: ['alice','bob'], rng_seed: '雷霆🐉', config}, cards,
    index: {cards_csv_sha256: 'catalog-fixture', groups, dungeon_features: [], randomizer_pools: {village: ['rv'], hero: ['rh'], monster_or_feature: ['rm']},
      dungeon_feature_entry: {randomizer_id: 'entry', draw_feature_count: 1}, other_pools: {environment: [], guardian: [], thunderstone: ['s'], disease: ['d']}},
    panel: {catalog_hash: 'catalog-fixture', groups: {village: [{id: 'rv'}], hero: [{id: 'rh'}], monster: [{id: 'rm'}]},
      dungeon_cards: {environment: [], guardian: []}, dungeon_groups: {trap: [], treasure: []}, thunderstones: [{id: 's'}]},
    frozen_config_id: 'adapter-config-fingerprint', effects_version: 'effects-fixture'};
}
function freeze(value) {if (value && typeof value === 'object') {Object.freeze(value); Object.values(value).forEach(freeze);} return value;}
function referenceRandom(seed, position) {
  const key = createHash('sha256').update(String(seed), 'utf8').digest();
  return size => {
    const total = 1n << 256n, bound = BigInt(size), limit = total - total % bound;
    while (true) {
      const counter = Buffer.alloc(16); counter.writeBigUInt64BE(position >> 64n); counter.writeBigUInt64BE(position & ((1n << 64n) - 1n), 8); position++;
      const value = BigInt('0x' + createHash('sha256').update(key).update(counter).digest('hex'));
      if (value < limit) return [value % bound, position];
    }
  };
}
test('portable SHA-256 matches standard vectors and Unicode including block boundaries', () => {
  for (const value of ['', 'abc', '雷霆🐉', ...[55,56,63,64,65,127,128,129,1000].map(n => 'a'.repeat(n))]) {
    assert.equal(Buffer.from(sha256(utf8(value))).toString('hex'), createHash('sha256').update(value).digest('hex'));
    assert.deepEqual(Buffer.from(utf8(value)), Buffer.from(value, 'utf8'));
  }
});
test('browser and server RNG preserve rejection sampling, Unicode and exact 128-bit counters', () => {
  for (const engine of [server, browser]) for (const seed of ['seed', '雷霆🐉', -42]) {
    for (const start of [0n, (1n << 53n) + 1n, (1n << 100n) + 7n, (1n << 128n) - 20n]) {
      const rng = new engine.RandomStream(seed, start.toString()), reference = referenceRandom(seed, start);
      for (const size of [1n, 3n, (1n << 53n) + 13n, (1n << 255n) + 1n]) {
        const [value, position] = reference(size);
        assert.equal(rng.randbelow(size), value);
        assert.equal(BigInt(rng.counter), position);
      }
      const resumed = new engine.RandomStream(rng.seed, rng.counter);
      assert.equal(resumed.randbelow(97), rng.randbelow(97));
    }
  }
});
test('random validation fails promptly without losing precision or using ambient randomness', () => {
  for (const engine of [server, browser]) {
    for (const seed of ['', true, null, 1.5, 2 ** 53]) assert.throws(() => new engine.RandomStream(seed));
    for (const counter of [-1, 1.5, 2 ** 53, (1n << 128n).toString()]) assert.throws(() => new engine.RandomStream('seed', counter));
    const rng = new engine.RandomStream('seed');
    assert.throws(() => rng.randbelow(0), /empty/);
    assert.throws(() => rng.randbelow((1n << 256n) + 1n), /256 bits/);
    const end = new engine.RandomStream('seed', ((1n << 128n) - 1n).toString());
    end.randbelow(1);
    assert.throws(() => end.randbelow(1), /exhausted/);
    const same = new engine.RandomStream('seed'), values = [];
    same.shuffle(values); same.shuffle(['only']);
    assert.equal(same.counter, 0);
  }
});
test('browser and Node setup produce identical immutable complete states and events', () => {
  const input = freeze(fixture()), expected = server.startGame(input);
  assert.deepEqual(browser.startGame(input), expected);
  assert.equal(expected.state.effects_version, 'effects-fixture');
  assert.equal(expected.state.frozen_config_id, 'adapter-config-fingerprint');
  assert.equal(expected.state.zones['hall:main'].length, 3);
  assert.equal(expected.state.zones['player:alice:hand'].length, 6);
  assert.equal(expected.state.supply_rules.disease_infinite, true);
  assert.equal(expected.state.supply_rules.basic_infinite, true);
  server.validateSetupState(expected.state, input.cards);
});
test('setup exposes typed configuration issues and isolated builder snapshots', () => {
  for (const engine of [server, browser]) {
    const input = fixture(); input.request.config.counts.hero_groups = true;
    assert.throws(() => engine.startGame(input), error => error instanceof engine.SetupError && error.issues.some(issue => issue.path === 'counts.hero_groups'));
    const builder = new engine.SetupBuilder(fixture());
    builder.create('m', 'dungeon:main', {origin: 'test', count: 4});
    const saved = builder.snapshot(), resumed = new engine.SetupBuilder(fixture(), saved);
    resumed.fillHall('dungeon:main');
    assert.equal(builder.zones['dungeon:main'].length, 4);
    assert.equal(saved.zones['dungeon:main'].length, 4);
    assert.equal(resumed.zones['hall:main'].length, 3);
  }
});

test('village thieves are one level-ordered supply using CSV counts, village multipliers and Stormhold removal', () => {
  for (const multiplier of [1, 2]) for (const stormhold of [false, true]) {
    const input = fixture(), group = realCatalog.setup_index.groups.find(group => group.randomizer_id === 'TS-0081');
    for (const id of ['TS-0081', 'TS-0300', 'TS-0301']) input.cards[id] = realCards[id];
    input.index.groups[0] = group;
    input.index.randomizer_pools.village = ['TS-0081']; input.panel.groups.village = [{id: 'TS-0081'}];
    input.request.config.instance_multipliers.village = multiplier;
    if (stormhold) {
      input.cards['TS-0197'] = realCards['TS-0197']; input.index.other_pools.environment = ['TS-0197'];
      input.panel.dungeon_cards.environment = [{id: 'TS-0197', name: realCards['TS-0197'].name}];
      input.request.config.selection.environment.fixed_card_ids = ['TS-0197'];
    }
    const expected = server.startGame(input);
    assert.deepEqual(browser.startGame(input), expected);
    const state = expected.state, ids = state.zones['village_supply:TS-0081'].map(id => state.instances[id].card_id);
    assert.deepEqual(Object.keys(state.zones).filter(zone => zone.startsWith('village_supply:')), ['village_supply:TS-0081']);
    assert.deepEqual(ids, [...Array(5 * multiplier - (stormhold ? 2 : 0)).fill('TS-0301'), ...Array(3 * multiplier).fill('TS-0300')]);
    assert.equal(state.zones.destroyed?.length ?? 0, stormhold ? 2 : 0);
    assert.equal(input.cards['TS-0301'].initial_copy_count, '5'); assert.equal(input.cards['TS-0300'].initial_copy_count, '3');
    server.validateSetupState(state, input.cards);
  }
});
