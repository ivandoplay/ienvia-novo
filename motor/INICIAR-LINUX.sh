#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
bash "$ROOT/scripts/setup-linux.sh" --somente-runtime
NODE="node"
if [ -x "$ROOT/.runtime/node/bin/node" ] && "$ROOT/.runtime/node/bin/node" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' >/dev/null 2>&1; then NODE="$ROOT/.runtime/node/bin/node"; fi
exec "$NODE" "$ROOT/src/iniciar-guiado.mjs"
