#!/usr/bin/env bash
# Instalador para Android via Termux (sem root).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[Ienvia] Instalando Node.js LTS no Termux..."
  pkg update -y && pkg install -y nodejs-lts git
fi

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "[Ienvia] Instalando dependencias do Motor no Termux..."
  npm install --omit=dev
fi

chmod +x "$ROOT_DIR/scripts/iniciar.sh" 2>/dev/null || true
echo "[Ienvia] Pronto no Termux! Dica: use 'termux-wake-lock' para evitar hibernacao."
echo "Para parear e iniciar:"
echo "  ./scripts/iniciar.sh --url https://SEU-PAINEL --pair IENV-XXXX-XXXX"
