'use server';

import { revalidatePath } from 'next/cache';
import { enviarTexto, type ResultadoDoEnvio as RespostaDaEvolution } from '@/lib/evolution/cliente';
import { ehChaveDeEnvio, numeroParaEnvio, validarTexto, type SituacaoDoEnvio } from '@/lib/inbox/regras';
import { ehIdentificador } from '@/lib/instancias/regras';
import { obterSessao } from '@/lib/sessao';
import { criarClienteServidor } from '@/lib/supabase/servidor';

/**
 * Ações da Inbox. Todas rodam no servidor, com a sessão de quem está logado: o banco confere de novo
 * se a pessoa participa da empresa antes de aceitar qualquer coisa. Qualquer pessoa ativa da empresa
 * pode responder; mexer nos chips continua sendo só do dono.
 *
 * Regra de ouro do envio: o painel NUNCA manda a mesma mensagem duas vezes por conta própria.
 * Quando não dá para saber se a mensagem saiu, ela fica "sem confirmação" e quem decide é a pessoa.
 */

export type Resultado = { ok: true } | { ok: false; erro: string };

export type ResultadoDoEnvio =
  | {
      ok: true;
      mensagemId: string;
      situacao: SituacaoDoEnvio;
      /** Por que a mensagem não saiu (só quando a situação é "falhou"). */
      aviso?: string;
    }
  | { ok: false; erro: string };

type Supabase = Awaited<ReturnType<typeof criarClienteServidor>>;

interface Contexto {
  supabase: Supabase;
  workspaceId: string;
}

const SESSAO_EXPIRADA = 'Sua sessão expirou. Entre de novo.';
const ALGO_DEU_ERRADO = 'Algo deu errado do nosso lado. Tente de novo em instantes.';

async function abrirContexto(): Promise<Contexto | { erro: string }> {
  const sessao = await obterSessao();
  if (!sessao?.workspaceAtivo) return { erro: SESSAO_EXPIRADA };
  return { supabase: await criarClienteServidor(), workspaceId: sessao.workspaceAtivo.id };
}

function atualizarTelas(): void {
  revalidatePath('/inbox');
  revalidatePath('/visao-geral');
}

/** Traduz a recusa do banco ao começar um envio. */
function motivoDaRecusa(mensagem: string): string {
  if (/conversation_closed/.test(mensagem)) return 'Esta conversa está resolvida. Reabra a conversa para responder.';
  if (/instance_not_connected/.test(mensagem)) return 'O chip desta conversa está desconectado. Reconecte em Instâncias e envie de novo.';
  if (/instance_unavailable/.test(mensagem)) return 'O chip desta conversa foi removido. Dá para ler a conversa, mas não para responder por ela.';
  if (/contact_unreachable/.test(mensagem)) return 'Não dá para responder a este contato: o número dele não está mais disponível.';
  if (/Conversation not found/.test(mensagem)) return 'Esta conversa não existe mais. Atualize a página.';
  if (/Invalid message text/.test(mensagem)) return 'Escreva a mensagem (até 4.096 letras).';
  if (/Workspace membership required/.test(mensagem)) return 'Você não participa mais desta empresa.';
  return ALGO_DEU_ERRADO;
}

function situacaoPeloBanco(status: string): SituacaoDoEnvio {
  if (status === 'failed' || status === 'cancelled') return 'falhou';
  if (status === 'awaiting_human_confirmation') return 'sem_confirmacao';
  if (status === 'sending' || status === 'queued') return 'enviando';
  return 'enviada';
}

function avisoDaFalha(motivo: Extract<RespostaDaEvolution, { situacao: 'nao_enviada' }>['motivo']): string {
  if (motivo === 'sem_whatsapp') return 'A mensagem não foi enviada: este número não tem WhatsApp.';
  if (motivo === 'chip_nao_encontrado') return 'A mensagem não foi enviada: o chip desta conversa não existe mais na Evolution. Confira em Instâncias.';
  return 'A mensagem não foi enviada: a conexão com a Evolution não está configurada direito neste ambiente.';
}

interface InicioDoEnvio {
  message_id: string;
  status: string;
  already_exists: boolean;
  provider_instance_name?: string;
  recipient?: string;
  body_text?: string;
}

/**
 * Envia um texto numa conversa.
 *
 * `chave` é criada no navegador, uma por mensagem. Se o mesmo pedido chegar duas vezes (clique duplo,
 * conexão que caiu e a pessoa tentou de novo), o banco reconhece a chave e devolve a mensagem que já
 * existe: a Evolution só é chamada uma vez por chave.
 */
export async function enviarMensagem(dados: { conversaId: string; texto: string; chave: string }): Promise<ResultadoDoEnvio> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };

  const texto = validarTexto(dados?.texto);
  if (!ehIdentificador(dados?.conversaId)) return { ok: false, erro: 'Esta conversa não existe mais. Atualize a página.' };
  if (!texto) return { ok: false, erro: 'Escreva a mensagem (até 4.096 letras).' };
  if (!ehChaveDeEnvio(dados?.chave)) return { ok: false, erro: ALGO_DEU_ERRADO };

  const { supabase, workspaceId } = contexto;

  // 1) O banco guarda a mensagem como "enviando" (e recusa se a conversa ou o chip não permitem).
  const inicio = await supabase.rpc('start_my_text_message', {
    p_workspace_id: workspaceId,
    p_conversation_id: dados.conversaId,
    p_body_text: texto,
    p_idempotency_key: dados.chave,
  });
  if (inicio.error || !inicio.data) {
    const mensagem = inicio.error?.message ?? '';
    const esperada = /conversation_closed|instance_|contact_unreachable|Conversation not found|Invalid message text|Workspace membership/.test(mensagem);
    if (!esperada) console.error('[inbox] não foi possível começar o envio:', inicio.error);
    return { ok: false, erro: motivoDaRecusa(mensagem) };
  }
  const mensagem = inicio.data as InicioDoEnvio;

  // 2) Pedido repetido: devolve o que já existe. Nada é enviado de novo.
  if (mensagem.already_exists) {
    return { ok: true, mensagemId: mensagem.message_id, situacao: situacaoPeloBanco(mensagem.status) };
  }

  // 3) Uma única chamada à Evolution.
  const numero = numeroParaEnvio(mensagem.recipient);
  const resposta: RespostaDaEvolution =
    numero && mensagem.provider_instance_name
      ? await enviarTexto(mensagem.provider_instance_name, numero, mensagem.body_text ?? texto)
      : { situacao: 'nao_enviada', motivo: 'sem_whatsapp' };

  if (resposta.situacao === 'incerta') {
    console.error('[inbox] envio sem confirmação:', { mensagem: mensagem.message_id, detalhe: resposta.detalhe });
  }

  // 4) Conta ao banco como terminou.
  const desfecho = resposta.situacao === 'enviada' ? 'sent' : resposta.situacao === 'nao_enviada' ? 'failed' : 'uncertain';
  const terminar = () =>
    supabase.rpc('finish_my_text_message', {
      p_workspace_id: workspaceId,
      p_message_id: mensagem.message_id,
      p_outcome: desfecho,
      p_provider_message_id: resposta.situacao === 'enviada' ? resposta.idNoWhatsApp : null,
    });
  let fim = await terminar();
  if (fim.error) fim = await terminar();
  if (fim.error) {
    // A mensagem fica "enviando" no banco. Se ela saiu, o aviso da Evolution confirma sozinho;
    // se não, depois de um minuto a tela pede para a pessoa conferir.
    console.error('[inbox] não foi possível gravar como o envio terminou:', { mensagem: mensagem.message_id, desfecho, erro: fim.error });
  }

  atualizarTelas();

  if (resposta.situacao === 'enviada') return { ok: true, mensagemId: mensagem.message_id, situacao: 'enviada' };
  if (resposta.situacao === 'nao_enviada') {
    return { ok: true, mensagemId: mensagem.message_id, situacao: 'falhou', aviso: avisoDaFalha(resposta.motivo) };
  }
  // Sem aviso à parte: o próprio balão da mensagem explica e traz os botões "foi enviada" / "não foi enviada".
  return { ok: true, mensagemId: mensagem.message_id, situacao: 'sem_confirmacao' };
}

/**
 * A pessoa conferiu no WhatsApp e conta se uma mensagem "sem confirmação" foi mesmo enviada ou não.
 * Isso só muda a anotação no painel: nada é enviado.
 */
export async function decidirEnvio(dados: { mensagemId: string; foiEnviada: boolean }): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados?.mensagemId) || typeof dados.foiEnviada !== 'boolean') {
    return { ok: false, erro: 'Esta mensagem não existe mais. Atualize a página.' };
  }

  const { error } = await contexto.supabase.rpc('finish_my_text_message', {
    p_workspace_id: contexto.workspaceId,
    p_message_id: dados.mensagemId,
    p_outcome: dados.foiEnviada ? 'sent' : 'failed',
    p_provider_message_id: null,
  });
  if (error) {
    if (/Message not found/.test(error.message)) return { ok: false, erro: 'Esta mensagem não existe mais. Atualize a página.' };
    console.error('[inbox] não foi possível anotar a decisão sobre o envio:', error);
    return { ok: false, erro: ALGO_DEU_ERRADO };
  }
  atualizarTelas();
  return { ok: true };
}

const ACOES_DA_CONVERSA = { resolver: 'resolve', reabrir: 'reopen', marcar_lida: 'mark_read' } as const;

export type AcaoDaConversa = keyof typeof ACOES_DA_CONVERSA;

function motivoDaAcao(mensagem: string): string {
  if (/another_open_conversation/.test(mensagem)) {
    return 'Este contato já tem uma conversa mais nova em aberto. Responda por ela (procure o contato na lista de ativas).';
  }
  if (/Conversation is not resolved/.test(mensagem)) return 'Esta conversa já está aberta. Atualize a página.';
  if (/Archived conversation/.test(mensagem)) return 'Esta conversa está arquivada.';
  if (/Conversation not found/.test(mensagem)) return 'Esta conversa não existe mais. Atualize a página.';
  if (/Workspace membership required/.test(mensagem)) return 'Você não participa mais desta empresa.';
  return ALGO_DEU_ERRADO;
}

/** Resolver, reabrir ou marcar como lida. */
export async function mudarConversa(dados: { conversaId: string; acao: AcaoDaConversa }): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const acao = typeof dados?.acao === 'string' && Object.hasOwn(ACOES_DA_CONVERSA, dados.acao) ? ACOES_DA_CONVERSA[dados.acao] : null;
  if (!acao || !ehIdentificador(dados?.conversaId)) return { ok: false, erro: 'Esta conversa não existe mais. Atualize a página.' };

  const { error } = await contexto.supabase.rpc('transition_workspace_conversation', {
    p_workspace_id: contexto.workspaceId,
    p_conversation_id: dados.conversaId,
    p_action: acao,
  });
  if (error) {
    const esperada = /another_open_conversation|Conversation is not resolved|Archived conversation|Conversation not found|Workspace membership/.test(error.message);
    if (!esperada) console.error('[inbox] não foi possível mudar a conversa:', { acao, erro: error });
    return { ok: false, erro: motivoDaAcao(error.message) };
  }
  atualizarTelas();
  return { ok: true };
}
