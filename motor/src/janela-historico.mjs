export function timestampHistorico(msg) {
  const t = msg?.messageTimestamp;
  let n = t && typeof t === 'object' && Number.isInteger(t.low) && Number.isInteger(t.high)
    ? (t.high >>> 0) * 4294967296 + (t.low >>> 0) : Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}
export function foraDaJanelaHistorica(msg, agora = Date.now(), dias = 30) {
  const t = timestampHistorico(msg);
  return t !== null && t < agora - dias * 86400000;
}
