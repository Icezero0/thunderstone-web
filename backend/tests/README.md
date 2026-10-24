# Backend verification

Run from the repository root using the existing venv:

```powershell
.\.venv\Scripts\python.exe -B -X utf8 -m unittest discover -s backend/tests -t .
```

Build the frontend and shared engine first with `npm run build`. Tests use in-process HTTP clients and temporary databases; they do not start listening services.

| Directory | Responsibility |
| --- | --- |
| `api/` | HTTP contracts, authentication and battle sandbox endpoints |
| `modules/` | Persisted rooms, matches, multiplayer commands, visibility and SQLite card catalog |
| `core/` | Runtime paths, launchers and infrastructure |
| `catalog/` | Asset integrity, duplicates and setup-index consistency |
| `engine/` | Python adapter configuration, setup and turn flows |
| `effects/` | Per-card effect behavior, combinations and completed review regressions |
| `devtools/` | Effect lab traces and its HTTP interface |
| `migration/` | TypeScript parity tests and frozen Python reference implementations |
| `support/` | Reusable fixtures, contract runners and assertions; no discoverable test cases |

For a focused run, pass the module, for example `backend.tests.effects.test_monster_review`. The monster audit UI has been retired; its reviewed symbols, source fingerprints and actual card behaviors are still verified here.
