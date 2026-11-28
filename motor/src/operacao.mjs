export function atrasoReconexao(tentativa) {
  return Math.min(300_000, 4000 * 2 ** Math.min(7, Math.max(0, tentativa)));
}
export function podeRetomarSessao(status, registrada, tentativa = 0) {
  // 500 pode ser transitório: reutiliza credenciais no máximo duas vezes, sem limpar sessão.
  if (status === 500) return registrada && tentativa < 2;
  // Logout, proibição e substituição exigem intervenção; nunca disputar outra sessão.
  return registrada && ![401, 403, 411, 440].includes(status);
}
export function ehMensagemHistorica(type, msg, inicioConexao) {
  if (type === 'append') return true;
  const raw=msg?.messageTimestamp;
  const segundos=typeof raw?.toNumber === 'function' ? raw.toNumber() : Number(raw);
  // Margem de cinco minutos para relógio/entrega atrasada. Sem timestamp, notify é live.
  return Number.isFinite(segundos) && segundos > 0 && segundos * 1000 < inicioConexao - 300_000;
}
