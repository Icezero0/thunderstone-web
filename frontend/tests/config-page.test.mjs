import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../.test-dist/config-page.js', import.meta.url), 'utf8');

function dom() {
  const ids = new Map();
  class Element {
    constructor(tag = 'div') {
      this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = {};
      this.value = ''; this.disabled = false; this.hidden = false; this.checked = false;
      this.classList = {toggle() {}, add() {}};
    }
    set id(value) {this._id = value; ids.set(value, this);}
    get id() {return this._id;}
    set textContent(value) {this.text = value; this.children = [];}
    get textContent() {return (this.text || '') + this.children.map(child => child.textContent).join('');}
    append(...children) {this.children.push(...children);}
    replaceChildren(...children) {this.children = children; this.text = '';}
    setAttribute() {}
    addEventListener(name, callback) {this.events[name] = callback;}
    dispatch(name) {return this.events[name]?.({target: this});}
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return all;
      if (selector === 'select[data-allocation-id]') return all.filter(node => node.dataset.allocationId);
      if (selector === 'select[data-allocation-kind="group"]') return all.filter(node => node.dataset.allocationKind === 'group');
      throw new Error('Unexpected selector: ' + selector);
    }
  }
  const get = id => {if (!ids.has(id)) {const node = new Element(); node.id = id;} return ids.get(id);};
  const tabs = ['village', 'hero', 'monster', 'thunderstone'].map(kind => {
    const node = new Element('button'); node.dataset.kind = kind; return node;
  });
  const extras = ['guardian', 'environment', 'trap', 'treasure'].map(extraKind => {
    const node = new Element('button'); node.dataset.extraKind = extraKind; return node;
  });
  const document = {createElement: tag => new Element(tag), querySelector(selector) {
    if (selector.startsWith('#')) return get(selector.slice(1));
    return get(selector);
  }, querySelectorAll(selector) {
    if (selector === '.group-tabs .tab') return tabs;
    if (selector === '.extra-tab') return extras;
    throw new Error('Unexpected selector: ' + selector);
  }};
  function Option(text, value) {const option = new Element('option'); option.textContent = text; option.value = value; return option;}
  return {get, tabs, extras, document, Option};
}

function catalog() {
  const option = (id, name = id) => ({id, name, image: `/cards/${id}.png`, copy_count: 1, members: [id]});
  return {
    catalog_hash: 'config-fixture', card_names: {'TS-0683': '末日之心'},
    groups: Object.fromEntries(['village', 'hero', 'monster'].map(kind => [kind,
      Array.from({length: 12}, (_, i) => option(`${kind}-${i}`))])),
    dungeon_cards: {guardian: [option('TS-0683')], environment: [option('spire', '飞龙尖塔'), option('TS-0199', '放逐仪式')]},
    dungeon_groups: {trap: [], treasure: []},
    thunderstones: Array.from({length: 7}, (_, i) => option(`stone-${i}`)),
    environment_rules: {spire: {scenario: 'flying_spire', count_override: {monster: 4}, thunderstone_target: 2},
      'TS-0199': {scenario: 'banishing_ritual', thunderstone_target: 7}},
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
async function page(responses = []) {
  const ui = dom(); const storage = new Map(); const requests = [];
  ui.get('setup-players').value = 'alice,bob'; ui.get('setup-seed').value = 'page-test';
  const context = vm.createContext({document: ui.document, Option: ui.Option,
    URLSearchParams, location: {search: ''}, structuredClone, setTimeout, clearTimeout,
    localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    fetch: async (url, options) => {
      if (url === '/api/v1/options') return {ok: true, json: async () => catalog()};
      requests.push(JSON.parse(options.body));
      const result = responses.shift();
      assert.ok(result, 'Unexpected request: ' + url);
      return typeof result === 'function' ? result() : {ok: true, json: async () => result};
    }, console});
  vm.runInContext(source, context);
  await settle();
  assert.equal(ui.get('app').hidden, false, ui.get('loading').textContent);
  assert.equal(ui.get('loading').hidden, true, ui.get('loading').textContent);
  return {...ui, storage, requests, payload: () => JSON.parse(ui.get('json-output').value)};
}

test('configuration page wires selection, environment limits, export and reset after module split', async () => {
  const ui = await page();
  ui.get('group-list').children[0].dispatch('click');
  assert.deepEqual(ui.payload().selection.village.fixed_randomizer_ids, ['village-0']);
  ui.get('feature-random').checked = false; ui.get('feature-random').dispatch('change');
  ui.extras.find(node => node.dataset.extraKind === 'environment').dispatch('click');
  ui.get('extra-list').children.find(node => node.textContent.includes('飞龙尖塔')).dispatch('click');
  assert.equal(ui.get('count-monster').value, 4);
  assert.equal(ui.get('count-monster').disabled, true);
  assert.equal(ui.get('monster-adjustment').textContent, '固定');
  ui.get('extra-list').children.find(node => node.textContent.includes('放逐仪式')).dispatch('click');
  assert.equal(ui.payload().selection.thunderstone.fixed_card_ids.length, 7);
  assert.deepEqual(ui.payload().selection.guardian.fixed_card_ids, ['TS-0683']);
  assert.equal(ui.get('count-monster').disabled, false);
  ui.get('reset').dispatch('click');
  assert.equal(ui.payload().selection.dungeon_features.mode, 'classic_random');
  assert.deepEqual(ui.payload().selection.village.fixed_randomizer_ids, []);
  const saved = JSON.parse(ui.storage.get('thunderstone-rules-draft-v7'));
  assert.equal(saved.catalog_hash, 'config-fixture');
  assert.equal(saved.state.counts.monster_groups, 3);
});

test('flying spire allocation keeps the original request and submits two groups per dungeon', async () => {
  const ready = {status: 'ready', events: [], state: {first_player_id: 'alice',
    selected_groups: {village: [], hero: [], monster: []}, selected_features: {environment: [], guardian: [], trap: [], treasure: []},
    selected_thunderstones: [], supply_rules: {disease_weights: {}, disease_card_ids: [], disease_mode: 'normal'},
    instances: {}, zones: {}, player_order: [], players: {}}};
  const ui = await page([{status: 'choice_required', choice: {
    group_ids: ['monster-0', 'monster-1', 'monster-2', 'monster-3'], feature_ids: [],
  }}, ready]);
  ui.get('generate-setup').dispatch('click'); await settle();
  assert.equal(ui.get('setup-choice').hidden, false);
  const selects = ui.get('setup-choice').querySelectorAll('select[data-allocation-id]');
  selects[1].value = 'b'; selects[1].dispatch('change');
  assert.equal(ui.get('submit-allocation').disabled, true);
  selects[2].value = 'a'; selects[2].dispatch('change');
  assert.equal(ui.get('submit-allocation').disabled, false);
  ui.get('submit-allocation').dispatch('click'); await settle();
  assert.equal(ui.requests.length, 2);
  assert.deepEqual(ui.requests[1], {...ui.requests[0], scenario_choices: {two_dungeons: {
    group_a_ids: ['monster-0', 'monster-2'], group_a_feature_ids: [],
  }}});
  assert.equal(ui.get('setup-choice').hidden, true);
  assert.equal(ui.get('setup-result').hidden, false);
  assert.match(ui.get('setup-status').textContent, /组局完成/);
});

test('editing configuration while setup is in flight discards the stale response', async () => {
  let complete;
  const ui = await page([() => new Promise(resolve => {complete = resolve;})]);
  ui.get('generate-setup').dispatch('click'); await settle();
  ui.get('reset').dispatch('click');
  complete({ok: true, json: async () => ({status: 'choice_required', choice: {group_ids: [], feature_ids: []}})});
  await settle();
  assert.equal(ui.get('setup-choice').hidden, true);
  assert.equal(ui.get('setup-result').hidden, true);
  assert.match(ui.get('setup-status').textContent, /规则配置已修改/);
  assert.equal(ui.get('generate-setup').disabled, false);
});
