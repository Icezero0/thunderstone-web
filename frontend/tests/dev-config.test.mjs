import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import configFactory from '../vite.config.mjs';
import {rewritePageUrl} from '../dev-routes.mjs';

test('page aliases preserve room query parameters and leave data endpoints unchanged', () => {
  assert.equal(rewritePageUrl('/play'), '/index.html');
  assert.equal(rewritePageUrl('/config?room=abc'), '/config.html?room=abc');
  assert.equal(rewritePageUrl('/monster-audit/'), '/monster-audit.html');
  assert.equal(rewritePageUrl('/effect-lab'), '/effect-lab.html');
  for (const url of ['/monster-audit/data', '/effect-lab/cases/example/run?choice_index=1', '/api/v1/rooms']) {
    assert.equal(rewritePageUrl(url), url);
  }
});

test('frontend proxies API, images, tools and WebSocket without exposing the backend filesystem', () => {
  const config = configFactory({mode: 'development'});
  for (const prefix of ['/api/', '/cards/', '/engine/', '/monster-audit/data', '/effect-lab/cases', '/effect-lab/coverage']) {
    assert.ok(config.server.proxy[prefix]?.target, prefix);
  }
  assert.equal(config.server.proxy['/ws'].ws, true);
  assert.equal(config.server.port, 5173);
  assert.equal(config.server.strictPort, true);
  assert.equal(config.server.fs.allow.includes(resolve(config.root, '..')), false);
  const rewrites = [];
  const server = {middlewares: {use(handler) {
    const request = {url: '/config?room=abc'};
    handler(request, {}, () => rewrites.push(request.url));
  }}};
  config.plugins[0].configureServer(server);
  config.plugins[0].configurePreviewServer(server);
  assert.deepEqual(rewrites, ['/config.html?room=abc', '/config.html?room=abc']);
});
