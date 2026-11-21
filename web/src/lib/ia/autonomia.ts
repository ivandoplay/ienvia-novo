/** Ativação explícita pela base; não muda contas que não adotaram esta política. */
export function usaAutonomiaV2(base: { gatilhosDeRepasse?: string }): boolean {
  return (base.gatilhosDeRepasse ?? '').includes('[POLITICA_AUTONOMIA_V2]');
}

export const TOPICOS_DE_AVISO = ['visita_a_caminho', 'simulacao_parcelamento'] as const;
export type TopicoDeAviso = typeof TOPICOS_DE_AVISO[number];

export function lerAvisoSemPausa(valor: string): { topico: TopicoDeAviso; motivo: string } | null {
  const [topico = '', ...partes] = valor.split('|');
  if (!TOPICOS_DE_AVISO.includes(topico.trim() as TopicoDeAviso)) return null;
  return { topico: topico.trim() as TopicoDeAviso, motivo: partes.join('|').replace(/\s+/g, ' ').trim().slice(0, 500) || topico.trim() };
}
