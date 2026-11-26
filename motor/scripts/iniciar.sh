#!/usr/bin/env bash
# Inicia o Ienvia Motor. Pode ser chamado de qualquer pasta, a partir de:
#   ./scripts/iniciar.sh --url https://app.ienvia.online --pair IENV-XXXX-XXXX
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

node_compativel() {
  "$1" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' >/dev/null 2>&1
}
selecionar_node() {
  if [ -x "$ROOT_DIR/.runtime/node/bin/node" ] && node_compativel "$ROOT_DIR/.runtime/node/bin/node"; then
    NODE_BIN="$ROOT_DIR/.runtime/node/bin/node"
  elif command -v node >/dev/null 2>&1 && node_compativel "$(command -v node)"; then
    NODE_BIN="$(command -v node)"
  else
    NODE_BIN=""
  fi
}
selecionar_node
if [ -z "$NODE_BIN" ]; then
  if [ "$(uname -s)" = 'Linux' ] && [ -z "${TERMUX_VERSION:-}" ] && [[ "${PREFIX:-}" != *com.termux* ]]; then
    bash "$ROOT_DIR/scripts/setup-linux.sh"
    selecionar_node
  else
    echo '[Ienvia] Node.js 24 ou superior necessario. No Termux, execute INICIAR-TERMUX.sh.'
  fi
fi
if [ -z "$NODE_BIN" ]; then
  echo '[Ienvia] Node compativel indisponivel. Nenhuma sessao foi alterada.'
  exit 1
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
