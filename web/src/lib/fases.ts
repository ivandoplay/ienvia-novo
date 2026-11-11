/** As fases do plano de reconstrução (o detalhe de cada uma está em docs/PLANO.md). */
export const FASES: Record<number, string> = {
  0: 'Fundação',
  1: 'Conectar e conversar',
  2: 'Atendente de IA',
  3: 'CRM completo',
  4: 'Motor local',
  5: 'Campanhas e segurança',
  6: 'Catálogo, áudios e simulador',
  7: 'Contas, configurações e migração',
  8: 'Virada para o sistema novo',
};

export function nomeDaFase(fase: number): string {
  return FASES[fase] ?? `Fase ${fase}`;
}
