import 'server-only';

import { cache } from 'react';
import { criarClienteServidor } from '@/lib/supabase/servidor';
import { inicioDoDia } from '@/lib/tempo';

/** Etapas da conversa, na ordem do funil. Os nomes vêm da coluna `conversations.stage`. */
export const ETAPAS_DO_FUNIL = [
  { etapa: 'new', rotulo: 'Novas' },
  { etapa: 'ai', rotulo: 'Com a IA' },
  { etapa: 'waiting_human', rotulo: 'Esperando você' },
  { etapa: 'human', rotulo: 'Com você' },
  { etapa: 'waiting_customer', rotulo: 'Aguardando o cliente' },
  { etapa: 'resolved', rotulo: 'Resolvidas' },
] as const;

export interface ResumoDeInstancias {
  total: number;
  conectadas: number;
  /**
   * Chips conectados com `is_enabled` ligado. Todo chip nasce com isso desligado e só o dono liga.
   * O significado fino desse botão (o que exatamente ele liga) é fechado na Fase 1, junto com a aba Instâncias.
   */
  comIaLigada: number;
}

/**
 * Números da Visão geral. Cada um pode vir `null` quando a consulta falhou:
 * a tela mostra "—" em vez de inventar um zero.
 */
export interface NumerosDaVisaoGeral {
  instancias: ResumoDeInstancias | null;
  /** Quantas conversas há em cada etapa do funil (mesma ordem de ETAPAS_DO_FUNIL). */
  funil: Array<number | null>;
  esperandoVoce: number | null;
  campanhasAtivas: number | null;
  mensagensRecebidasHoje: number | null;
  respostasDaIaHoje: number | null;
  contatos: number | null;
}

async function contar(consulta: PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  const { count, error } = await consulta;
  if (error) {
    console.error('[visão geral] consulta de contagem falhou:', error);
    return null;
  }
  return count ?? 0;
}

/**
 * Situação dos chips do workspace. É usada pelo topo do painel e pela Visão geral;
 * `cache` garante uma única consulta por requisição.
 */
export const resumirInstancias = cache(async (workspaceId: string): Promise<ResumoDeInstancias | null> => {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase
    .from('instances')
    .select('status, is_enabled')
    .eq('workspace_id', workspaceId)
    .returns<Array<{ status: string; is_enabled: boolean }>>();

  if (error) {
    console.error('[visão geral] não foi possível ler as instâncias:', error);
    return null;
  }

  const instancias = data ?? [];
  const conectadas = instancias.filter((instancia) => instancia.status === 'connected');
  return {
    total: instancias.length,
    conectadas: conectadas.length,
    comIaLigada: conectadas.filter((instancia) => instancia.is_enabled).length,
  };
});

/**
 * Todos os números da Visão geral, lidos de uma vez.
 * Tudo passa pelo RLS: só entram dados do workspace em que a pessoa participa.
 */
export async function carregarVisaoGeral(workspaceId: string, agora: Date = new Date()): Promise<NumerosDaVisaoGeral> {
  const supabase = await criarClienteServidor();
  const hoje = inicioDoDia(agora).toISOString();
  const doWorkspace = (tabela: string) =>
    supabase.from(tabela).select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);

  const [instancias, funil, campanhasAtivas, mensagensRecebidasHoje, respostasDaIaHoje, contatos] = await Promise.all([
    resumirInstancias(workspaceId),
    Promise.all(ETAPAS_DO_FUNIL.map(({ etapa }) => contar(doWorkspace('conversations').eq('stage', etapa)))),
    contar(doWorkspace('campaigns').eq('status', 'running')),
    contar(doWorkspace('messages').eq('direction', 'inbound').gte('occurred_at', hoje)),
    contar(doWorkspace('messages').eq('actor_type', 'ai').gte('occurred_at', hoje)),
    contar(doWorkspace('contacts').is('erased_at', null)),
  ]);

  const indiceEsperando = ETAPAS_DO_FUNIL.findIndex(({ etapa }) => etapa === 'waiting_human');

  return {
    instancias,
    funil,
    esperandoVoce: funil[indiceEsperando] ?? null,
    campanhasAtivas,
    mensagensRecebidasHoje,
    respostasDaIaHoje,
    contatos,
  };
}
