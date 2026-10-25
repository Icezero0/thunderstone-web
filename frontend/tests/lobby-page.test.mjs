import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../.test-dist/lobby-page.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function page(search = '') {
  const nodes = new Map(), requests = [], sockets = [], events = {}, navigations = [];
  let user = {id: 1, username: '阿莉丝', email: 'alice@example.com', avatar_url: '/api/v1/users/avatars/first.png'};
  let room = null;
  class Element {
    constructor(tag) {this.tag = tag; this.children = []; this.events = {}; this.value = ''; this.hidden = false; this.checked = false; this.dataset = {}; this.classList = {toggle() {}};}
    append(...children) {this.children.push(...children);}
    replaceChildren(...children) {this.children = children;}
    setAttribute(key, value) {this[key] = value;}
    removeAttribute(key) {delete this[key];}
    addEventListener(type, callback) {this.events[type] = callback;}
    removeEventListener(type, callback) {if (this.events[type] === callback) delete this.events[type];}
    fire(type) {this.events[type]?.({target: this, preventDefault() {}});}
  }
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]); element.hidden = /\bhidden\b/.test(match[0]); element.checked = /\bchecked\b/.test(match[0]);
    nodes.set(match[2], element);
  }
  const get = id => {assert.ok(nodes.has(id), id); return nodes.get(id);};
  const document = {hidden: false, querySelector: value => get(value.slice(1)), createElement: tag => new Element(tag),
    createElementNS: (_namespace, tag) => new Element(tag), addEventListener() {}};
  class Socket {
    static OPEN = 1; readyState = 1;
    constructor() {sockets.push(this);}
    send() {} close() {this.onclose?.();}
  }
  const tokens = new Map([['thunderstone-session-v1', JSON.stringify({access_token: 'access', refresh_token: 'refresh'})]]);
  const context = vm.createContext({document, Headers, URLSearchParams, URL, WebSocket: Socket, confirm: () => true,
    sessionStorage: {getItem: key => tokens.get(key) ?? null, setItem: (key, value) => tokens.set(key, value), removeItem: key => tokens.delete(key)},
    window: {addEventListener: (type, callback) => {events[type] = callback;}},
    location: {search, protocol: 'https:', host: 'test.invalid', replace(url) {navigations.push(url);}, assign(url) {navigations.push(url);}},
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    Option: function(text, value) {const element = new Element('option'); element.textContent = text; element.value = value; return element;},
    fetch: async (path, options) => {
      requests.push({path, ...options}); let value;
      if (path.endsWith('/users/me')) value = user;
      else if (path.endsWith('/rooms/current')) value = {room};
      else if (path.endsWith('/options')) value = {card_names: {}};
      else if (options.method === 'POST' && path.endsWith('/rooms')) {
        const data = JSON.parse(options.body);
        room = {id: 'a'.repeat(32), ...data, host_user_id: 1, host_name: user.username, status: 'waiting', version: 1, config_version: 1,
          player_count: 1, players: [{user_id: 1, display_name: user.username, avatar_url: user.avatar_url, ready: false}], all_ready: false,
          config: {counts: {village_groups: 8, hero_groups: 4, monster_groups: 3}, selection: {
            dungeon_features: {mode: 'classic_random'}, village: {fixed_randomizer_ids: []}, hero: {fixed_randomizer_ids: []},
            monster: {fixed_randomizer_ids: []}, thunderstone: {fixed_card_ids: []}}, instance_multipliers: {village: 1, hero: 1, monster: 1}}};
        value = room;
      } else if (path.endsWith('/rooms')) value = {rooms: []};
      else throw new Error(`Unexpected request ${path}`);
      return new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
    }});
  vm.runInContext(source, context); await settle(); await settle();
  return {get, requests, navigations,
    async started() {room = {...room, status: 'playing', active_match_id: 'm'.repeat(32), version: room.version + 1};
      sockets[0].onmessage({data: JSON.stringify({type: 'match_changed'})}); await settle(); await settle();},
    async refreshUser(value) {user = {...user, ...value}; sockets[0].onmessage({data: JSON.stringify({type: 'profile_changed'})}); await settle();},
    async create(isPublic) {get('new-room-name').value = '新队伍'; get('new-room-public').checked = isPublic; get('create-form').fire('submit'); await settle();},
    cleanup() {events.pagehide?.();}};
}

for (const search of ['', '?view=room']) test(`room participants follow match start automatically: ${search}`, async () => {
  const p = await page(search);
  try {
    await p.create(true); assert.equal(p.get('ready').textContent, '准备'); assert.equal(p.get('ready-note').hidden, true);
    await p.started(); assert.equal(p.navigations.at(-1), '/match?id=' + 'm'.repeat(32));
    assert.doesNotMatch(html.match(/<nav[^>]*>[\s\S]*?<\/nav>/)[0], /href="\/config"/);
  } finally {p.cleanup();}
});

test('the lobby header uses the shared avatar and follows profile changes without replacing it', async () => {
  const p = await page();
  try {
    const avatar = p.get('account-avatar').children[0], [fallback, image] = avatar.children;
    assert.equal(p.get('account-name').textContent, '阿莉丝'); assert.equal(image.src, '/api/v1/users/avatars/first.png');
    await p.refreshUser({username: '新名称', avatar_url: '/api/v1/users/avatars/second.png'});
    assert.equal(p.get('account-avatar').children[0], avatar); assert.equal(p.get('account-name').textContent, '新名称');
    assert.equal(image.src, '/api/v1/users/avatars/second.png'); image.fire('error'); assert.equal(fallback.hidden, false);
    assert.equal(p.get('new-room-public').checked, true);
  } finally {p.cleanup();}
});

for (const isPublic of [true, false]) test(`creating a ${isPublic ? 'public' : 'private'} room sends the selected checkbox value`, async () => {
  const p = await page();
  try {
    await p.create(isPublic);
    const request = p.requests.find(request => request.method === 'POST' && request.path === '/api/v1/rooms');
    assert.deepEqual(JSON.parse(request.body), {name: '新队伍', is_public: isPublic});
    assert.equal(p.get('room-view').hidden, false); assert.equal(p.get('lobby-view').hidden, true);
    assert.match(p.get('room-state').textContent, isPublic ? /公开/ : /私有/);
  } finally {p.cleanup();}
});
