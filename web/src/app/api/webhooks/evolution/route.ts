import { createHash } from 'node:crypto';
import { interpretarAviso } from '@/lib/evolution/aviso';
import { criarClienteDeServico } from '@/lib/supabase/servico';

/**
 * Porta de entrada dos avisos da Evolution: mensagem que chegou, mensagem que saiu e chip que conectou ou caiu.
 *
 * Não existe usuário logado aqui. Cada chip tem um segredo próprio, que a Evolution manda no
 * cabeçalho Authorization; o banco guarda só o resumo (SHA-256) desse segredo e é ele quem confere
 * se o aviso é mesmo daquele chip. Aviso sem segredo certo não grava nada.
 */

const CORPO_MAXIMO = 1_000_000;

const responder = (status: number, corpo: Record<string, unknown>) => Response.json(corpo, { status });

export async function POST(pedido: Request): Promise<Response> {
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
      : await supabase.rpc('ingest_evolution_text', {
          p_instance_name: aviso.instancia,
          p_token_sha256: resumo,
          p_event_id: aviso.idDoEvento,
          // Para o banco, mensagem recebida e mensagem enviada entram pela mesma porta; quem diferencia é p_from_me.
          p_event_type: 'MESSAGES_UPSERT',
          p_sender_jid: aviso.remetente,
          p_push_name: aviso.nome,
          p_body_text: aviso.texto,
          p_occurred_at: aviso.quando,
          p_from_me: aviso.deMim,
        });

  if (error) {
    console.error('[aviso da Evolution] o banco recusou o aviso:', { tipo: aviso.tipo, codigo: error.code, mensagem: error.message });
    return responder(500, { ok: false, erro: 'não foi possível gravar' });
  }

  const resultado = (data as { result?: string } | null)?.result ?? 'desconhecido';
  if (resultado === 'unauthorized') return responder(401, { ok: false, erro: 'não autorizado' });
  return responder(200, { ok: true, resultado });
}
