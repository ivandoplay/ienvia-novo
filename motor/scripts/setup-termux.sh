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
  pkg upgrade -y
  pkg install -y nodejs-lts libicu git
fi
# Node pode já existir sem Git. Verificar separadamente.
if ! command -v git >/dev/null 2>&1; then
  pkg update -y
  pkg install -y git
fi
# Escopo restrito ao instalador e seus subprocessos; não grava configuração global.
# Baileys usa libsignal via Git. npm recente bloqueia esse tipo por padrão.
export npm_config_allow_git=all
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
export GIT_CONFIG_VALUE_0=ssh://git@github.com/
export GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf
export GIT_CONFIG_VALUE_1=git@github.com:
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo '[Ienvia] Node.js 24 ou superior necessário.'; exit 1; }
STAMP="$(node -e 'const fs=require("fs"),c=require("crypto");let p=fs.readFileSync("package.json");if(fs.existsSync("package-lock.json"))p=Buffer.concat([p,fs.readFileSync("package-lock.json")]);console.log(c.createHash("sha256").update(p).digest("hex"))')"
if [[ ! -f node_modules/.ienvia-deps || "$(cat node_modules/.ienvia-deps)" != "$STAMP" ]]; then
  echo '[Ienvia] Instalando dependências. A sessão em data/ será preservada.'
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
  else
    npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
  fi
  printf '%s' "$STAMP" > node_modules/.ienvia-deps
fi
