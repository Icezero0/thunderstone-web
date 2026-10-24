import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {cropRect, profilePatch, validateAvatar} from '../.test-dist/profile-model.js';

const source = await readFile(new URL('../.test-dist/profile-page.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../profile.html', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const account = {id: 1, email: 'alice@example.com', username: '阿莉丝', avatar_url: null};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

async function page({authenticated = true, saveFailure = false, confirmLeave = false} = {}) {
  const nodes = new Map(), requests = [], navigations = [], urls = [], revoked = [], events = {}, draws = [];
  let current = {...account};
  const saved = new Map(authenticated ? [['thunderstone-session-v1', JSON.stringify({access_token: 'access', refresh_token: 'refresh'})]] : []);
  class Element {
    constructor(tag) {this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.disabled = false; this.inert = false; this.attributes = {}; this.captured = new Set();}
    append(...children) {this.children.push(...children);}
    setAttribute(key, value) {this.attributes[key] = value;}
    removeAttribute(key) {delete this.attributes[key];}
    addEventListener(type, handler) {(this.handlers[type] ??= []).push(handler);}
    removeEventListener(type, handler) {this.handlers[type] = (this.handlers[type] ?? []).filter(value => value !== handler);}
    fire(type, fields = {}) {
      const event = {target: this, button: 0, pointerId: 1, clientX: 0, clientY: 0, defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}, ...fields};
      for (const handler of this.handlers[type] ?? []) handler(event); return event;
    }
    focus() {document.activeElement = this;}
    click() {this.fire('click');}
    querySelectorAll() {return [...nodes.values()].filter(node => (node.tag === 'button' && !node.disabled) || node.id === 'avatar-crop-canvas');}
    getBoundingClientRect() {return {width: 360, height: 360, left: 0, top: 0};}
    setPointerCapture(id) {this.captured.add(id);}
    hasPointerCapture(id) {return this.captured.has(id);}
    releasePointerCapture(id) {this.captured.delete(id);}
    getContext() {return {translate() {}, rotate() {}, drawImage(...args) {draws.push(args);}, clearRect() {}};}
    toBlob(callback) {callback(new Blob(['cropped image'], {type: 'image/png'}));}
  }
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1]); node.id = match[2]; node.hidden = /\bhidden\b/.test(match[0]);
    node.disabled = /\bdisabled\b/.test(match[0]); nodes.set(node.id, node);
  }
  const get = id => {assert.ok(nodes.has(id), id); return nodes.get(id);};
  const back = new Element('a');
  const document = {activeElement: null, getElementById: get, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), querySelectorAll: () => [back]};
  class TestURL extends URL {
    static createObjectURL() {const value = `blob:avatar-${urls.length}`; urls.push(value); return value;}
    static revokeObjectURL(value) {revoked.push(value);}
  }
  class Image {
    naturalWidth = 800; naturalHeight = 600;
    decode() {return Promise.resolve();}
  }
  const context = vm.createContext({document, window: {addEventListener: (type, callback) => {events[type] = callback;}},
    location: {replace: value => navigations.push(value), reload() {}}, confirm: () => confirmLeave,
    sessionStorage: {getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)},
    Headers, TextEncoder, AbortController, Blob, File, FormData, URL: TestURL, Image,
    fetch: async (path, options) => {
      requests.push({path, ...options});
      if (options.method === 'PATCH') {
        if (path.endsWith('/avatar')) {current = {...current, avatar_url: '/api/v1/users/avatars/new.png'}; return json(current);}
        if (saveFailure) return json({error: {message: '保存失败，请重试'}}, 503);
        current = {...current, ...JSON.parse(options.body)}; return json(current);
      }
      return json(current);
    }});
  vm.runInContext(source, context); await settle();
  return {get, requests, navigations, saved, events, urls, revoked, back, draws,
    async change(id, value) {get(id).value = value; get('profile-form').fire('input'); await settle();},
    async click(id) {get(id).fire('click'); await settle();},
    async submit() {get('profile-form').fire('submit'); await settle();},
    async avatar() {get('avatar-file').files = [new File(['image'], 'test.png', {type: 'image/png'})]; get('avatar-file').fire('change'); await settle();}};
}

test('settings require login and the page exposes the immutable email without changing it', async () => {
  const anonymous = await page({authenticated: false});
  assert.deepEqual(anonymous.navigations, ['/play?next=%2Fprofile']); assert.equal(anonymous.requests.length, 0);
  const p = await page();
  assert.equal(p.get('profile-username').value, account.username); assert.equal(p.get('profile-email').value, account.email);
  assert.match(html, /id="profile-email"[^>]*readonly/); assert.equal(p.get('profile-save').disabled, true);
  await p.change('profile-username', '  新名字  '); await p.change('profile-email', 'cannot-save@example.com'); await p.submit();
  const patch = p.requests.find(request => request.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.body), {username: '新名字'}); assert.equal(p.get('profile-notice').dataset.success, 'true');
  assert.equal(p.get('profile-save').disabled, true); assert.equal(p.saved.size, 1);
});

test('password confirmation blocks an invalid save; successful change clears the session and asks for login', async () => {
  const p = await page(); await p.change('profile-password', 'new-secret'); await p.change('profile-password-confirm', 'different'); await p.submit();
  assert.equal(p.requests.filter(request => request.method === 'PATCH').length, 0);
  assert.match(p.get('profile-notice').textContent, /不一致/);
  await p.change('profile-password-confirm', 'new-secret'); await p.submit();
  assert.deepEqual(JSON.parse(p.requests.find(request => request.method === 'PATCH').body), {password: 'new-secret'});
  assert.equal(p.saved.size, 0); assert.deepEqual(p.navigations, ['/play?password_changed=1']);
  assert.equal(p.get('profile-password').value, '');
});

test('avatar cropping uses the shared modal and saving uploads multipart before changing the profile', async () => {
  const p = await page(); await p.avatar();
  assert.equal(p.get('avatar-crop-dialog').hidden, false); assert.equal(p.get('profile-main').inert, true);
  await p.click('avatar-crop-right'); await p.click('avatar-crop-use');
  assert.equal(p.get('avatar-crop-dialog').hidden, true); assert.equal(p.get('profile-main').inert, false);
  assert.equal(p.get('avatar-reset').hidden, false); assert.equal(p.get('profile-save').disabled, false);
  await p.change('profile-username', '新名称'); await p.submit();
  const patches = p.requests.filter(request => request.method === 'PATCH');
  assert.deepEqual(patches.map(request => request.path), ['/api/v1/users/me/avatar', '/api/v1/users/me']);
  assert.ok(patches[0].body instanceof FormData); assert.equal(patches[0].headers.has('Content-Type'), false);
  assert.equal(patches[0].headers.get('Authorization'), 'Bearer access'); assert.equal(patches[0].body.get('file').type, 'image/png');
  assert.equal(p.get('profile-save').disabled, true); assert.equal(p.revoked.length, 2);
});

test('cancelled cropping restores focus/background and a partial save reports that the avatar is already saved', async () => {
  const p = await page({saveFailure: true}); await p.avatar(); await p.click('avatar-crop-cancel');
  assert.equal(p.get('profile-save').disabled, true); assert.equal(p.get('profile-main').inert, false);
  await p.avatar(); await p.click('avatar-crop-use'); await p.change('profile-username', '保留待保存名称'); await p.submit();
  assert.match(p.get('profile-notice').textContent, /头像已保存，其他更改未保存/);
  assert.equal(p.get('profile-username').value, '保留待保存名称'); assert.equal(p.get('avatar-reset').hidden, true);
  assert.equal(p.get('profile-save').disabled, false);
  const event = {preventDefault() {this.prevented = true;}}; p.events.beforeunload(event); assert.equal(event.prevented, true);
});

test('profile validation follows backend byte limits and crop bounds never expose empty image edges', () => {
  assert.throws(() => profilePatch(account, {username: ' ', password: '', confirmation: ''}), /名称/);
  assert.throws(() => profilePatch(account, {username: '正常', password: '短密', confirmation: '短密'}), /UTF-8/);
  assert.throws(() => profilePatch(account, {username: '正常', password: '密'.repeat(25), confirmation: '密'.repeat(25)}), /UTF-8/);
  assert.throws(() => validateAvatar({type: 'image/svg+xml', size: 20}), /仅支持/);
  assert.throws(() => validateAvatar({type: 'image/png', size: 5 * 1024 * 1024 + 1}), /5 MB/);
  assert.deepEqual(cropRect(800, 600, 1, 0, 0), {x: 100, y: 0, size: 600});
  assert.deepEqual(cropRect(800, 600, 2, 9999, -9999), {x: 500, y: 0, size: 300});
  assert.deepEqual(cropRect(600, 800, 4, -9999, 9999), {x: 0, y: 650, size: 150});
});

test('confirming a dirty back navigation permits leaving without a second unload prompt', async () => {
  const blocked = await page(); await blocked.change('profile-username', '尚未保存');
  assert.equal(blocked.back.fire('click').defaultPrevented, true);
  const allowed = await page({confirmLeave: true}); await allowed.change('profile-username', '尚未保存');
  assert.equal(allowed.back.fire('click').defaultPrevented, false);
  const event = {preventDefault() {this.prevented = true;}}; allowed.events.beforeunload(event); assert.equal(event.prevented, undefined);
});

test('avatar wheel zoom anchors the pointer, clamps crop bounds and does not scroll the page', async () => {
  const p = await page(); await p.avatar();
  const canvas = p.get('avatar-crop-canvas');
  const wheel = fields => canvas.fire('wheel', {deltaY: -120, deltaMode: 0, clientX: 180, clientY: 180, ...fields});
  const initial = p.draws.at(-1)[3];
  assert.equal(wheel().defaultPrevented, true); assert.ok(p.draws.at(-1)[3] < initial);
  const before = p.draws.at(-1); wheel({ctrlKey: true}); assert.equal(p.draws.at(-1), before);
  // At 4x, every wheel unit mode stays within image bounds; at 1x it returns to the full square.
  for (let i = 0; i < 20; i++) wheel({deltaMode: i % 3, clientX: 90, clientY: 90});
  const [, x, y, size] = p.draws.at(-1); assert.equal(size, 150); assert.ok(x >= 0 && x + size <= 800 && y >= 0 && y + size <= 600);
  for (let i = 0; i < 20; i++) wheel({deltaY: 120});
  assert.equal(p.draws.at(-1)[3], initial);
  canvas.fire('keydown', {key: '+'}); assert.ok(p.draws.at(-1)[3] < initial);
  canvas.fire('keydown', {key: '0'}); assert.equal(p.draws.at(-1)[3], initial);
  await p.click('avatar-crop-cancel'); const count = p.draws.length; assert.equal(wheel().defaultPrevented, false); assert.equal(p.draws.length, count);
});
