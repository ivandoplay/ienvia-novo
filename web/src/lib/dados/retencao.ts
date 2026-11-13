import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResumoLimpezaRetencao {
  encontrados: number;
  apagados: number;
  falhasNoDeposito: number;
}

interface AnexoVencido {
  id: string;
  workspace_id: string;
  object_key: string;
}

const BUCKET_MIDIAS = 'midias';

/**
 * Remove do Supabase Storage os arquivos de mensagens cujo prazo de retenção venceu
 * e marca os registros como `deleted` na tabela `message_attachments`.
 * Nunca apaga arquivos de `catalogo/` ou `audios/`, nem anexos em `retained_exception`.
 */
export async function executarLimpezaDeRetencao(
  supabase: SupabaseClient,
  limite = 50,
): Promise<ResumoLimpezaRetencao> {
  const { data, error } = await supabase.rpc('claim_expired_message_attachments', {
    p_limit: Math.min(Math.max(limite, 1), 200),
  });

  if (error) {
    console.error('[retenção] falha ao reservar anexos expirados:', error.message);
    return { encontrados: 0, apagados: 0, falhasNoDeposito: 0 };
  }

  const pendentes = Array.isArray(data) ? (data as AnexoVencido[]) : [];
  if (pendentes.length === 0) {
    return { encontrados: 0, apagados: 0, falhasNoDeposito: 0 };
  }

  const idsConcluidos: string[] = [];
  const idsParaLiberar: string[] = [];

  const { error: erroRemove } = await supabase.storage
    .from(BUCKET_MIDIAS)
    .remove(pendentes.map((item) => item.object_key));

  if (erroRemove) {
    // Se o lote inteiro falhar (ex.: instabilidade momentânea no Storage), tenta um por um
    // para não segurar registros cujo arquivo já foi removido nem perder outros elegíveis.
    for (const item of pendentes) {
      const { error: erroItem } = await supabase.storage.from(BUCKET_MIDIAS).remove([item.object_key]);
      if (!erroItem || /not found/i.test(erroItem.message)) {
        idsConcluidos.push(item.id);
      } else {
        idsParaLiberar.push(item.id);
      }
    }
  } else {
    for (const item of pendentes) idsConcluidos.push(item.id);
  }

  if (idsParaLiberar.length > 0) {
    await supabase.rpc('release_expired_message_attachments', { p_ids: idsParaLiberar });
  }

  let apagados = 0;
  if (idsConcluidos.length > 0) {
    const { data: concluido, error: erroConcluir } = await supabase.rpc(
      'complete_expired_message_attachments_cleanup',
      { p_ids: idsConcluidos },
    );
    if (erroConcluir) {
      console.error('[retenção] falha ao concluir marcação de exclusão:', erroConcluir.message);
    } else if (concluido && typeof concluido === 'object' && 'deleted' in concluido) {
      apagados = Number((concluido as { deleted: number }).deleted) || 0;
    }
  }

  return {
    encontrados: pendentes.length,
    apagados,
    falhasNoDeposito: idsParaLiberar.length,
  };
}
