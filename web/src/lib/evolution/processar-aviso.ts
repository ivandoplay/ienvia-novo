import { createHash } from 'node:crypto';
import { atenderSobras, atenderVez, orcamentoDoAtendente } from '@/lib/atendente/atendente';
import { interpretarAviso } from '@/lib/evolution/aviso';
import { trazerArquivoDaMensagem } from '@/lib/inbox/buscar-arquivo';
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

export interface OpcoesDoAviso {
  agendar: (tarefa: () => Promise<void>) => void;
}

export async function processarAvisoEvolution(pedido: Request, opcoes: OpcoesDoAviso): Promise<Response> {
  const chegouEm = Date.now();
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
    message_id?: string;
    media?: { status?: string } | null;
    ai?: { scheduled?: boolean; turn_id?: string; wait_ms?: number } | null;
    ai_stale?: boolean;
  } | null;
  const resultado = gravado?.result ?? 'desconhecido';
  if (resultado === 'unauthorized') return responder(401, { ok: false, erro: 'não autorizado' });

  if (aviso.tipo === 'mensagem' && resultado === 'accepted' && gravado?.media?.status === 'pending' && gravado.workspace_id && gravado.message_id) {
    const alvo = { workspaceId: gravado.workspace_id, mensagemId: gravado.message_id };
    const mensagemDoAviso = aviso.paraBuscar;
    opcoes.agendar(async () => {
      await trazerArquivoDaMensagem(supabase, alvo, mensagemDoAviso);
    });
  }

  if (aviso.tipo === 'mensagem' && resultado === 'accepted' && gravado?.workspace_id) {
    const workspaceId = gravado.workspace_id;
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
