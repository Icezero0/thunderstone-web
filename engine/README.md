# Shared TypeScript game engine

This package executes classic setup, formal turn commands, reviewed card effects,
disease gains, hall and scenario transitions, combat, economy, and scoring. It has
no Python, Node, browser, HTTP or database dependency. Every operation receives
plain JSON and returns a new result; no match is retained inside the package.

## Build and test

From the repository root with Node.js 22.12+:

```powershell
npm ci
npm run build
npm run typecheck
npm test
.\.venv\Scripts\python.exe -X utf8 -m unittest discover -s backend/tests -t .
```

`dist/index.js` is the server ESM entry. `dist/browser/engine.js` is built from
the same sources and served at `/engine/engine.js`. Generated files and
`node_modules/` are ignored by Git. Rebuild after changing TypeScript sources.

## Formal commands and authority

`applyCommand(state, command, catalog, ruleset)` validates the active or chosen
player, expected version, catalog and effect revisions, and state invariants. It
returns `{state, events, legal_commands}` without changing the input. A pending
choice stores a serializable continuation. `legalCommands` reads state without
advancing it. `takeDisease` uses the same transaction and replacement workflow.

The backend owns and persists the full match state, orders commands, and sends
player-specific views. Python entry points in `backend/app/integrations/game_engine/` load catalog and
reviewed effect snapshots and call the stateless JSON-lines worker. Archived
Python rules in `backend/tests/migration/reference/python_engine/` support parity tests;
they are outside the production path.

## Browser calculations

The browser uses read-only exports such as `previewBattle`, `combatValues`,
`monsterHealth`, `EffectEvaluation`, and catalog filters. These calculations
consume no RNG and do not advance game state. `ENGINE_VERSION` fingerprints the
TypeScript sources; previews reject a version mismatch. `BattleDraft` provides
local hero, equipment, support and target selections. `updateBattleDraft` and
`previewBattleTeam` run on each click; the backend validates `SubmitBattleTeam`
before combat. See [the frontend/backend API](../docs/game-engine/battle-team-api.md).

The server must never send a full `GameState` or private evaluation snapshot to
the browser. It projects only visible card definitions, public halls and the
active player's relevant hand/context.

## Semantics and verification

The reviewed JSON artifacts under `cards/effects/` bind 467 abilities and 206
continuous mechanics. The migration parity runner compares complete states,
events, choices and legal commands against the archived Python implementation
for 1,412 card contract tests. The ordinary Python-facing suite exercises the
TypeScript production entry point. Node tests also compare server and browser
builds for deterministic setup, RNG, DSL evaluation and calculations.

See [the migration record](../docs/game-engine/typescript-migration.md) and
[the DSL description](../docs/game-engine/typescript-dsl.md).
