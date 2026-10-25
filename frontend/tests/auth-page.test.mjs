import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {page, settle} from './support/player-deck-dom.mjs';
import {loginReturnPath} from '../.test-dist/navigation.js';

const html = await readFile(new URL('../auth.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../.test-dist/auth-page.js', import.meta.url), 'utf8');
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const tokens = {access_token: 'access', refresh_token: 'refresh'};
async function auth({path = '/login', search = '', session = null, failure = false} = {}) {
  const navigations = [], requests = [];
  const ui = await page({html, source, session, globals: {URL, URLSearchParams,
    location: {pathname: path, search, replace: url => navigations.push(url)}},
    fetchResponse: async (url, options) => {
      requests.push({url, body: options.body && JSON.parse(options.body)});
      if (failure && url.endsWith('/auth/login')) return json({error: {message: 'Bad login'}}, 401);
      if (url.endsWith('/auth/register')) return json({id: 1});
      if (url.endsWith('/auth/login')) return json(tokens);
      if (url.endsWith('/users/me')) return json({id: 1, username: 'Alice', email: 'alice@example.com'});
      throw new Error(`Unexpected request ${url}`);
    }});
  return {...ui, navigations, requests, async submit() {
    ui.get('email').value = ' alice@example.com '; ui.get('password').value = 'secret-password';
    ui.get('username').value = ' Alice '; ui.get('auth-form').fire('submit'); await settle();
  }};
}

test('login contains only its account form and returns to the requested match', async () => {
  const ui = await auth({search: '?next=%2Fmatch%3Fid%3Dmatch-1'});
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.get('username-field').hidden, true);
  assert.doesNotMatch(html, /冒险者工会|尚未登录|村庄之外|auth-view|lobby-view|masthead/);
  await ui.submit();
  assert.deepEqual(ui.requests.map(r => r.url), ['/api/v1/auth/login', '/api/v1/users/me']);
  assert.equal(ui.requests[0].body.email, 'alice@example.com');
  assert.deepEqual(ui.navigations, ['/match?id=match-1']);
  assert.equal(ui.get('password').value, '');
});

test('registration keeps its separate route, registers and logs in without loading the lobby', async () => {
  const ui = await auth({path: '/register'});
  assert.equal(ui.get('username-field').hidden, false);
  assert.equal(ui.get('password').autocomplete, 'new-password');
  assert.equal(ui.get('auth-mode').href, '/login?next=%2Fplay');
  await ui.submit();
  assert.deepEqual(ui.requests.map(r => r.url), ['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/users/me']);
  assert.equal(ui.requests[0].body.username, 'Alice');
  assert.deepEqual(ui.navigations, ['/play']);
});

test('existing sessions leave the auth page; invalid credentials keep the form usable', async () => {
  const existing = await auth({session: tokens, search: '?next=%2Fprofile'});
  assert.deepEqual(existing.navigations, ['/profile']);
  const rejected = await auth({failure: true}); await rejected.submit();
  assert.deepEqual(rejected.navigations, []);
  assert.match(rejected.get('notice').textContent, /邮箱或密码/);
  assert.equal(rejected.get('auth-submit').disabled, false);
});

test('login return paths allow formal pages only, never development pages or external redirects', async () => {
  const room = 'a'.repeat(32);
  assert.equal(loginReturnPath(`/config?room=${room}`), `/config?room=${room}`);
  assert.equal(loginReturnPath('/play?view=room'), '/play?view=room');
  for (const path of ['/game-probe', '/effect-lab', '/config', '/login', '//evil.test/match',
    'https://evil.test/match', '/\\evil.test/match', '/match?id=../bad']) assert.equal(loginReturnPath(path), null, path);
  const ui = await auth({search: '?next=https%3A%2F%2Fevil.test'}); await ui.submit();
  assert.deepEqual(ui.navigations, ['/play']);
});
