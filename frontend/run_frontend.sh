#!/usr/bin/env bash
set -euo pipefail
THUNDERSTONE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$THUNDERSTONE_ROOT"
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js 22.12+ is required."
  exit 1
fi
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<12)){console.error('[ERROR] Node.js 22.12+ is required.');process.exit(1)}"
if [[ ! -d node_modules ]]; then
  echo "[ERROR] Dependencies are not installed. Run npm ci at the project root first."
  exit 1
fi
exec npm run dev --workspace @thunderstone/frontend -- "$@"
