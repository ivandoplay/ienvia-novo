#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
if ! command -v pkg >/dev/null 2>&1; then
  echo '[Ienvia] Este instalador deve rodar no Termux.'
  exit 1
fi
if ! node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' >/dev/null 2>&1; then
  echo '[Ienvia] Preparando Node.js e bibliotecas do Termux. Isso pode atualizar pacotes instalados.'
  pkg update -y
  pkg install -y nodejs-lts libicu
fi
# Dependencias distribuidas pelo registro npm; Git nao e necessario.
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo '[Ienvia] Node.js 24 ou superior necessário.'; exit 1; }
DEPS="$ROOT_DIR/src/dependencias.mjs"
if [ -f "$ROOT_DIR/.runtime/ienvia-bootstrap/dependencias.mjs" ]; then DEPS="$ROOT_DIR/.runtime/ienvia-bootstrap/dependencias.mjs"; fi
if [ "${1:-}" != "--somente-runtime" ]; then
  node "$DEPS" --preparar
fi
