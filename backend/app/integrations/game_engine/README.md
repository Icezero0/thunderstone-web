# Game engine adapter

## TypeScript rules package

[engine](../../../../engine/README.md) executes classic setup, turn
commands, the effect DSL, hall and scenario transitions, disease gains, combat,
economy and scoring. Build it with `npm ci` and `npm run build`. This Python
package loads the catalog and reviewed JSON, then calls the stateless Node worker.
The server caller owns and persists authoritative match state. The browser uses
the same TypeScript source for read-only preview calculations. See the
[migration record](../../../../docs/game-engine/typescript-migration.md).

This integration supplies Python data loaders, compatibility types and JSON-lines transport. It submits frozen requests and receives complete results from the TypeScript package. Accounts, rooms, authentication and match persistence belong to the backend services that call it.

```text
backend/app/integrations/game_engine/
├── api.py       public Python entry points
├── catalog/     CSV and setup-index loading; panel projection
├── rules/       configuration compatibility calls and metadata
├── setup/       setup adapter
├── turn/        command adapter and domain error
├── effects/     reviewed JSON loader and compiler adapter
├── disease/     infinite supply adapter
├── shared/      worker transport and request serialization
├── battle.py    preparation and team submission adapter
└── scoring.py   scoring adapter
```

Backend routes and services import from `backend.app.integrations.game_engine.api`: `start_game`, `apply_command`, `legal_commands`, `take_disease`, `battle_preparation`, `submit_battle_team`, `score_game`, catalog loading and configuration validation. Domain subpackages implement those adapters; `shared/` is the internal worker protocol. The obsolete `input_config.py` and `paths.py` compatibility facades have been removed; common repository paths come from `backend.app.core.paths`.
The old Python interpreter is archived under
[`backend/tests/migration/reference/python_engine`](../../../../backend/tests/migration/reference/python_engine/)
for parity tests. The backend loads a matching catalog snapshot from SQLite and
passes it to the engine; database access stays outside the rules package.

`command_options(state, player_id, snapshot=...)` calls the worker's read-only
`turn_options` once to return legal commands and `gold_income_preview`, then adds
the existing ability labels and optional battle preparation. The shared engine
calculates the forecast using the same routine as gold production. The match
projection exposes only the active player's forecast, even while someone else
is the pending effect recipient. No preview request advances state or consumes
a gold adjustment.

## Basic turn commands

`apply_command(state, command, snapshot=...)` returns a new `state`, private ordered `events`, and `legal_commands`. It does not mutate its input. The caller supplies `player_id`, `type`, and optionally `expected_version` for stale-command rejection. Each accepted command increments `game_version` once. The engine verifies the catalog revision and state invariants before and after the transition.

| Current stage | Accepted commands |
| --- | --- |
| `TURN_START` | `ChooseAction` with `action: village`, `dungeon`, or `rest` |
| `VILLAGE_ABILITIES` | `ActivateAbility` with `source_instance_id` and `ability_id`; `FinishAbilities` |
| `VILLAGE_BUY` | `BuyCard` with `card_id`; `FinishBuying` |
| `VILLAGE_UPGRADE` | `UpgradeHero` with `source_instance_id` and `target_card_id`; `FinishUpgrading` |
| `REST` | `RestDestroy` with `instance_id`; `SkipRestDestroy`; either enters `ACTION_END` |
| `ACTION_END` | `FinishTurn`; shared explicit confirmation for village, dungeon and rest |
| `DUNGEON_PREPARE` | `ActivateAbility`; `EquipWeapon`; `UpdatePreparationEquipment` to flush local ordinary equipment; `SubmitBattleTeam` with a versioned draft (legacy `DeclareBattleTarget` remains accepted) |
| Pending card choice | `ResolveChoice` with `instance_id` from the current candidates |
| Pending simultaneous triggers | `ResolveEffectOrder` with each offered effect ID once |
| Pending effect purchase | `ResolveEffectPurchase` with an offered `card_id`, or `null` to skip |
| Pending value/player/dungeon | `ResolveValueChoice` with an offered `value` |
| Pending reorder | `ResolveCardOrder` with the complete `instance_ids` permutation |
| Pending effect upgrade | `ResolveEffectUpgrade` with `source_instance_id` and `target_card_id`, or both `null` |
| Pending disease replacement | `ResolveDiseaseReplacement` with a source or recipient, as indicated by its stage |
| Pending response | `ResolveResponse` with `source_instance_id`, then `recipient_id` if redirecting; omit both to decline a source-stage offer |
| Pending spell reuse | `ResolveReusedAbility` with an offered `ability_id` |

The turn transition emits start, action and end timing events even when no card ability is registered. Village gold comes from printed card values; one purchase is available by default. Basic cards have infinite supply. A militia can upgrade to an available level 1 hero; other heroes upgrade within their selected series, paying the XP cost printed on the source hero. Rest destroys at most one card, returning a disease instance to its infinite supply. Cleanup discards the remaining hand, draws six, shuffles the discard pile only when needed, and passes the turn in player order. A dungeon action resolves printed attack, magic attack, light, weapon weight, monster health and reward XP, then refills the hall. A thunderstone reaching rank 1 enters `SETTLING` before cleanup.

The [reviewed JSON rulesets](../../../../cards/effects/) contain 446 executable abilities and 227 continuous mechanic bindings. All 520 effect cards have complete line coverage and per-card behavior tests. Hall refill and turn timings use serializable workflow steps: a trap can interrupt an ability, request a player's choice, and resume the original ability. Source zones distinguish hand trophies, battle targets, hall globals, settings, attachments and controlled treasures. Reviewed rules include responses, replacements, borrowing/copying, disease attachments, extra turns, reserves, supply replenishment, dynamic scoring, Flying Spire and Banishing Ritual. See the [runtime implementation](../../../../docs/game-engine/ability-runtime-implementation.md) for contracts and confirmed rulings. Cooperative/solo variants and the multiplayer transport layer remain separate work.

For a local JSON replay, save the `state` from `backend/scripts/sandbox/run_setup.py` and a list of command objects, then run:

```powershell
.\.venv\Scripts\python.exe backend\scripts\sandbox\run_turns.py --state setup-result.json --commands commands.json --output turn-result.json
```

For example, `commands.json` can contain `[ {"type":"ChooseAction","player_id":"alice","action":"rest"}, {"type":"SkipRestDestroy","player_id":"alice"}, {"type":"FinishTurn","player_id":"alice"} ]` when Alice is the active player. `FinishUpgrading` and completed dungeon battles likewise stop at `ACTION_END`, retaining the hand until `FinishTurn`. `legal_commands(state)` describes the currently accepted types and candidate cards; the caller still checks the active player before presenting them.

`battle.battle_preparation` returns visible frontend inputs; `battle.submit_battle_team`
executes a formal team command. See [the battle team API](../../../../docs/game-engine/battle-team-api.md).
