import { createHash, timingSafeEqual } from 'node:crypto';
import { enviarAlertaViaRpc, textoAlertaDesconexao } from '@/lib/atendente/alertas';
import { atenderSobras, atenderVez, orcamentoDoAtendente } from '@/lib/atendente/atendente';
import { executarCampanhasEFilaSegura } from '@/lib/campanhas/executor';
import { processarAgendamentosVencidos } from '@/lib/evolution/agendados';
import { interpretarAviso } from '@/lib/evolution/aviso';
import { enviarTexto } from '@/lib/evolution/cliente';
import { trazerArquivoDaMensagem } from '@/lib/inbox/buscar-arquivo';
import { numeroParaEnvio } from '@/lib/inbox/regras';
import { criarClienteDeServico } from '@/lib/supabase/servico';

/**
 * Núcleo compartilhado da porta de entrada dos avisos da Evolution.
 *
 * Funciona sem depender de nenhum framework:
 *   - na rota reserva do Next.js (/api/webhooks/evolution) usando `after(...)`;
 *   - na Supabase Edge Function (evolution-webhook) usando `EdgeRuntime.waitUntil(...)`.
 */

const CORPO_MAXIMO = 4_000_000;

const responder = (status: number, corpo: Record<string, unknown>) => Response.json(corpo, { status });

function segredoCronConfere(recebido: string | null): boolean {
  const esperado = process.env.CRON_SECRET?.trim();
  if (!recebido || !esperado) return false;
  const a = createHash('sha256').update(recebido.trim()).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

export interface OpcoesDoAviso {
  agendar: (tarefa: () => Promise<void>) => void;
}

export async function processarAvisoEvolution(pedido: Request, opcoes: OpcoesDoAviso): Promise<Response> {
  const chegouEm = Date.now();
  const cabecalhoCron = pedido.headers.get('x-ienvia-cron');
  if (cabecalhoCron) {
    if (!segredoCronConfere(cabecalhoCron)) return responder(401, { ok: false, erro: 'não autorizado' });
    const supabase = criarClienteDeServico();
    if (!supabase) return responder(503, { ok: false, erro: 'painel sem configuração de serviço' });
    const [agendamentos, disparos] = await Promise.all([
      processarAgendamentosVencidos(supabase, 25),
      executarCampanhasEFilaSegura(supabase, chegouEm, 48_000),
    ]);
    return responder(200, { ok: true, resultado: 'cron', ...agendamentos, disparos });
  }

  const segredo = /^Bearer\s+(\S+)$/i.exec(pedido.headers.get('authorization') ?? '')?.[1];
  if (!segredo || segredo.length > 200) return responder(401, { ok: false, erro: 'não autorizado' });

  const bruto = await pedido.text();
  if (bruto.length > CORPO_MAXIMO) return responder(413, { ok: false, erro: 'aviso grande demais' });

  let corpo: unknown;
  try {
    corpo = JSON.parse(bruto);
  } catch {
    return responder(400, { ok: false, erro: 'aviso ilegível' });
  }

  const aviso = interpretarAviso(corpo);
  // O que o painel não usa é respondido com "ok": assim a Evolution não fica reenviando.
  if (aviso.tipo === 'ignorado') return responder(200, { ok: true, resultado: 'ignorado' });

  const supabase = criarClienteDeServico();
  if (!supabase) {
    console.error('[aviso da Evolution] a chave do servidor do Supabase não está configurada neste ambiente.');
    return responder(503, { ok: false, erro: 'painel sem configuração para receber avisos' });
  }

  const resumo = createHash('sha256').update(segredo).digest('hex');

  if (aviso.tipo === 'status_mensagem') {
    const { data, error } = await supabase.rpc('apply_evolution_message_status', {
      p_instance_name: aviso.instancia,
      p_token_sha256: resumo,
      p_updates: aviso.atualizacoes.map((a) => ({ provider_message_id: a.idNoWhatsApp, status: a.status })),
    });
    if (error) {
      console.error('[aviso da Evolution] falha ao atualizar status de mensagem:', error);
      return responder(500, { ok: false, erro: 'não foi possível atualizar status' });
    }
    const r = data as { result?: string; applied?: number } | null;
    if (r?.result === 'unauthorized') return responder(401, { ok: false, erro: 'não autorizado' });
    return responder(200, { ok: true, resultado: r?.result ?? 'ok', aplicadas: r?.applied ?? 0 });
  }

  const { data, error } =
    aviso.tipo === 'conexao'
      ? await supabase.rpc('apply_evolution_connection_update', {
          p_instance_name: aviso.instancia,
          p_token_sha256: resumo,
          p_provider_state: aviso.estado,
          p_connected_phone: aviso.telefone,
        })
      : await supabase.rpc('ingest_evolution_message', {
          p_instance_name: aviso.instancia,
          p_token_sha256: resumo,
          p_event_id: aviso.idDoEvento,
          p_event_type: 'MESSAGES_UPSERT',
          p_sender_jid: aviso.remetente,
          p_push_name: aviso.nome,
          p_body_text: aviso.texto,
          p_occurred_at: aviso.quando,
          p_from_me: aviso.deMim,
          p_media: aviso.arquivo
            ? {
                kind: aviso.arquivo.tipo,
                mime: aviso.arquivo.conteudo,
                size: aviso.arquivo.tamanho,
                file_name: aviso.arquivo.nome,
                duration: aviso.arquivo.duracao,
                width: aviso.arquivo.largura,
                height: aviso.arquivo.altura,
                voice: aviso.arquivo.voz,
              }
            : null,
        });

  if (error) {
    console.error('[aviso da Evolution] o banco recusou o aviso:', { tipo: aviso.tipo, codigo: error.code, mensagem: error.message });
    return responder(500, { ok: false, erro: 'não foi possível gravar' });
  }

  const gravado = data as {
    result?: string;
    workspace_id?: string;
    instance_id?: string;
    display_name?: string;
    alert_disconnected?: boolean;
    message_id?: string;
    media?: { status?: string } | null;
    ai?: {
      scheduled?: boolean;
      turn_id?: string;
      wait_ms?: number;
      off_hours_reply?: {
        message_id: string;
        provider_instance_name: string;
        recipient: string;
        body_text: string;
      } | null;
    } | null;
    ai_stale?: boolean;
  } | null;
  const resultado = gravado?.result ?? 'desconhecido';
  if (resultado === 'unauthorized') return responder(401, { ok: false, erro: 'não autorizado' });

  if (aviso.tipo === 'conexao' && gravado?.alert_disconnected && gravado.workspace_id) {
    const wsId = gravado.workspace_id;
    const chipNome = gravado.display_name ?? aviso.instancia;
    const chipId = gravado.instance_id ?? null;
    opcoes.agendar(async () => {
      await enviarAlertaViaRpc({
        supabase,
        workspaceId: wsId,
        kind: 'chip_disconnected',
        bodyText: textoAlertaDesconexao(chipNome, 'Evolution'),
        preferredInstanceId: chipId,
      });
    });
  }

  if (aviso.tipo === 'mensagem' && resultado === 'accepted' && gravado?.media?.status === 'pending' && gravado.workspace_id && gravado.message_id) {
    const alvo = { workspaceId: gravado.workspace_id, mensagemId: gravado.message_id };
    const mensagemDoAviso = aviso.paraBuscar;
    opcoes.agendar(async () => {
      await trazerArquivoDaMensagem(supabase, alvo, mensagemDoAviso);
    });
  }

  if (aviso.tipo === 'mensagem' && resultado === 'accepted' && gravado?.workspace_id) {
    const workspaceId = gravado.workspace_id;
    const offHours = gravado.ai?.off_hours_reply;
    if (offHours?.message_id && offHours.provider_instance_name && offHours.recipient && offHours.body_text) {
      opcoes.agendar(async () => {
        const numero = numeroParaEnvio(offHours.recipient);
        if (!numero) return;
        const envio = await enviarTexto(offHours.provider_instance_name, numero, offHours.body_text, {
          digitandoMs: 1_200,
          tempoLimite: 15_000,
        });
        await supabase.rpc('finish_offhours_message', {
          p_workspace_id: workspaceId,
          p_message_id: offHours.message_id,
          p_outcome: envio.situacao === 'enviada' ? 'sent' : envio.situacao === 'nao_enviada' ? 'failed' : 'uncertain',
          p_provider_message_id: envio.situacao === 'enviada' ? envio.idNoWhatsApp : null,
        });
      });
    }

    const ambiente = { supabase, prazo: chegouEm + orcamentoDoAtendente() };
    const vez = gravado.ai?.scheduled === true && gravado.ai.turn_id && gravado.message_id ? { vezId: gravado.ai.turn_id, gatilhoId: gravado.message_id } : null;
    const espera = typeof gravado.ai?.wait_ms === 'number' && gravado.ai.wait_ms > 0 ? gravado.ai.wait_ms : 0;
    const haSobras = gravado.ai_stale === true;
    if (vez || haSobras) {
      opcoes.agendar(async () => {
        if (vez) await atenderVez(ambiente, { workspaceId, ...vez, esperaMs: espera });
        if (haSobras) await atenderSobras(ambiente, workspaceId);
      });
    }
  }

  return responder(200, { ok: true, resultado });
}
