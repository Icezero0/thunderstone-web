import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {defineConfig, loadEnv} from 'vite';
import {pageFiles, rewritePageUrl} from './dev-routes.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const project = resolve(root, '..');

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, root, 'VITE_');
  const apiOrigin = env.VITE_API_ORIGIN || 'http://127.0.0.1:8765';
  const proxy = Object.fromEntries([
    '/api/', '/cards/', '/engine/', '/health', '/effect-lab/cases',
    '/effect-lab/coverage', '/monster-audit/data',
  ].map(prefix => [prefix, {target: apiOrigin, changeOrigin: true}]));
  proxy['/ws'] = {target: apiOrigin, changeOrigin: true, ws: true};
  const pages = () => ({
    name: 'thunderstone-page-routes',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        request.url = rewritePageUrl(request.url);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        request.url = rewritePageUrl(request.url);
        next();
      });
    },
  });
  return {
    root, appType: 'mpa', plugins: [pages()],
    server: {host: true, port: 5173, strictPort: true, proxy,
      fs: {allow: [root, resolve(project, 'engine'), resolve(project, 'node_modules')]}},
    preview: {host: true, port: 5173, strictPort: true, proxy},
    optimizeDeps: {exclude: ['@thunderstone/engine']},
    build: {target: 'es2022', rollupOptions: {
      input: [...new Set(Object.values(pageFiles))].map(name => resolve(root, name)),
    }},
  };
});
