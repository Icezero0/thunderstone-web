# Network backend

The backend follows the infrastructure, API and domain layering of [iCinema's backend](https://github.com/Icezero0/iCinema/tree/main/backend). It owns accounts, SQLite persistence and HTTP transport. The independent [TypeScript game engine](../engine/README.md) owns card rules and state transitions; the [Python adapter](app/integrations/game_engine/README.md) loads data and calls it through the Node worker.

```text
backend/
  run_backend.py / .bat / .sh   user-run development launchers
  alembic/                     database migrations
  app/
    main.py                    application composition
    core/                      settings, database, passwords, JWTs, errors
    db/                        SQLAlchemy base
    integrations/game_engine/  Python adapters to the shared engine
    realtime/                  authenticated WebSocket connections
    modules/                   users, auth, cards, rooms, matches
    api/                       public API, payload parsing and frontend hosting
      v1/                      auth, users, rooms, matches and rule configuration
  engine-worker/               JSON-lines transport to ../engine/
  devtools/
    api/                       isolated setup/battle/effect-lab test transports
    effect_lab/                effect trace service and advanced cases
  scripts/catalog/             catalog indexing and SQLite import
  scripts/effects/             reviewed effect builders and coverage audits
  scripts/sandbox/             offline setup and command replay
  tests/                       Python integration and migration tests
```

Routes parse requests and call `modules/<domain>/service.py`; services coordinate repositories and the shared engine. Database access belongs in repositories. The application composition root (`app/main.py`) mounts only formal application routes. It does not import or mount `devtools`. Sandbox transports remain available only through `tests/support/sandbox_app.py` for in-process regression tests; the deployed application returns 404 for them.

The public Python rules boundary is `app/integrations/game_engine/api.py`; callers do not need worker serialization details. See [test groups](tests/README.md) and [maintenance commands](scripts/README.md). Runtime data stays in the root `data/`, and catalog inputs in `cards/`.

Registration, login, refresh, `/users/me`, and the WebSocket authentication handshake are adapted from iCinema's independent account and connection flow. Media, site roles and video rooms are specific to iCinema, so they are not part of this backend. Room writes publish public invalidations; persisted match changes notify the participating users. Formal match APIs return a participant projection. The separate preview endpoints return full private sandbox results for local development.

The [waiting-room increment](../docs/multiplayer-lobby.md) adds persistent rooms,
player lists, host-owned configuration and readiness under `/api/v1/rooms`. The
TypeScript page at `/play` uses authenticated HTTP and WebSocket invalidations.
There is no seat model. The [match lifecycle](../docs/match-lifecycle.md)
freezes ready players and configuration, saves the setup in SQLite, supports
Flying Spire allocation and provides `/match?id=...` with participant views.
Refreshes and process restarts recover saved state. A host can cancel the match
to return the same players to a waiting room. Authenticated `/matches/{id}/commands`
executes turn actions and effect choices with version checks and idempotent receipts.
Natural settlement saves the scores and releases the room for the next game.

`core/config.py` accepts `THUNDERSTONE_` prefixed environment variables. `THUNDERSTONE_DATABASE_URL` defaults to SQLite at `data/thunderstone.db`; Alembic migrations run during application startup. A development JWT key is stored at `data/jwt_secret` unless `THUNDERSTONE_JWT_SECRET_KEY` is set. Non-development environments require that variable. Local runtime files and backups under `data/` are ignored by Git. The checked-in `cards/cards.csv` and `cards/setup_catalog.json` are import inputs; the setup API reads the imported SQLite catalog. See the [catalog database design](../docs/card-catalog-database-design.md).

From the repository root, install into the existing venv and start the service yourself. The `.bat` and `.sh` wrappers in this directory locate the root `.venv` and work from any current directory. They default to port 8765 with reload; pass `--host`, `--port` or `--no-reload` as needed:

```powershell
uv pip install --python .\.venv\Scripts\python.exe -r backend\requirements.txt
npm ci
npm run build
.\.venv\Scripts\python.exe backend\scripts\catalog\import_cards_to_sqlite.py
.\backend\run_backend.bat
```

`requirements.txt` includes `uvicorn[standard]` so the server can accept WebSocket
upgrades. After updating dependencies in an existing `.venv`, restart the backend;
the running process does not reload newly installed protocol libraries. The launcher
reports missing WebSocket support before starting the service.

The frontend development server is at `http://127.0.0.1:5173/`; start it with `frontend/run_frontend.bat` or `.sh`. The backend also hosts the built formal pages at `/login`, `/register`, `/play`, `/config`, `/match` and `/profile`. Authentication endpoints remain under `/api/v1/auth/`; `/api/v1/users/me` returns the current account. `/ws` accepts an initial JSON message `{"type":"auth","payload":{"token":"<access token>"}}`, then supports `{"type":"heartbeat"}`. Room configuration uses `/api/v1/options` and `/api/v1/validate`. Setup, battle sandboxes, effect-lab endpoints, legacy `/api/...` aliases, Swagger, ReDoc and OpenAPI JSON are not exposed. `/health` reports process availability. Install `backend/requirements-dev.txt` and run `.\.venv\Scripts\python.exe -m unittest discover -s backend/tests -t .` for backend tests.

## Room visibility

Room creation accepts `is_public` (strict boolean, default `true`). The public lobby
lists only public waiting rooms. Private rooms are joined using their shared room
code and remain recoverable via `/rooms/current`; no room password is required.
Room responses expose `is_public`. Private room invalidations use an empty payload,
including start/cancel/settlement, so the code is not broadcast to other users.
Migration `0007_room_visibility` adds the field with existing rooms kept public.

## Personal settings

The page at `/profile` follows iCinema's self-service profile flow. `PATCH /api/v1/users/me`
updates `username` and optionally `password`; additional fields, including `email`,
are rejected. A password change increments the account token version and revokes
existing access and refresh tokens. No email editing endpoint is provided.

`PATCH /api/v1/users/me/avatar` accepts an authenticated multipart `file` and returns
the updated account with `avatar_url`. PNG, JPEG and WebP files are limited to 5 MB
and 16 million pixels, decoded and normalized to a 512×512 PNG. Files are stored
under `data/avatars/` (`THUNDERSTONE_AVATAR_DIR` overrides the directory); only a
generated key is stored in `users.avatar_key`. Failed database writes remove the
new file; a successful replacement removes the previous file. Public avatar URLs
use `/api/v1/users/avatars/{key}` and therefore use the existing frontend API proxy.
Install the updated requirements in the root venv; migration `0006_user_avatars`
runs on the next backend start and preserves existing accounts and game data.

Name/avatar writes publish a public `profile_changed` invalidation. Room and match
views load current public names and avatar URLs; frozen match membership, rules,
readiness, command versions and game state remain independent of personal settings.
Account emails, password hashes and local file paths are not included in player views.

`GET /api/v1/cards/{card_id}` returns the imported card's public description and
printed values. `/cards/TS-BACK-001.jpg` serves the common card back alongside
the numbered face images. Neither endpoint returns match state or local asset paths.

`api/resources.py` serves the built `/rulebooks/TS4_rules_CN.pdf` and root
`/asset-cache-sw.js` as well. Public files use `Cache-Control: public, no-cache`,
ETag and Last-Modified validators: unchanged requests return an empty 304;
PDF range requests and HEAD remain supported. The browser's media-only service
worker persists previously viewed card images and the rulebook, without caching
account or match APIs. See [browser cache behavior](../frontend/README.md#卡图与规则书缓存).
Build the frontend before serving it directly from the backend. Vite serves the
worker and PDF from `frontend/public/` in development.

The [battle team API](../docs/game-engine/battle-team-api.md) adds visible preparation
and formal submission adapters. The former `/api/v1/battle/context` and `/api/v1/battle/submit`
sandbox endpoints are no longer mounted. The match module supplies its persisted server
state directly to the adapter, exposes visible preview inputs only to the actor,
and accepts an editable team selection through the authenticated command route.

The import command applies migrations and is safe to repeat when the source hash is unchanged. After changing card definitions, rebuild `cards/setup_catalog.json` and rerun the import with `--replace`. The runtime database is local and ignored by Git.

The [shared TypeScript engine](../docs/game-engine/typescript-migration.md) handles
setup, formal turn commands, card effects, disease gains and calculations through
`engine-worker/worker.mjs`. Node.js 22.12+ is required. Python starts the stateless
worker lazily, reuses it and closes it on shutdown; it opens no HTTP port. Build
after TypeScript changes. `/engine/engine.js` serves the same rule package to the
browser for local previews. The backend remains responsible for authentication,
catalog persistence, room membership and authoritative match snapshots.

`GET /api/v1/users/me` includes the boolean `auto_sort_hand` preference (default
false). `PATCH /api/v1/users/me` accepts that field independently of name/password
changes; it neither advances a match nor broadcasts a public profile change.
Migration `0008_hand_sort_preference` adds the non-null column for existing
accounts and runs through the normal startup migration process.

Migration `0009_match_history` adds complete operation checkpoints and a history cursor.
It runs on the next normal backend startup; no new dependency is required.
`POST /api/v1/matches/{id}/history/restore` takes `expected_version`, `command_id`
and optional `target_step`. Omitting the target undoes one accepted operation for any
participant; selecting a checkpoint is restricted to the host. Snapshots include
RNG state, pending effects and setup choices and remain private in SQLite. Public
responses contain operation metadata and the normal viewer-specific board projection.
REST/WebSocket versions always increase, even when the history cursor moves backwards.
Existing matches begin recording at their next accepted operation, with the preceding
state saved as a baseline; earlier unrecorded states cannot be reconstructed.

`GET /api/v1/matches/{id}/export` explicitly downloads a complete current checkpoint
for an authenticated match participant. It includes frozen players/catalogue, rule
revisions, setup, all engine state and events in `thunderstone-match` format version 1.
This read-only, uncached endpoint remains available without invoking the engine.
Normal views/realtime messages still use visibility projections. File import is not
implemented yet; restoration will need rule compatibility and identity validation.
