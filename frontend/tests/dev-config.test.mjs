import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import configFactory from '../vite.config.mjs';
import {isPrivateResource, rewritePageUrl} from '../dev-routes.mjs';

test('page aliases preserve room query parameters and leave data endpoints unchanged', () => {
  assert.equal(rewritePageUrl('/play'), '/index.html');
  assert.equal(rewritePageUrl('/match?id=abc'), '/match.html?id=abc');
  assert.equal(rewritePageUrl('/config?room=abc'), '/config.html?room=abc');
  assert.equal(rewritePageUrl('/config/'), '/config.html');
  assert.equal(rewritePageUrl('/login?next=%2Fmatch'), '/auth.html?next=%2Fmatch');
  assert.equal(rewritePageUrl('/register/'), '/auth.html');
  assert.equal(rewritePageUrl('/profile'), '/profile.html');
  assert.equal(rewritePageUrl('/profile/'), '/profile.html');
  for (const url of ['/effect-lab/cases/example/run?choice_index=1', '/api/v1/rooms']) {
    assert.equal(rewritePageUrl(url), url);
  }
});

test('frontend proxies API, images, tools and WebSocket without exposing the backend filesystem', () => {
  const config = configFactory({mode: 'development'});
  for (const prefix of ['/api/', '/cards/', '/engine/']) {
    assert.ok(config.server.proxy[prefix]?.target, prefix);
  }
  assert.equal(config.server.proxy['/ws'].ws, true);
  assert.equal(config.server.port, 5173);
  assert.equal(config.server.strictPort, true);
  assert.equal(config.server.fs.allow.includes(resolve(config.root, '..')), false);
  assert.ok(config.build.rollupOptions.input.some(path => path.endsWith('match.html')));
  assert.ok(config.build.rollupOptions.input.some(path => path.endsWith('auth.html')));
  assert.ok(config.build.rollupOptions.input.every(path => !/game-probe|effect-lab/.test(path)));
  assert.equal(config.server.proxy['/effect-lab/cases'], undefined);
  assert.ok(config.build.rollupOptions.input.some(path => path.endsWith('profile.html')));
  const rewrites = [];
  const server = {middlewares: {use(handler) {
    const request = {url: '/config?room=abc'};
    handler(request, {}, () => rewrites.push(request.url));
  }}};
  config.plugins[0].configureServer(server);
  config.plugins[0].configurePreviewServer(server);
  assert.deepEqual(rewrites, ['/config.html?room=abc', '/config.html?room=abc']);
});

test('development and preview reject retired pages and test fixtures before file handling', () => {
  const config = configFactory({mode: 'development'});
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let handle;
    config.plugins[0][hook]({middlewares: {use(handler) {handle = handler;}}});
    for (const path of ['/game-probe', '/game-probe.html', '/effect-lab/', '/effect-lab/cases',
      '/src/pages/game-probe/index.ts', '/tests/fixtures/game-probe/page.html', '/.test-dist/game-probe.js',
      '/@fs/D:/project/thunderstone-web/frontend/tests/fixtures/game-probe/index.ts', '/%74ests/private.html']) {
      assert.equal(isPrivateResource(path), true, path);
      let ended = false, next = false;
      const response = {end() {ended = true;}};
      handle({url: path}, response, () => {next = true;});
      assert.equal(response.statusCode, 404, path); assert.equal(ended, true); assert.equal(next, false);
    }
  }
});
