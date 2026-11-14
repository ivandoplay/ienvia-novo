#!/usr/bin/env bash
# Instalador portatil para Linux (VPS, desktop ou mini-PC), sem precisar de root/sudo.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VERSION="v22.14.0"
RUNTIME_DIR="$ROOT_DIR/.runtime/node"

cd "$ROOT_DIR"

detetar_node() {
  if [ -x "$RUNTIME_DIR/bin/node" ]; then
    echo "$RUNTIME_DIR/bin/node"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    if [ "$major" -ge 20 ]; then
      command -v node
      return
    fi
  fi
  echo ""
}

NODE_BIN="$(detetar_node)"
if [ -z "$NODE_BIN" ]; then
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) NODE_ARCH="linux-x64" ;;
    aarch64|arm64) NODE_ARCH="linux-arm64" ;;
    *) echo "Arquitetura nao suportada automaticamente: $ARCH"; exit 1 ;;
  esac
  TARBALL="node-${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  echo "[Ienvia] Baixando Node.js portatil ${NODE_VERSION} (${NODE_ARCH})..."
  curl -fsSL "${BASE_URL}/${TARBALL}" -o "$TMP_DIR/$TARBALL"
  curl -fsSL "${BASE_URL}/SHASUMS256.txt" -o "$TMP_DIR/SHASUMS256.txt"

  (cd "$TMP_DIR" && grep "  ${TARBALL}\$" SHASUMS256.txt | sha256sum -c -)

  mkdir -p "$ROOT_DIR/.runtime"
  rm -rf "$RUNTIME_DIR"
  mkdir -p "$RUNTIME_DIR"
  tar -xJf "$TMP_DIR/$TARBALL" -C "$RUNTIME_DIR" --strip-components=1
  NODE_BIN="$RUNTIME_DIR/bin/node"
fi

NPM_BIN="$(dirname "$NODE_BIN")/npm"
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "[Ienvia] Instalando dependencias do Motor..."
  PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install --omit=dev
fi

chmod +x "$ROOT_DIR/scripts/iniciar.sh" 2>/dev/null || true
echo "[Ienvia] Pronto! Para parear, execute:"
echo "  ./scripts/iniciar.sh --url https://SEU-PAINEL --pair IENV-XXXX-XXXX"
