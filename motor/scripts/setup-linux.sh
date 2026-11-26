#!/usr/bin/env bash
# Node portatil somente dentro do motor. Nao altera Node global, data/ ou credenciais.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION="v24.22.3"
RUNTIME_DIR="$ROOT_DIR/.runtime/node"
cd "$ROOT_DIR"
node_compativel() {
  [ -x "$1" ] && "$1" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' >/dev/null 2>&1
}
NODE_BIN=""
if node_compativel "$RUNTIME_DIR/bin/node"; then
  NODE_BIN="$RUNTIME_DIR/bin/node"
elif command -v node >/dev/null 2>&1 && node_compativel "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
fi
if [ -z "$NODE_BIN" ]; then
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH="linux-x64" ;;
    aarch64|arm64) NODE_ARCH="linux-arm64" ;;
    *) echo '[Ienvia] Arquitetura nao suportada. Instale Node.js 24 ou superior.'; exit 1 ;;
  esac
  TARBALL="node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  echo "[Ienvia] Preparando Node.js ${NODE_VERSION}. Sessoes e filas serao preservadas."
  curl -fsSL "${BASE_URL}/${TARBALL}" -o "$TMP_DIR/$TARBALL"
  curl -fsSL "${BASE_URL}/SHASUMS256.txt" -o "$TMP_DIR/SHASUMS256.txt"
  (cd "$TMP_DIR" && grep "  ${TARBALL}\$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$ROOT_DIR/.runtime"
  STAGE="$(mktemp -d "$ROOT_DIR/.runtime/node-preparo.XXXXXX")"
  if ! tar -xJf "$TMP_DIR/$TARBALL" -C "$STAGE" --strip-components=1 || ! node_compativel "$STAGE/bin/node"; then
    rm -rf "$STAGE"
    echo '[Ienvia] Node 24 nao iniciou neste Linux. Runtime anterior e dados preservados.'
    exit 1
  fi
  BACKUP=""
  if [ -e "$RUNTIME_DIR" ]; then
    BACKUP="$ROOT_DIR/.runtime/node-anterior-$(date +%s)-$$"
    mv "$RUNTIME_DIR" "$BACKUP"
  fi
  if ! mv "$STAGE" "$RUNTIME_DIR"; then
    if [ -n "$BACKUP" ]; then mv "$BACKUP" "$RUNTIME_DIR"; fi
    exit 1
  fi
  NODE_BIN="$RUNTIME_DIR/bin/node"
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
export npm_config_allow_git=all
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
export GIT_CONFIG_VALUE_0=ssh://git@github.com/
export GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf
export GIT_CONFIG_VALUE_1=git@github.com:
NPM_BIN="$(command -v npm || true)"
if [ -z "$NPM_BIN" ]; then echo '[Ienvia] npm nao encontrado. Instale npm para o Node 24.'; exit 1; fi
STAMP="$("$NODE_BIN" -e 'const fs=require("fs"),c=require("crypto");const p=JSON.parse(fs.readFileSync("package.json"));console.log(c.createHash("sha256").update(JSON.stringify(p.dependencies||{})).update(fs.existsSync("package-lock.json")?fs.readFileSync("package-lock.json"):"").digest("hex"))')"
if [ ! -f node_modules/.ienvia-linux-deps ] || [ "$(cat node_modules/.ienvia-linux-deps)" != "$STAMP" ]; then
  echo '[Ienvia] Preparando dependencias. Nenhuma sessao sera apagada.'
  if [ -f package-lock.json ]; then
    "$NPM_BIN" ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
  else
    "$NPM_BIN" install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
  fi
  mkdir -p node_modules
  printf '%s' "$STAMP" > node_modules/.ienvia-linux-deps
fi
chmod +x "$ROOT_DIR/scripts/iniciar.sh" 2>/dev/null || true
echo '[Ienvia] Node 24+ pronto. Inicie com bash ./scripts/iniciar.sh --url https://app.ienvia.online'
