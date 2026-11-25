export function atrasoReconexao(tentativa) {
  return Math.min(300_000, 4000 * 2 ** Math.min(7, Math.max(0, tentativa)));
}
export function podeRetomarSessao(status, registrada) {
  // Logout, substituição por outra sessão e credencial inválida precisam de intervenção.
  return registrada && ![401, 403, 411, 440, 500].includes(status);
}
export function ehMensagemHistorica(type, msg, inicioConexao) {
  if (type === 'append') return true;
  const raw=msg?.messageTimestamp;
  const segundos=typeof raw?.toNumber === 'function' ? raw.toNumber() : Number(raw);
  // Margem de cinco minutos para relógio/entrega atrasada. Sem timestamp, notify é live.
  return Number.isFinite(segundos) && segundos > 0 && segundos * 1000 < inicioConexao - 300_000;
}
