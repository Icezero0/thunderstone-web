import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';

const source = await readFile(new URL('../public/asset-cache-sw.js', import.meta.url), 'utf8');
const origin = 'https://game.test';
const card = '/cards/TS-0001.png', pdf = '/rulebooks/TS4_rules_CN.pdf';
const name = 'thunderstone-public-assets-v1';
const full = (text, {type = 'image/png', etag = '"v1"', status = 200} = {}) => new Response(text, {
  status, headers: {'Content-Type': type, ETag: etag, 'Cache-Control': 'public, no-cache'},
});

function worker(fetcher = () => full('picture'), {store = new Map(), unavailable = false, quota = false} = {}) {
  const listeners = {}, calls = [], deleted = [];
  let now = 1000, claimed = false;
  const cache = {
    async match(url) {return store.get(url)?.clone();},
    async put(url, response) {if (quota) throw new Error('QuotaExceededError'); store.set(url, response.clone());},
    async delete(url) {return store.delete(url);},
  };
  runInNewContext(source, {
    URL, Headers, Response, Map, Set, Promise,
    Date: class extends Date {static now() {return now;}},
    caches: {async open() {if (unavailable) throw new Error('SecurityError'); return cache;},
      async keys() {return ['another-app', 'thunderstone-public-assets-v0', name];}, async delete(key) {deleted.push(key);}},
    fetch: (input, options) => {calls.push({url: typeof input === 'string' ? input : input.url, options}); return fetcher(input, options);},
    self: {location: {origin}, addEventListener(type, callback) {listeners[type] = callback;},
      async skipWaiting() {}, clients: {async claim() {claimed = true;}}},
  });
  const dispatch = (type, data) => {
    let response; const work = [];
    listeners[type]({...data, respondWith(value) {response = value;}, waitUntil(value) {work.push(value);}});
    return {response, done: async () => {await Promise.all(work);}};
  };
  return {store, calls, deleted, claimed: () => claimed, advance() {now += 60_001;},
    get(path = card, options) {return dispatch('fetch', {request: new Request(new URL(path, origin), options)});},
    activate() {return dispatch('activate');}, warm(urls) {return dispatch('message', {data: {type: 'CACHE_LOADED_ASSETS', urls}});}};
}

test('downloads on demand, persists across worker restarts, and reuses unchanged content with a 304', async () => {
  const first = worker(); assert.equal(first.calls.length, 0);
  const initial = first.get(); assert.equal(await (await initial.response).text(), 'picture'); await initial.done();
  assert.equal(first.store.size, 1);
  const again = first.get(); await again.response; await again.done(); assert.equal(first.calls.length, 1);
  const reopened = worker((_url, options) => {
    assert.equal(options.headers.get('If-None-Match'), '"v1"');
    return new Response(null, {status: 304});
  }, {store: first.store});
  const cached = reopened.get(); assert.equal(await (await cached.response).text(), 'picture'); await cached.done();
  assert.equal(reopened.calls.length, 1); assert.equal(reopened.store.size, 1);
});

test('an image paints from cache while only a changed version is downloaded in the background', async () => {
  const store = new Map([[origin + card, full('old')]]); let resolve;
  const w = worker(() => new Promise(reply => {resolve = reply;}), {store});
  const request = w.get(); assert.equal(await (await request.response).text(), 'old');
  resolve(full('new', {etag: '"v2"'})); await request.done();
  const next = w.get(); assert.equal(await (await next.response).text(), 'new'); await next.done();
  assert.equal(w.calls.length, 1);
});

test('revalidation is throttled within a minute; explicit reload validates immediately', async () => {
  const w = worker(); const first = w.get(); await first.response; await first.done();
  const reloaded = w.get(card, {cache: 'reload'}); await reloaded.response; await reloaded.done();
  assert.equal(w.calls.length, 2);
  w.advance(); const later = w.get(); await later.response; await later.done(); assert.equal(w.calls.length, 3);
});

test('parallel card views share one download and get independent response bodies', async () => {
  let resolve; const w = worker(() => new Promise(reply => {resolve = reply;}));
  const a = w.get(), b = w.get(); await new Promise(setImmediate);
  assert.equal(w.calls.length, 1); resolve(full('shared'));
  assert.deepEqual(await Promise.all([a.response, b.response].map(async response => (await response).text())), ['shared', 'shared']);
  await Promise.all([a.done(), b.done()]);
});

test('PDF range requests cache the full document once, then slice locally', async () => {
  const w = worker((_url, options) => {
    assert.equal(options.headers.has('Range'), false);
    return full('0123456789', {type: 'application/pdf'});
  });
  for (const [range, expected, contentRange] of [['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10']]) {
    const request = w.get(pdf, {headers: {Range: range}}), response = await request.response;
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(await response.text(), expected); await request.done();
  }
  assert.equal(w.calls.length, 1);
  assert.equal(await w.store.get(origin + pdf).clone().text(), '0123456789');
  const invalid = w.get(pdf, {headers: {Range: 'bytes=20-'}});
  assert.equal((await invalid.response).status, 416); await invalid.done();
  const different = w.get(pdf, {headers: {Range: 'bytes=0-1', 'If-Range': '"older"'}});
  assert.equal((await different.response).status, 200); await different.done();
});

test('parallel PDF requests await the same version validation before serving byte ranges', async () => {
  const store = new Map([[origin + pdf, full('old content', {type: 'application/pdf'})]]); let resolve;
  const w = worker(() => new Promise(reply => {resolve = reply;}), {store});
  const first = w.get(pdf, {headers: {Range: 'bytes=0-2'}}); await new Promise(setImmediate);
  const second = w.get(pdf, {headers: {Range: 'bytes=3-5'}}); await new Promise(setImmediate);
  assert.equal(w.calls.length, 1); resolve(full('ABCDEF', {type: 'application/pdf', etag: '"v2"'}));
  assert.equal(await (await first.response).text(), 'ABC'); assert.equal(await (await second.response).text(), 'DEF');
  await first.done(); await second.done();
});

test('cached public media remains readable when offline', async () => {
  const store = new Map([[origin + card, full('offline')], [origin + pdf, full('document', {type: 'application/pdf'})]]);
  const w = worker(() => {throw new Error('offline');}, {store});
  for (const [path, text] of [[card, 'offline'], [pdf, 'document']]) {
    const request = w.get(path); assert.equal(await (await request.response).text(), text); await request.done();
  }
});

test('errors, partial files, HTML and private responses never enter the media cache', async () => {
  for (const response of [full('error', {status: 500}), full('missing', {status: 404}),
    full('partial', {status: 206}), full('page', {type: 'text/html'}),
    new Response('private', {headers: {'content-type': 'image/png', 'cache-control': 'private'}})]) {
    const w = worker(() => response), request = w.get(); await request.response; await request.done();
    assert.equal(w.store.size, 0);
  }
});

test('missing assets invalidate old copies instead of keeping them forever', async () => {
  const store = new Map([[origin + card, full('old')]]), w = worker(() => full('missing', {status: 404}), {store});
  const request = w.get(); await request.response; await request.done(); assert.equal(store.size, 0);
});

test('unsupported cache storage and quota exhaustion do not prevent ordinary viewing', async () => {
  for (const options of [{unavailable: true}, {quota: true}]) {
    const w = worker(() => full('available'), options), request = w.get();
    assert.equal(await (await request.response).text(), 'available'); await request.done(); assert.equal(w.store.size, 0);
  }
});

test('account data, match state, code, other origins and authorization are never intercepted', () => {
  const w = worker();
  for (const path of ['/api/v1/users/me', '/api/v1/matches/current', '/match?id=x', '/engine/engine.js',
    '/assets/app.js', '/rulebooks/private.pdf', '/cards/invalid.png', 'https://other.test/cards/TS-0001.png'])
    assert.equal(w.get(path).response, undefined, path);
  assert.equal(w.get(card, {headers: {Authorization: 'Bearer secret'}}).response, undefined);
  assert.equal(w.get(card, {method: 'POST'}).response, undefined);
  assert.equal(w.get(card, {method: 'HEAD'}).response, undefined); assert.equal(w.calls.length, 0);
});

test('first-install warmup only saves loaded allowlisted files; activation cleans only its own obsolete cache', async () => {
  const w = worker(); await w.warm([origin + card, origin + card, origin + '/api/v1/users/me']).done();
  assert.equal(w.calls.length, 1); assert.equal(w.store.size, 1);
  await w.activate().done(); assert.deepEqual(w.deleted, ['thunderstone-public-assets-v0']); assert.equal(w.claimed(), true);
});

const registration = (await transform(await readFile(new URL('../src/app/asset-cache.ts', import.meta.url), 'utf8'),
  {loader: 'ts', format: 'iife', target: 'es2022'})).code;

test('registration claims first-visit media once, without requesting storage permission', async () => {
  const messages = [], registrations = [], handlers = {}, active = {postMessage(value) {messages.push(value);}};
  const serviceWorker = {controller: null, ready: Promise.resolve({active}),
    addEventListener(type, callback) {handlers[type] = callback;},
    async register(...args) {registrations.push(args); return {active};}};
  runInNewContext(registration, {window: {isSecureContext: true}, navigator: {serviceWorker},
    document: {images: [{src: origin + card, currentSrc: ''}]},
    performance: {getEntriesByType() {return [{name: origin + card}];}}});
  await new Promise(setImmediate); serviceWorker.controller = active; handlers.controllerchange();
  assert.equal(registrations.length, 1); assert.equal(registrations[0][0], '/asset-cache-sw.js');
  assert.equal(registrations[0][1].scope, '/'); assert.equal(registrations[0][1].updateViaCache, 'none');
  assert.equal(messages.length, 1); assert.deepEqual([...messages[0].urls], [origin + card]);
});

test('insecure, unsupported and rejected registration do not block the page', async () => {
  let attempts = 0;
  const serviceWorker = {controller: {}, addEventListener() {}, async register() {attempts++; throw new Error('disabled');}};
  for (const [secure, navigator] of [[false, {serviceWorker}], [true, {}], [true, {serviceWorker}]])
    runInNewContext(registration, {window: {isSecureContext: secure}, navigator});
  await new Promise(setImmediate); assert.equal(attempts, 1);
});
