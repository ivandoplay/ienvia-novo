import 'server-only';

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buscarArquivoDaMensagem } from '@/lib/evolution/cliente';
import { DEPOSITO, LIMITE_PARA_GUARDAR, limparTipoDeConteudo } from '@/lib/inbox/arquivos';

/**
 * Traz para o depósito do painel o arquivo (foto, áudio, vídeo, documento, figurinha) de uma mensagem
 * que chegou pelo WhatsApp. Roda só no servidor, com a chave do servidor:
 *
 *   1. o banco reserva a vez (dois pedidos nunca baixam o mesmo arquivo juntos) e diz de onde baixar;
 *   2. a Evolution baixa do WhatsApp e devolve o arquivo;
 *   3. o arquivo vai para o depósito fechado, no caminho que o banco escolheu;
 *   4. o banco anota como terminou — e é isso que faz as telas abertas mostrarem o arquivo.
 *
 * Quem chama: o aviso da Evolution (logo que a mensagem chega) e o botão "tentar de novo" da conversa.
 */

/**
 *   guardado      — o arquivo está no depósito;
 *   grande_demais — passou do tamanho que o painel guarda;
 *   falhou        — não deu para trazer agora (dá para tentar de novo);
 *   em_andamento  — outro pedido está trazendo este mesmo arquivo neste momento;
 *   ja_resolvido  — não havia nada a fazer (já guardado, ou já marcado como grande demais);
 *   indisponivel  — não há de onde trazer (o chip foi removido, ou a mensagem não tem arquivo).
 */
export type DesfechoDaBusca = 'guardado' | 'grande_demais' | 'falhou' | 'em_andamento' | 'ja_resolvido' | 'indisponivel';

/** O que identifica a mensagem para a Evolution (ver `buscarArquivoDaMensagem`). */
export interface MensagemParaBuscar {
  key: Record<string, unknown>;
  message?: unknown;
}

interface Reserva {
  claimed?: boolean;
  reason?: string;
  object_key?: string;
  content_type?: string;
  provider_instance_name?: string;
  provider_message_id?: string;
  remote_jid?: string;
  from_me?: boolean;
}

export async function trazerArquivoDaMensagem(
  servico: SupabaseClient,
  alvo: { workspaceId: string; mensagemId: string },
  /** O aviso original da Evolution, quando há. Sem ele, a Evolution procura a mensagem no próprio histórico. */
  mensagemDoAviso: MensagemParaBuscar | null = null,
): Promise<DesfechoDaBusca> {
  const onde = { mensagem: alvo.mensagemId };

  const reserva = await servico.rpc('begin_media_download', { p_workspace_id: alvo.workspaceId, p_message_id: alvo.mensagemId });
  if (reserva.error) {
    console.error('[arquivo] o banco não reservou a busca:', { ...onde, codigo: reserva.error.code, mensagem_do_erro: reserva.error.message });
    return 'falhou';
  }
  const dados = (reserva.data ?? {}) as Reserva;
  if (dados.claimed !== true) {
    if (dados.reason === 'in_progress') return 'em_andamento';
    if (dados.reason === 'stored' || dados.reason === 'too_large') return 'ja_resolvido';
    return 'indisponivel';
  }

  const terminar = async (desfecho: 'stored' | 'failed' | 'too_large', arquivo?: { conteudo: string; tamanho: number; resumo: string }) => {
    const { error } = await servico.rpc('complete_media_download', {
      p_workspace_id: alvo.workspaceId,
      p_message_id: alvo.mensagemId,
      p_outcome: desfecho,
      p_content_type: arquivo?.conteudo ?? null,
      p_byte_size: arquivo?.tamanho ?? null,
      p_sha256_hex: arquivo?.resumo ?? null,
    });
    if (error) console.error('[arquivo] o banco não anotou como a busca terminou:', { ...onde, desfecho, codigo: error.code, mensagem_do_erro: error.message });
    return !error;
  };

  try {
    if (!dados.provider_instance_name || !dados.provider_message_id || !dados.object_key) {
      await terminar('failed');
      return 'indisponivel';
    }

    const mensagem: MensagemParaBuscar = mensagemDoAviso ?? {
      key: { id: dados.provider_message_id, remoteJid: dados.remote_jid ?? null, fromMe: dados.from_me === true },
    };
    const buscado = await buscarArquivoDaMensagem(dados.provider_instance_name, mensagem);
    if (!buscado.ok) {
      console.error('[arquivo] a Evolution não entregou o arquivo:', { ...onde, detalhe: buscado.detalhe });
      await terminar('failed');
      return 'falhou';
    }

    if (buscado.dados.length > LIMITE_PARA_GUARDAR) {
      await terminar('too_large');
      return 'grande_demais';
    }

    // O tipo que a Evolution informa junto com o arquivo vale mais que o do aviso; sem nenhum, o genérico.
    const informado = limparTipoDeConteudo(buscado.conteudo);
    const conteudo = informado !== 'application/octet-stream' ? informado : limparTipoDeConteudo(dados.content_type);

    const guardar = await servico.storage.from(DEPOSITO).upload(dados.object_key, buscado.dados, {
      contentType: conteudo,
      cacheControl: '3600',
      // Uma segunda tentativa pode encontrar o arquivo da primeira já lá: é o mesmo, pode ficar por cima.
      upsert: true,
    });
    if (guardar.error) {
      console.error('[arquivo] o depósito não guardou o arquivo:', { ...onde, mensagem_do_erro: guardar.error.message });
      await terminar('failed');
      return 'falhou';
    }

    const anotado = await terminar('stored', {
      conteudo,
      tamanho: buscado.dados.length,
      resumo: createHash('sha256').update(buscado.dados).digest('hex'),
    });
    return anotado ? 'guardado' : 'falhou';
  } catch (erro) {
    console.error('[arquivo] erro inesperado ao trazer o arquivo:', { ...onde, erro: erro instanceof Error ? erro.message : String(erro) });
    await terminar('failed').catch(() => false);
    return 'falhou';
  }
}
