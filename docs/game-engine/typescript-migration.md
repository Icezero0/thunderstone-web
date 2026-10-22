# TypeScript engine migration

## Runtime boundary

`packages/engine` is the single implementation of classic setup, turn commands,
card effects, disease gains, dungeon hall and scenario transitions, combat,
economy, and scoring. Its inputs and outputs are plain JSON. A command clones
its input state, validates the actor and version, runs one deterministic
transaction, then returns the new state, ordered private events, and legal next
commands. The package holds no match between calls.

The server owns the full `GameState`, persists its version, orders formal commands,
and publishes player-specific views. Python loads card definitions from CSV or
SQLite, loads the reviewed effect artifacts, and sends the frozen snapshot to the
Node worker. The thin Python adapters live in `backend/app/integrations/game_engine/`;
the former repository-root `engine/` package has been removed. The worker opens no network port. The old Python rules
are archived under `tests/migration/reference/python_engine` for regression
comparison and are not used by the production command path.

The browser imports the same TypeScript build for read-only calculations.
`BattleDraft` remains local until the player submits `SubmitBattleTeam`; the
server state remains authoritative. Room storage, authentication and WebSocket
routing belong to the backend, not this rules package.

## Package layout

```text
packages/engine/src/
  catalog/       card identity, numeric fields and filters
  setup/         configuration, seeded setup and initial state
  random/        portable SHA-256 counter stream
  battle/        combat, equipment and read-only preview
  effects/       DSL compilation, evaluation, atoms, responses and choices
  turn/          command transaction, workflow, hall, village and dungeon
  scoring/       final score
backend/engine-worker/worker.mjs    JSON-lines adapter
backend/app/integrations/game_engine/ Python data, transport and API adapters
tests/migration/reference/          frozen Python implementation and formulas
```

`npm ci` installs locked dependencies; `npm run build` emits the Node ESM package
and `/engine/engine.js` browser bundle. Build outputs embed a normalized source
SHA-256 `ENGINE_VERSION`; Python reloads the worker after a changed build. The
worker uses one transport lock and correlation IDs and closes on application
shutdown. A missing build or timeout raises an explicit error.

## Verification

The migration parity runner compares every command's complete state, event log,
legal commands, and pending continuation against the archived Python executor.
It ran 1,412 reviewed card contract tests and the integration suites. The public
Python entry points also run against the TypeScript worker in the ordinary test
suite. Node tests exercise the server module and browser bundle, deterministic
setup and RNG, DSL validation, and read-only previews.

The parity gate preserves reviewed historical behavior for legacy commands,
ignoring only the additive `SubmitBattleTeam` entry in advertised legal commands.
[Battle-team selection](battle-team-api.md) has independent browser/server and HTTP
tests. Passing parity does not independently settle disputed printed card text
or symbol interpretation.
