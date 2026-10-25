import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: {
    api: 'src/shared/api/client.ts',
    'hand-sort-preference': 'src/app/hand-sort-preference.ts',
    'room-view': 'src/pages/lobby/room-view.ts',
    realtime: 'src/shared/realtime/room-connection.ts',
    'match-model': 'src/pages/match/model.ts',
    'match-deck-transitions': 'src/pages/match/deck-transitions.ts',
    'animation-schedule': 'src/pages/match/animation-schedule.ts',
    'match-player-activity': 'src/pages/match/player-activity.ts',
    navigation: 'src/app/navigation.ts',
    'probe-hand-layout': 'src/shared/components/player-deck-area/hand-layout.ts',
    'probe-face-flip': 'src/shared/components/game-card/face-flip.ts',
    'player-deck-model': 'src/shared/components/player-deck-area/model.ts',
    'probe-demo-state': 'src/pages/game-probe/demo-state.ts',
    'probe-public-state': 'src/pages/game-probe/public-demo-state.ts',
    'table-area-model': 'src/shared/components/table-areas/model.ts',
    'profile-model': 'src/pages/profile/model.ts',
    'game-results-model': 'src/shared/components/game-results/model.ts',
  },
  outdir: '.test-dist', bundle: true, splitting: true, format: 'esm',
  platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/pages/profile/index.ts'], outfile: '.test-dist/profile-page.js',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/pages/lobby/index.ts'], outfile: '.test-dist/lobby-page.js',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

// Exercise the assembled configuration page in a DOM fixture, including its
// module wiring and event callbacks, without starting a development server.
await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/pages/config/index.js'], outfile: '.test-dist/config-page.js',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/pages/match/index.ts'], outfile: '.test-dist/match-page.js',
  loader: {'.png': 'dataurl'},
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/pages/game-probe/index.ts'], outfile: '.test-dist/game-probe.js',
  loader: {'.png': 'dataurl'},
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/shared/components/player-deck-area/index.ts'], outfile: '.test-dist/player-deck-component.js',
  loader: {'.png': 'dataurl'}, globalName: 'PlayerDeckPackage',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/shared/components/public-table-area/index.ts'], outfile: '.test-dist/public-table-component.js',
  loader: {'.png': 'dataurl'}, globalName: 'PublicTablePackage',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/shared/components/player-list/index.ts'], outfile: '.test-dist/player-list-component.js',
  loader: {'.png': 'dataurl'}, globalName: 'PlayerListPackage',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

// Both entries share one module graph so cross-region inspection arbitration is exercised.
await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  stdin: {contents: "export * from './src/shared/components/game-card/index.ts'; export * from './src/shared/components/player-deck-area/index.ts'; export * from './src/shared/components/table-areas/index.ts';", resolveDir: fileURLToPath(new URL('../', import.meta.url))},
  outfile: '.test-dist/game-card-component.js', loader: {'.png': 'dataurl'}, globalName: 'GameCardPackage',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/shared/components/table-viewport/index.ts'], outfile: '.test-dist/table-viewport.js',
  globalName: 'ViewportPackage', bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});

await build({
  absWorkingDir: fileURLToPath(new URL('../', import.meta.url)),
  entryPoints: ['src/shared/components/player-deck-area/card-dissolve.ts'], outfile: '.test-dist/card-dissolve.js',
  globalName: 'CardDissolvePackage', bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning',
});
