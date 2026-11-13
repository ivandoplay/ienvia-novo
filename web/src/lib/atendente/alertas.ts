import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { enviarTexto } from '@/lib/evolution/cliente';
import { numeroParaEnvio } from '@/lib/inbox/regras';

export type KindAlertaDoBanco =
  | 'handoff'
  | 'silent_handoff'
  | 'uncertain_send'
  | 'error'
  | 'safety'
  | 'chip_disconnected'
  | 'campaign_uncertain'
  | 'test';

export async function enviarAlertaViaRpc(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  kind: KindAlertaDoBanco;
  bodyText: string;
  preferredInstanceId?: string | null;
  turnId?: string | null;
  conversationId?: string | null;
  tempoLimiteMs?: number;
}): Promise<void> {
  const { supabase, workspaceId, kind, bodyText, preferredInstanceId, turnId, conversationId, tempoLimiteMs = 10_000 } = params;
  try {
    const { data, error } = await supabase.rpc('enqueue_workspace_admin_alert', {
      p_workspace_id: workspaceId,
      p_kind: kind,
      p_body_text: bodyText,
      p_preferred_instance_id: preferredInstanceId ?? null,
      p_turn_id: turnId ?? null,
      p_conversation_id: conversationId ?? null,
    });
    if (error || !data || typeof data !== 'object') return;
    const res = data as {
      result?: string;
      delivery_id?: string;
      provider_instance_name?: string;
      recipient_whatsapp?: string;
    };
    if (res.result !== 'ready_evolution' || !res.delivery_id || !res.provider_instance_name || !res.recipient_whatsapp) {
      return;
    }

    const numero = numeroParaEnvio(res.recipient_whatsapp);
    if (!numero) return;
    const envio = await enviarTexto(res.provider_instance_name, numero, bodyText, {
      digitandoMs: 0,
      tempoLimite: tempoLimiteMs,
    });

    await supabase.rpc('finish_admin_alert_delivery', {
      p_workspace_id: workspaceId,
      p_delivery_id: res.delivery_id,
      p_status: envio.situacao === 'enviada' ? 'sent' : envio.situacao === 'nao_enviada' ? 'failed' : 'uncertain',
      p_provider_message_id: envio.situacao === 'enviada' ? envio.idNoWhatsApp : null,
      p_error_detail:
        envio.situacao === 'nao_enviada'
          ? envio.motivo
          : envio.situacao === 'incerta'
            ? envio.detalhe
            : null,
    });
  } catch (erro) {
    console.error('[alertas] falha ao despachar alerta administrativo:', {
      workspaceId,
      kind,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }
}

export function textoAlertaDesconexao(nomeChip: string | null, origem: 'Evolution' | 'Motor Local'): string {
  const nome = (nomeChip ?? '').trim() || 'Chip sem nome';
  return [
    '📡 *ALERTA IENVIA — CHIP DESCONECTADO*',
    '',
    `*Chip:* ${nome} (${origem})`,
    '*O que aconteceu:* A conexão com o WhatsApp caiu agora pouco.',
    '*O que fazer:* Abra Instâncias ou Conexões no painel, gere um novo QR Code e confira as campanhas/fila pausadas.',
  ].join('\n');
}

export function textoAlertaCampanhaIncerta(contexto: {
  titulo: string;
  nomeCampanha?: string | null;
  telefone?: string | null;
}): string {
  return [
    '⚠️ *ALERTA IENVIA — ENVIO DE CAMPANHA SEM CONFIRMAÇÃO*',
    '',
    `*Origem:* ${contexto.titulo}`,
    ...(contexto.nomeCampanha ? [`*Campanha:* ${contexto.nomeCampanha}`] : []),
    ...(contexto.telefone ? [`*Contato:* +${contexto.telefone.replace(/\D/g, '')}`] : []),
    '*Proteção acionada:* Pausamos automaticamente a fila/campanha para evitar duplicidade. Confira no celular do chip e marque no painel se a mensagem saiu.',
  ].join('\n');
}
