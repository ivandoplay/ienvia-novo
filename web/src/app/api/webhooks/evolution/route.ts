import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { atenderSobras, atenderVez, orcamentoDoAtendente } from '@/lib/atendente/atendente';
import { interpretarAviso } from '@/lib/evolution/aviso';
import { trazerArquivoDaMensagem } from '@/lib/inbox/buscar-arquivo';
import { criarClienteDeServico } from '@/lib/supabase/servico';

/**
 * Porta de entrada dos avisos da Evolution: mensagem que chegou, mensagem que saiu e chip que conectou ou caiu.
 *
 * Não existe usuário logado aqui. Cada chip tem um segredo próprio, que a Evolution manda no
 * cabeçalho Authorization; o banco guarda só o resumo (SHA-256) desse segredo e é ele quem confere
 * se o aviso é mesmo daquele chip. Aviso sem segredo certo não grava nada.
 *
 * Mensagem com arquivo (foto, áudio, vídeo, documento, figurinha): a mensagem é gravada na hora e a
 * Evolution recebe o "ok" em seguida; o arquivo em si é trazido logo depois, sem segurar a resposta.
 *
 * Mensagem de um cliente num chip com a IA ligada: o banco marca a vez da IA ao gravar a mensagem, e a
 * resposta é preparada e enviada também depois do "ok" (ver lib/atendente/atendente.ts).
 */

/**
 * Buscar um arquivo grande na Evolution e guardá-lo pode levar dezenas de segundos; a resposta da IA
 * (esperar o cliente terminar de escrever, pedir ao provedor e enviar) também. O atendente trabalha
 * com um tempo total menor que este (orcamentoDoAtendente), para nunca ser cortado no meio de um envio.
 */
export const maxDuration = 60;

/**
 * Um aviso de foto ou vídeo traz junto a miniatura, e isso pesa (centenas de milhares de letras).
 * O limite fica logo abaixo do máximo que a hospedagem aceita, para nunca perder uma mensagem por tamanho.
 */
const CORPO_MAXIMO = 4_000_000;

const responder = (status: number, corpo: Record<string, unknown>) => Response.json(corpo, { status });

export async function POST(pedido: Request): Promise<Response> {
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
          // Para o banco, mensagem recebida e mensagem enviada entram pela mesma porta; quem diferencia é p_from_me.
          p_event_type: 'MESSAGES_UPSERT',
          p_sender_jid: aviso.remetente,
          p_push_name: aviso.nome,
          // Com arquivo, o texto é a legenda (e pode não existir).
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
    /** A vez da IA, quando a mensagem é de um cliente e a IA pode responder. */
    ai?: { scheduled?: boolean; turn_id?: string; wait_ms?: number } | null;
    /** Ficou alguma vez da IA para trás nesta empresa. */
    ai_stale?: boolean;
  } | null;
  const resultado = gravado?.result ?? 'desconhecido';
  if (resultado === 'unauthorized') return responder(401, { ok: false, erro: 'não autorizado' });

  // A mensagem já está gravada e aparece na conversa. O arquivo vem depois de responder à Evolution:
  // se a busca falhar, a conversa mostra o aviso e o botão "tentar de novo".
  if (aviso.tipo === 'mensagem' && resultado === 'accepted' && gravado?.media?.status === 'pending' && gravado.workspace_id && gravado.message_id) {
    const alvo = { workspaceId: gravado.workspace_id, mensagemId: gravado.message_id };
    const mensagemDoAviso = aviso.paraBuscar;
    after(async () => {
      await trazerArquivoDaMensagem(supabase, alvo, mensagemDoAviso);
    });
  }

  // A IA responde depois do "ok" à Evolution. Se algo der errado, a conversa vai para "Esperando você".
  if (aviso.tipo === 'mensagem' && resultado === 'accepted' && gravado?.workspace_id) {
    const workspaceId = gravado.workspace_id;
    const ambiente = { supabase, prazo: chegouEm + orcamentoDoAtendente() };
    const vez = gravado.ai?.scheduled === true && gravado.ai.turn_id && gravado.message_id ? { vezId: gravado.ai.turn_id, gatilhoId: gravado.message_id } : null;
    const espera = typeof gravado.ai?.wait_ms === 'number' && gravado.ai.wait_ms > 0 ? gravado.ai.wait_ms : 0;
    const haSobras = gravado.ai_stale === true;
    if (vez || haSobras) {
      after(async () => {
        if (vez) await atenderVez(ambiente, { workspaceId, ...vez, esperaMs: espera });
        // Vez que ficou sem dono (o servidor reiniciou no meio, por exemplo): este pedido aproveita e cuida.
        if (haSobras) await atenderSobras(ambiente, workspaceId);
      });
    }
  }

  return responder(200, { ok: true, resultado });
}
