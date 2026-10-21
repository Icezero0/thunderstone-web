# Network backend

The backend follows the infrastructure, API and domain layering of [iCinema's backend](https://github.com/Icezero0/iCinema/tree/main/backend). It owns accounts, SQLite persistence and HTTP transport. The independent [game engine](../engine/README.md) owns card rules and state transitions; backend setup preview calls into it.

```text
backend/
├── alembic/               database migrations
└── app/
    ├── main.py            FastAPI composition and startup
    ├── core/              settings, database sessions, passwords, JWTs, errors
    ├── db/                SQLAlchemy model base
    ├── realtime/          authenticated WebSocket connections and heartbeat
    ├── modules/
    │   ├── users/          account model, repository and service
    │   └── auth/           login, refresh and current-user dependency
    └── api/v1/             account endpoints and setup preview transport
```

Registration, login, refresh, `/users/me`, and the WebSocket authentication handshake are adapted from iCinema's independent account and connection flow. Media, site roles and video rooms are specific to iCinema, so they are not part of this backend. Game room commands and subscriptions will attach to the connection manager later. The preview endpoints still return the full private setup result; they are for local use and must be replaced with player-scoped game endpoints before public multiplayer deployment.

`core/config.py` accepts `THUNDERSTONE_` prefixed environment variables. `THUNDERSTONE_DATABASE_URL` defaults to SQLite at `backend/instance/thunderstone.db`; Alembic migrations run during application startup. The ignored `backend/instance/` directory also stores a generated development JWT key unless `THUNDERSTONE_JWT_SECRET_KEY` is set. Non-development environments require that variable. The checked-in `data/cards.csv` and `data/setup_catalog.json` are import inputs; the setup API reads the imported SQLite catalog. See the [catalog database design](../docs/card-catalog-database-design.md).

From the repository root, install into the existing venv and start the service yourself:

```powershell
uv pip install --python .\.venv\Scripts\python.exe -r backend\requirements.txt
.\.venv\Scripts\python.exe scripts\import_cards_to_sqlite.py
.\.venv\Scripts\python.exe scripts\run_config_panel.py --host 127.0.0.1 --port 8765
```

The panel is at `http://127.0.0.1:8765/`. Account routes are `/api/v1/auth/register`, `/login`, `/refresh` and `/api/v1/users/me`. `/ws` accepts an initial JSON message `{"type":"auth","payload":{"token":"<access token>"}}`, then supports `{"type":"heartbeat"}`. The panel uses `/api/v1/options`, `/validate` and `/setup`; the old `/api/...` preview paths remain as compatibility aliases. `/health` reports process availability. Install `backend/requirements-dev.txt` and run `.\.venv\Scripts\python.exe -m unittest discover -s tests` to test both layers.

The import command applies migrations and is safe to repeat when the source hash is unchanged. After changing card definitions, rebuild `data/setup_catalog.json` and rerun the import with `--replace`. The runtime database is local and ignored by Git.
