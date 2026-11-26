export const CADENCIA_ATUALIZACAO_MS = 15 * 60_000;
// Pequena dispersao evita consultas simultaneas de toda a base de clientes.
export function intervaloDeAtualizacao(random = Math.random) {
  return CADENCIA_ATUALIZACAO_MS + Math.floor(Math.max(0,Math.min(0.999999,random()))*60_000);
}
