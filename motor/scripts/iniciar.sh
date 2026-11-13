#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

NODE_BIN="node"
if [ -x "$ROOT_DIR/.runtime/node/bin/node" ]; then
  NODE_BIN="$ROOT_DIR/.runtime/node/bin/node"
fi

while true; do
  set +e
  "$NODE_BIN" src/index.mjs "$@"
  CODE=$?
  set -e
  if [ "$CODE" -eq 42 ]; then
    echo "[Ienvia Motor] Reiniciando apos atualizacao automatica..."
    sleep 1
    continue
  fi
  exit "$CODE"
done
