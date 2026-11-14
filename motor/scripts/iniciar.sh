#!/usr/bin/env bash
# Inicia o Ienvia Motor. Pode ser chamado de qualquer pasta, a partir de:
#   ./scripts/iniciar.sh --url https://app.ienvia.online --pair IENV-XXXX-XXXX
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

NODE_BIN="node"
if [ -x "$ROOT_DIR/.runtime/node/bin/node" ]; then
  NODE_BIN="$ROOT_DIR/.runtime/node/bin/node"
fi

if [ ! -f "$ROOT_DIR/src/index.mjs" ]; then
  echo "[Ienvia Motor] Nao encontrei src/index.mjs em $ROOT_DIR."
  echo "Descompacte o pacote .zip inteiro e rode: ./scripts/iniciar.sh --url ... --pair ..."
  exit 1
fi

while true; do
  set +e
  "$NODE_BIN" "$ROOT_DIR/src/index.mjs" "$@"
  CODE=$?
  set -e
  if [ "$CODE" -eq 42 ]; then
    echo "[Ienvia Motor] Reiniciando apos atualizacao automatica..."
    sleep 1
    continue
  fi
  exit "$CODE"
done
