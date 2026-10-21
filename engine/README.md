# Game engine

`engine` owns the deterministic game rules. It has no FastAPI, SQLAlchemy, account, room, or WebSocket dependency. A caller supplies a frozen rules configuration, ordered player IDs, match ID and random seed. The engine returns initial state and events; the network backend decides how to authenticate callers, store matches and send results.

```text
engine/
├── catalog/     CSV and setup-index loading; panel projection
├── rules/       classic configuration schema, environment rules, validation
├── setup/       request service, seeded builder, state invariants
├── turn/        basic command transitions, village, rest and dungeon flow
├── effects/     typed JSON compiler, interpreter, continuous rules and hooks
├── disease/     disease supply transition
└── scoring.py   deterministic standard end-game score calculation
```

The public entry points are `engine.setup.start_game`, `engine.turn.apply_command`, `engine.turn.legal_commands`, `engine.disease.take_disease` and `engine.input_config` for existing callers. Internal modules can be imported directly when a narrower dependency is useful. Command-line callers can load `data/cards.csv` and `data/setup_catalog.json` directly. The backend instead loads a matching catalog snapshot from SQLite and passes it to the engine; this keeps database access outside the rules module.

## Basic turn commands

`apply_command(state, command, snapshot=...)` returns a new `state`, private ordered `events`, and `legal_commands`. It does not mutate its input. The caller supplies `player_id`, `type`, and optionally `expected_version` for stale-command rejection. Each accepted command increments `game_version` once. The engine verifies the catalog revision and state invariants before and after the transition.

| Current stage | Accepted commands |
| --- | --- |
| `TURN_START` | `ChooseAction` with `action: village`, `dungeon`, or `rest` |
| `VILLAGE_ABILITIES` | `ActivateAbility` with `source_instance_id` and `ability_id`; `FinishAbilities` |
| `VILLAGE_BUY` | `BuyCard` with `card_id`; `FinishBuying` |
| `VILLAGE_UPGRADE` | `UpgradeHero` with `source_instance_id` and `target_card_id`; `FinishUpgrading` |
| `REST` | `RestDestroy` with `instance_id`; `FinishRest` |
| `DUNGEON_PREPARE` | `ActivateAbility`; `EquipWeapon` with hero and weapon instance IDs; `DeclareBattleTarget` with `target_instance_id` |
| Pending card choice | `ResolveChoice` with `instance_id` from the current candidates |
| Pending simultaneous triggers | `ResolveEffectOrder` with each offered effect ID once |
| Pending effect purchase | `ResolveEffectPurchase` with an offered `card_id`, or `null` to skip |
| Pending value/player/dungeon | `ResolveValueChoice` with an offered `value` |
| Pending reorder | `ResolveCardOrder` with the complete `instance_ids` permutation |
| Pending effect upgrade | `ResolveEffectUpgrade` with `source_instance_id` and `target_card_id`, or both `null` |
| Pending disease replacement | `ResolveDiseaseReplacement` with a source or recipient, as indicated by its stage |
| Pending response | `ResolveResponse` with `source_instance_id`, then `recipient_id` if redirecting; omit both to decline a source-stage offer |
| Pending spell reuse | `ResolveReusedAbility` with an offered `ability_id` |

The turn transition emits start, action and end timing events even when no card ability is registered. Village gold comes from printed card values; one purchase is available by default. Basic cards have infinite supply. A militia can upgrade to an available level 1 hero; other heroes upgrade within their selected series, paying the XP cost printed on the source hero. Rest destroys at most one card, returning a disease instance to its infinite supply. Cleanup discards the remaining hand, draws six, shuffles the discard pile only when needed, and passes the turn in seat order. A dungeon action resolves printed attack, magic attack, light, weapon weight, monster health and reward XP, then refills the hall. A thunderstone reaching rank 1 enters `SETTLING` before cleanup.

The [reviewed JSON rulesets](../data/effects/) contain 446 executable abilities and 222 continuous mechanic bindings. All 520 effect cards have complete line coverage and per-card behavior tests. Hall refill and turn timings use serializable workflow steps: a trap can interrupt an ability, request a player's choice, and resume the original ability. Source zones distinguish hand trophies, battle targets, hall globals, settings, attachments and controlled treasures. Reviewed rules include responses, replacements, borrowing/copying, disease attachments, extra turns, reserves, supply replenishment, dynamic scoring, Flying Spire and Banishing Ritual. See the [runtime implementation](../docs/game-engine/ability-runtime-implementation.md) for contracts and confirmed rulings. Cooperative/solo variants and the multiplayer transport layer remain separate work.

For a local JSON replay, save the `state` from `scripts/run_setup.py` and a list of command objects, then run:

```powershell
.\.venv\Scripts\python.exe scripts\run_turns.py --state setup-result.json --commands commands.json --output turn-result.json
```

For example, `commands.json` can contain `[ {"type":"ChooseAction","player_id":"alice","action":"rest"}, {"type":"FinishRest","player_id":"alice"} ]` when Alice is the active player. `legal_commands(state)` describes the currently accepted types and candidate cards; the caller still checks the active player before presenting them.
