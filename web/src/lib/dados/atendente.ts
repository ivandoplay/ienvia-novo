import 'server-only';

import { cache } from 'react';
import { lerResumoDaIa, type ResumoDaIa } from '@/lib/atendente/painel';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Como está a IA da empresa: pausada ou não, em quantos chips está ligada e o que falta para ligar.
 * É usado pelo topo do painel, pela Visão geral e pela aba Instâncias; `cache` garante uma única
 * consulta por requisição. `null` quando a leitura falhou (a tela não inventa um estado).
 */
export const carregarResumoDaIa = cache(async (workspaceId: string): Promise<ResumoDaIa | null> => {
  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.rpc('read_my_ai_overview', { p_workspace_id: workspaceId });
  if (error || !data) {
    console.error('[atendente] não foi possível ler o resumo da IA:', error);
    return null;
  }
  return lerResumoDaIa(data);
});
