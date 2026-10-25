import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createConfigModel} from '../src/pages/config/model.js';

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
  const document = {body: new Element('body'), createElement: tag => new Element(tag), querySelector(selector) {
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
async function page({authenticated = true, search = '?room=' + 'a'.repeat(32), host = 1} = {}) {
  const ui = dom(), requests = [], navigations = [];
  const room = {id: 'a'.repeat(32), host_user_id: host, status: 'waiting', config_version: 1, version: 3,
    name: 'Test room', config: createConfigModel({}).defaultState()};
  const storage = new Map(authenticated ? [['thunderstone-session-v1', JSON.stringify({access_token: 'a', refresh_token: 'r'})]] : []);
  ui.get('app').hidden = true;
  const context = vm.createContext({document: ui.document, Option: ui.Option, Headers, URL, URLSearchParams,
    location: {search, replace: url => navigations.push(url)}, window: {addEventListener() {}},
    structuredClone, setTimeout, clearTimeout,
    sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    fetch: async (url, options = {}) => {
      requests.push({url, ...options});
      const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
      if (url === '/api/v1/options') return json(catalog());
      if (url === '/api/v1/users/me') return json({id: 1});
      if (url === '/api/v1/rooms/' + room.id) return json(room);
      if (url.endsWith('/config') && options.method === 'PATCH') {room.config = JSON.parse(options.body).config; room.version++; return json(room);}
      throw new Error('Unexpected request: ' + url);
    }, console});
  vm.runInContext(source, context); await settle(); await settle();
  return {...ui, requests, navigations, payload: () => JSON.parse(ui.get('json-output').value)};
}

test('configuration page wires selection, environment limits, export and reset after module split', async () => {
  const ui = await page();
  ui.get('card-configuration').value = 'custom'; ui.get('card-configuration').dispatch('change');
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
  ui.get('save-room').dispatch('click'); await settle();
  const saved = JSON.parse(ui.requests.find(request => request.method === 'PATCH').body);
  assert.equal(saved.expected_version, 3);
  assert.equal(saved.config.counts.monster_groups, 3);
});

test('default configuration locks 8/4/3 random groups and unit multipliers, preserving the custom draft on toggle', async () => {
  const ui = await page();
  for (const id of ['fixed-config-panel', 'extras-config-panel', 'multipliers-config-panel']) assert.equal(ui.get(id).hidden, true);
  assert.deepEqual(ui.payload().counts, {village_groups: 8, hero_groups: 4, monster_groups: 3});
  assert.deepEqual(ui.payload().instance_multipliers, {village: 1, hero: 1, monster: 1});
  for (const kind of ['village', 'hero', 'monster']) assert.equal(ui.get('count-' + kind).disabled, true);
  const select = value => {ui.get('card-configuration').value = value; ui.get('card-configuration').dispatch('change');};
  select('custom'); ui.get('count-village').value = 6; ui.get('count-village').dispatch('change');
  ui.get('group-list').children[0].dispatch('click');
  const custom = ui.payload(); select('default');
  assert.equal(ui.payload().counts.village_groups, 8); assert.deepEqual(ui.payload().selection.village.fixed_randomizer_ids, []);
  select('custom'); assert.deepEqual(ui.payload(), custom);
  for (const id of ['fixed-config-panel', 'extras-config-panel', 'multipliers-config-panel']) assert.equal(ui.get(id).hidden, false);
});

test('configuration is a host-owned room editor, never a public setup sandbox', async () => {
  const standalone = await page({search: ''});
  assert.deepEqual(standalone.navigations, ['/play']); assert.equal(standalone.requests.length, 0);
  const anonymous = await page({authenticated: false});
  assert.deepEqual(anonymous.navigations, ['/login?next=' + encodeURIComponent('/config?room=' + 'a'.repeat(32))]);
  assert.equal(anonymous.get('app').hidden, true);
  const member = await page({host: 2}); assert.equal(member.get('app').hidden, true);
  const html = await readFile(new URL('../config.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /setup-panel|generate-setup|setup-players/);
});
