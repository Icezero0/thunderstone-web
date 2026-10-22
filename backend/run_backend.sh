#!/usr/bin/env bash
set -euo pipefail
THUNDERSTONE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
THUNDERSTONE_PYTHON="$THUNDERSTONE_ROOT/.venv/bin/python"
if [[ ! -x "$THUNDERSTONE_PYTHON" && -x "$THUNDERSTONE_ROOT/.venv/Scripts/python.exe" ]]; then
  THUNDERSTONE_PYTHON="$THUNDERSTONE_ROOT/.venv/Scripts/python.exe"
fi
if [[ ! -x "$THUNDERSTONE_PYTHON" ]]; then
  echo "[ERROR] Project virtualenv was not found. Create .venv and install backend/requirements.txt first."
  exit 1
fi
cd "$THUNDERSTONE_ROOT"
exec "$THUNDERSTONE_PYTHON" "$THUNDERSTONE_ROOT/backend/run_backend.py" "$@"
