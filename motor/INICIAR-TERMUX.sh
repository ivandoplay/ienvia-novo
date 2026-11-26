#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ "$ROOT" == /sdcard/* || "$ROOT" == /storage/* ]]; then
  echo 'Extraia a pasta ienvia-motor dentro de $HOME no Termux. O Android não permite executar dependências corretamente no armazenamento compartilhado.'
  exit 1
fi
bash "$ROOT/scripts/setup-termux.sh" --somente-runtime
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
exec node "$ROOT/src/iniciar-guiado.mjs"
