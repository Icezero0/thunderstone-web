import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/api.ts', 'src/room-view.ts', 'src/realtime.ts'],
  outdir: '.test-dist', bundle: true, splitting: true, format: 'esm',
  platform: 'browser', target: 'es2022', logLevel: 'warning',
});
