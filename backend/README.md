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
    modules/                   users, auth, cards, rooms
    api/                       HTTP endpoints and built frontend hosting
  engine-worker/               JSON-lines transport to ../engine/
  devtools/                    effect lab and audit data projections
  scripts/                     offline maintenance tools
  tests/                       Python integration and migration tests
```

Registration, login, refresh, `/users/me`, and the WebSocket authentication handshake are adapted from iCinema's independent account and connection flow. Media, site roles and video rooms are specific to iCinema, so they are not part of this backend. Waiting-room writes publish public invalidations through the connection manager; match commands and player views are the next increment. The preview endpoints still return the full private setup result; they are for local use and must be replaced with player-scoped game endpoints before public multiplayer deployment.

The [waiting-room increment](../docs/multiplayer-lobby.md) adds persistent rooms,
player lists, host-owned configuration and readiness under `/api/v1/rooms`. The
TypeScript page at `/play` uses authenticated HTTP and WebSocket invalidations.
There is no seat model. This increment stops before starting a match; the next
increment will add authoritative match state, command storage and player views.

`core/config.py` accepts `THUNDERSTONE_` prefixed environment variables. `THUNDERSTONE_DATABASE_URL` defaults to SQLite at `data/thunderstone.db`; Alembic migrations run during application startup. A development JWT key is stored at `data/jwt_secret` unless `THUNDERSTONE_JWT_SECRET_KEY` is set. Non-development environments require that variable. Local runtime files and backups under `data/` are ignored by Git. The checked-in `cards/cards.csv` and `cards/setup_catalog.json` are import inputs; the setup API reads the imported SQLite catalog. See the [catalog database design](../docs/card-catalog-database-design.md).

From the repository root, install into the existing venv and start the service yourself. The `.bat` and `.sh` wrappers in this directory locate the root `.venv` and work from any current directory. They default to port 8765 with reload; pass `--host`, `--port` or `--no-reload` as needed:

```powershell
uv pip install --python .\.venv\Scripts\python.exe -r backend\requirements.txt
npm ci
npm run build
.\.venv\Scripts\python.exe backend\scripts\import_cards_to_sqlite.py
.\backend\run_backend.bat
```

`requirements.txt` includes `uvicorn[standard]` so the server can accept WebSocket
upgrades. After updating dependencies in an existing `.venv`, restart the backend;
the running process does not reload newly installed protocol libraries. The launcher
reports missing WebSocket support before starting the service.

The frontend development server is at `http://127.0.0.1:5173/`; start it with `frontend/run_frontend.bat` or `.sh`. The backend also hosts the built pages, including `/config` and the existing `/monster-audit` URL, at port 8765. Account routes are `/api/v1/auth/register`, `/login`, `/refresh` and `/api/v1/users/me`. `/ws` accepts an initial JSON message `{"type":"auth","payload":{"token":"<access token>"}}`, then supports `{"type":"heartbeat"}`. The panel uses `/api/v1/options`, `/validate` and `/setup`; the old `/api/...` preview paths remain as compatibility aliases. `/health` reports process availability. Install `backend/requirements-dev.txt` and run `.\.venv\Scripts\python.exe -m unittest discover -s backend/tests -t .` to test both layers.

The [battle team API](../docs/game-engine/battle-team-api.md) adds visible preparation
and formal submission adapters, plus `/api/v1/battle/context` and `/api/v1/battle/submit`
for the stateless local sandbox. A future room layer supplies its persisted server
state directly to the adapter.

The import command applies migrations and is safe to repeat when the source hash is unchanged. After changing card definitions, rebuild `cards/setup_catalog.json` and rerun the import with `--replace`. The runtime database is local and ignored by Git.

The [shared TypeScript engine](../docs/game-engine/typescript-migration.md) handles
setup, formal turn commands, card effects, disease gains and calculations through
`engine-worker/worker.mjs`. Node.js 22.12+ is required. Python starts the stateless
worker lazily, reuses it and closes it on shutdown; it opens no HTTP port. Build
after TypeScript changes. `/engine/engine.js` serves the same rule package to the
browser for local previews. The backend remains responsible for authentication,
catalog persistence and future room/network state.
