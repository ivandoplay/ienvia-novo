import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { enviarTexto } from '@/lib/evolution/cliente';
import { numeroParaEnvio } from '@/lib/inbox/regras';

interface ItemAgendado {
  scheduled_id: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  provider_instance_name: string | null;
  recipient: string | null;
  body_text: string;
}

export interface ResumoDosAgendamentos {
  processados: number;
  enviados: number;
  falhos: number;
  incertos: number;
}

export async function processarAgendamentosVencidos(
  supabase: SupabaseClient,
  limite: number = 20,
): Promise<ResumoDosAgendamentos> {
  const resumo: ResumoDosAgendamentos = { processados: 0, enviados: 0, falhos: 0, incertos: 0 };

  const { data, error } = await supabase.rpc('claim_due_scheduled_messages', { p_limit: limite });
  if (error || !Array.isArray(data)) {
    if (error) console.error('[agendamentos] erro ao buscar pendentes:', error);
    return resumo;
  }

  for (const item of data as ItemAgendado[]) {
    resumo.processados += 1;
    const numero = numeroParaEnvio(item.recipient);
    const instancia = item.provider_instance_name?.trim() || '';
    if (!numero || !instancia) {
      await supabase.rpc('finish_scheduled_message', {
        p_workspace_id: item.workspace_id,
        p_scheduled_id: item.scheduled_id,
        p_outcome: 'failed',
        p_provider_message_id: null,
        p_error_detail: !instancia ? 'chip_nao_encontrado' : 'destinatario_invalido',
      });
      resumo.falhos += 1;
      continue;
    }

    const envio = await enviarTexto(instancia, numero, item.body_text);
    if (envio.situacao === 'enviada') {
      await supabase.rpc('finish_scheduled_message', {
        p_workspace_id: item.workspace_id,
        p_scheduled_id: item.scheduled_id,
        p_outcome: 'sent',
        p_provider_message_id: envio.idNoWhatsApp,
        p_error_detail: null,
      });
      resumo.enviados += 1;
    } else if (envio.situacao === 'nao_enviada') {
      await supabase.rpc('finish_scheduled_message', {
        p_workspace_id: item.workspace_id,
        p_scheduled_id: item.scheduled_id,
        p_outcome: 'failed',
        p_provider_message_id: null,
        p_error_detail: envio.motivo,
      });
      resumo.falhos += 1;
    } else {
      await supabase.rpc('finish_scheduled_message', {
        p_workspace_id: item.workspace_id,
        p_scheduled_id: item.scheduled_id,
        p_outcome: 'uncertain',
        p_provider_message_id: null,
        p_error_detail: envio.detalhe,
      });
      resumo.incertos += 1;
    }
  }

  return resumo;
}
