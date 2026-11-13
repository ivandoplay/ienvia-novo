'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { formatarMensagemPix, lerConfiguracaoPix } from '@ienvia/shared/recursos-pix';
import { gerarPngQrPix } from '@/lib/atendente/qr-pix';
import { enviarArquivo as enviarArquivoPelaEvolution, enviarTexto, type ResultadoDoEnvio as RespostaDaEvolution } from '@/lib/evolution/cliente';
import {
  DEPOSITO,
  LEGENDA_MAXIMA,
  caminhoDoEnvio,
  depositoDizQueJaExiste,
  ehCaminhoDoEnvio,
  ehTipoDeEnvio,
  limiteDoTipo,
  tamanhoLegivel,
  tipoParaEnvio,
  type TipoDeEnvio,
} from '@/lib/inbox/arquivos';
import { mapearAudiosEstrategicos, mapearCatalogo } from '@/lib/recursos/mapeamento';
import { trazerArquivoDaMensagem } from '@/lib/inbox/buscar-arquivo';
import { conferirEnsino, descreverEnsino, explicarRecusaDoEnsino, lerResultadoDoEnsino } from '@/lib/ia/ensino';
import { ehChaveDeEnvio, numeroParaEnvio, validarTexto, type SituacaoDoEnvio } from '@/lib/inbox/regras';
import { ehIdentificador } from '@/lib/instancias/regras';
import { obterSessao } from '@/lib/sessao';
import { enderecoDoDepositoParaONavegador } from '@/lib/supabase/deposito';
import { criarClienteDeServico } from '@/lib/supabase/servico';
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
  engine?: 'evolution' | 'baileys';
  command_id?: string;
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

  // 2b) Chip Baileys (Motor local): o envio já foi enfileirado atomicamente no banco para o aparelho local.
  if (mensagem.engine === 'baileys') {
    atualizarTelas();
    return { ok: true, mensagemId: mensagem.message_id, situacao: 'enviando' };
  }

  // 3) Uma única chamada à Evolution.
  const numero = numeroParaEnvio(mensagem.recipient);
  const resposta: RespostaDaEvolution =
    numero && mensagem.provider_instance_name
      ? await enviarTexto(mensagem.provider_instance_name, numero, mensagem.body_text ?? texto)
      : { situacao: 'nao_enviada', motivo: 'sem_whatsapp' };

  // 4) Conta ao banco como terminou.
  return terminarEnvio(contexto, mensagem.message_id, resposta);
}

/** Anota no banco como o envio terminou (texto ou arquivo) e monta a resposta para a tela. */
async function terminarEnvio(
  { supabase, workspaceId }: Contexto,
  mensagemId: string,
  resposta: RespostaDaEvolution,
  /** Aviso próprio para quando a mensagem com certeza não saiu (o padrão explica pelo motivo da Evolution). */
  avisoSeNaoSaiu?: string,
): Promise<ResultadoDoEnvio> {
  if (resposta.situacao === 'incerta') {
    console.error('[inbox] envio sem confirmação:', { mensagem: mensagemId, detalhe: resposta.detalhe });
  }

  const desfecho = resposta.situacao === 'enviada' ? 'sent' : resposta.situacao === 'nao_enviada' ? 'failed' : 'uncertain';
  const terminar = () =>
    supabase.rpc('finish_my_text_message', {
      p_workspace_id: workspaceId,
      p_message_id: mensagemId,
      p_outcome: desfecho,
      p_provider_message_id: resposta.situacao === 'enviada' ? resposta.idNoWhatsApp : null,
    });
  let fim = await terminar();
  if (fim.error) fim = await terminar();
  if (fim.error) {
    // A mensagem fica "enviando" no banco. Se ela saiu, o aviso da Evolution confirma sozinho;
    // se não, depois de um minuto a tela pede para a pessoa conferir.
    console.error('[inbox] não foi possível gravar como o envio terminou:', { mensagem: mensagemId, desfecho, erro: fim.error });
  }

  atualizarTelas();

  if (resposta.situacao === 'enviada') return { ok: true, mensagemId, situacao: 'enviada' };
  if (resposta.situacao === 'nao_enviada') {
    return { ok: true, mensagemId, situacao: 'falhou', aviso: avisoSeNaoSaiu ?? avisoDaFalha(resposta.motivo) };
  }
  // Sem aviso à parte: o próprio balão da mensagem explica e traz os botões "foi enviada" / "não foi enviada".
  return { ok: true, mensagemId, situacao: 'sem_confirmacao' };
}

/* -------------------------------------------------------------------------- */
/* Arquivos: foto, vídeo, áudio e documento                                   */
/* -------------------------------------------------------------------------- */

export type PreparoDoEnvio =
  | {
      ok: true;
      /** Onde o arquivo fica no depósito. */
      caminho: string;
      /** Endereço para o navegador subir o arquivo. `null` quando o arquivo deste envio já está lá. */
      endereco: string | null;
    }
  | { ok: false; erro: string };

const NOME_NO_DEPOSITO = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const NAO_FOI_POSSIVEL_PREPARAR = 'Não foi possível preparar o envio do arquivo. Atualize a página e tente de novo.';

/**
 * Primeiro passo para enviar um arquivo: o painel pede ao depósito, com a sessão de quem está logado,
 * um endereço de uso único para o navegador subir o arquivo direto para lá (o arquivo não passa pelo
 * servidor do painel). O depósito só assina se a pessoa participa da empresa dona da conversa.
 */
export async function prepararEnvioDeArquivo(dados: { conversaId: string; chave: string; nome: string }): Promise<PreparoDoEnvio> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados?.conversaId)) return { ok: false, erro: 'Esta conversa não existe mais. Atualize a página.' };
  if (!ehChaveDeEnvio(dados?.chave) || typeof dados.nome !== 'string' || !NOME_NO_DEPOSITO.test(dados.nome)) {
    return { ok: false, erro: ALGO_DEU_ERRADO };
  }

  const caminho = caminhoDoEnvio(contexto.workspaceId, dados.conversaId, dados.chave, dados.nome);
  const { data, error } = await contexto.supabase.storage.from(DEPOSITO).createSignedUploadUrl(caminho);
  if (error || !data?.signedUrl) {
    // Pedido repetido do mesmo envio: o arquivo já subiu, é só seguir adiante.
    if (depositoDizQueJaExiste(error as { statusCode?: unknown; message?: unknown } | null)) return { ok: true, caminho, endereco: null };
    console.error('[inbox] o depósito não liberou o envio de um arquivo:', { mensagem: error?.message });
    return { ok: false, erro: NAO_FOI_POSSIVEL_PREPARAR };
  }
  return { ok: true, caminho, endereco: enderecoDoDepositoParaONavegador(data.signedUrl) };
}

interface InicioDoEnvioDeArquivo extends InicioDoEnvio {
  object_key?: string;
  kind?: string;
  content_type?: string;
  byte_size?: number;
  file_name?: string | null;
  caption?: string | null;
}

/** Traduz a recusa do banco ao começar o envio de um arquivo. */
function motivoDaRecusaDoArquivo(mensagem: string, tipo: TipoDeEnvio): string {
  if (/media_not_uploaded/.test(mensagem)) return 'O arquivo não chegou ao painel. Tente de novo.';
  if (/media_too_large/.test(mensagem)) {
    return tipo === 'document'
      ? `Este arquivo passa de ${tamanhoLegivel(limiteDoTipo('document'))}, o máximo que o painel envia.`
      : `Foto, vídeo e áudio vão até ${tamanhoLegivel(limiteDoTipo(tipo))}. Acima disso, envie como documento.`;
  }
  if (/media_empty/.test(mensagem)) return 'Este arquivo está vazio.';
  if (/media_type_mismatch/.test(mensagem)) return 'O WhatsApp não mostra este formato como foto, vídeo ou áudio. Anexe de novo para enviar como documento.';
  if (/Invalid caption/.test(mensagem)) return `A legenda pode ter até ${LEGENDA_MAXIMA.toLocaleString('pt-BR')} letras. Áudio vai sem legenda.`;
  return motivoDaRecusa(mensagem);
}

/** Ler o arquivo no depósito não pode comer o tempo do envio. */
const TEMPO_LIMITE_PARA_LER_O_ARQUIVO = 12_000;

const comLimiteDeTempo = <T>(promessa: PromiseLike<T>, ms: number): Promise<T | null> =>
  new Promise((resolver) => {
    const relogio = setTimeout(() => resolver(null), ms);
    Promise.resolve(promessa).then(
      (valor) => {
        clearTimeout(relogio);
        resolver(valor);
      },
      () => {
        clearTimeout(relogio);
        resolver(null);
      },
    );
  });

const inteiro = (valor: unknown): number | null => (typeof valor === 'number' && Number.isInteger(valor) && valor >= 0 ? valor : null);

/**
 * Segundo passo: o arquivo já está no depósito (na pasta deste envio) e agora vira mensagem.
 * As garantias são as mesmas do texto: uma chave por envio, uma única chamada à Evolution, e
 * na dúvida a mensagem fica "sem confirmação" para a pessoa decidir.
 */
export async function enviarArquivo(dados: {
  conversaId: string;
  chave: string;
  caminho: string;
  tipo: TipoDeEnvio;
  /** Nome do arquivo como a pessoa escolheu (é o que o contato vê num documento). */
  nome: string;
  legenda: string | null;
  duracao?: number | null;
  largura?: number | null;
  altura?: number | null;
}): Promise<ResultadoDoEnvio> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados?.conversaId)) return { ok: false, erro: 'Esta conversa não existe mais. Atualize a página.' };
  if (!ehChaveDeEnvio(dados?.chave) || !ehTipoDeEnvio(dados.tipo)) return { ok: false, erro: ALGO_DEU_ERRADO };
  const { supabase, workspaceId } = contexto;
  if (!ehCaminhoDoEnvio(dados.caminho, workspaceId, dados.conversaId, dados.chave)) return { ok: false, erro: ALGO_DEU_ERRADO };

  const legenda = typeof dados.legenda === 'string' && dados.legenda.trim() ? dados.legenda.trim() : null;
  if (legenda && (legenda.length > LEGENDA_MAXIMA || dados.tipo === 'audio')) {
    return { ok: false, erro: motivoDaRecusaDoArquivo('Invalid caption', dados.tipo) };
  }
  const nome = typeof dados.nome === 'string' ? dados.nome.trim().slice(0, 200) : '';

  // 1) O banco confere que o arquivo está no depósito e guarda a mensagem como "enviando".
  const inicio = await supabase.rpc('start_my_media_message', {
    p_workspace_id: workspaceId,
    p_conversation_id: dados.conversaId,
    p_idempotency_key: dados.chave,
    p_object_key: dados.caminho,
    p_kind: dados.tipo,
    p_file_name: nome || null,
    p_caption: legenda,
    p_duration_seconds: inteiro(dados.duracao),
    p_width: inteiro(dados.largura),
    p_height: inteiro(dados.altura),
  });
  if (inicio.error || !inicio.data) {
    const mensagem = inicio.error?.message ?? '';
    const esperada =
      /conversation_closed|instance_|contact_unreachable|Conversation not found|Workspace membership|media_|Invalid caption/.test(mensagem);
    if (!esperada) console.error('[inbox] não foi possível começar o envio do arquivo:', inicio.error);
    // O arquivo em si é que não serve (grande, vazio, formato errado): ele sai do depósito, porque nunca vai virar mensagem.
    if (/media_too_large|media_empty|media_type_mismatch/.test(mensagem)) {
      const { error } = (await criarClienteDeServico()?.storage.from(DEPOSITO).remove([dados.caminho])) ?? { error: null };
      if (error) console.error('[inbox] não foi possível tirar do depósito um arquivo recusado:', { mensagem: error.message });
    }
    return { ok: false, erro: motivoDaRecusaDoArquivo(mensagem, dados.tipo) };
  }
  const mensagem = inicio.data as InicioDoEnvioDeArquivo;

  // 2) Pedido repetido: devolve o que já existe. Nada é enviado de novo.
  if (mensagem.already_exists) {
    return { ok: true, mensagemId: mensagem.message_id, situacao: situacaoPeloBanco(mensagem.status) };
  }

  // 2b) Chip Baileys (Motor local): o aparelho buscará o arquivo diretamente via /api/motor/midia.
  if (mensagem.engine === 'baileys') {
    atualizarTelas();
    return { ok: true, mensagemId: mensagem.message_id, situacao: 'enviando' };
  }

  // 3) O servidor lê o arquivo no depósito (com a sessão da pessoa)...
  const lido = await comLimiteDeTempo(supabase.storage.from(DEPOSITO).download(dados.caminho), TEMPO_LIMITE_PARA_LER_O_ARQUIVO);
  const bytes = lido && !lido.error && lido.data ? Buffer.from(await lido.data.arrayBuffer()) : null;
  const numero = numeroParaEnvio(mensagem.recipient);
  if (!bytes || bytes.length === 0) {
    console.error('[inbox] não foi possível ler no depósito o arquivo de um envio:', { mensagem: mensagem.message_id, erro: lido?.error?.message ?? 'demorou demais' });
    // Nada foi para a Evolution: com certeza não saiu.
    return terminarEnvio(
      contexto,
      mensagem.message_id,
      { situacao: 'nao_enviada', motivo: 'nao_configurada' },
      'O arquivo não foi enviado: o painel não conseguiu ler o arquivo guardado. Anexe e envie de novo.',
    );
  }

  // 4) ...e faz uma única chamada à Evolution.
  const resposta: RespostaDaEvolution =
    numero && mensagem.provider_instance_name
      ? await enviarArquivoPelaEvolution(mensagem.provider_instance_name, numero, {
          tipo: dados.tipo,
          dados: bytes,
          conteudo: mensagem.content_type ?? 'application/octet-stream',
          nome: mensagem.file_name ?? (nome || null),
          legenda: mensagem.caption ?? legenda,
        })
      : { situacao: 'nao_enviada', motivo: 'sem_whatsapp' };

  // 5) Conta ao banco como terminou.
  return terminarEnvio(contexto, mensagem.message_id, resposta);
}

/**
 * "Tentar de novo" num arquivo recebido que o painel não conseguiu trazer do WhatsApp.
 *
 * A busca usa a chave do servidor (é o servidor que fala com a Evolution e grava no depósito), então antes
 * o painel confere, com a sessão da pessoa, que ela enxerga aquela mensagem: se as regras do banco não
 * mostram a ficha do arquivo para ela, nada é feito.
 */
export async function buscarArquivo(dados: { mensagemId: string }): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const naoExiste: Resultado = { ok: false, erro: 'Esta mensagem não existe mais. Atualize a página.' };
  if (!ehIdentificador(dados?.mensagemId)) return naoExiste;

  const visivel = await contexto.supabase
    .from('message_attachments')
    .select('message_id')
    .eq('workspace_id', contexto.workspaceId)
    .eq('message_id', dados.mensagemId)
    .maybeSingle();
  if (visivel.error) {
    console.error('[inbox] não foi possível conferir o arquivo de uma mensagem:', visivel.error);
    return { ok: false, erro: ALGO_DEU_ERRADO };
  }
  if (!visivel.data) return naoExiste;

  const servico = criarClienteDeServico();
  if (!servico) return { ok: false, erro: 'Este ambiente não está configurado para buscar arquivos do WhatsApp.' };

  const desfecho = await trazerArquivoDaMensagem(servico, { workspaceId: contexto.workspaceId, mensagemId: dados.mensagemId });
  atualizarTelas();

  if (desfecho === 'guardado' || desfecho === 'ja_resolvido' || desfecho === 'grande_demais') return { ok: true };
  if (desfecho === 'em_andamento') return { ok: false, erro: 'O painel já está buscando este arquivo. Espere um instante.' };
  if (desfecho === 'indisponivel') {
    return { ok: false, erro: 'Não há mais de onde buscar este arquivo (o chip desta conversa foi removido). Ele continua no celular.' };
  }
  return {
    ok: false,
    erro: 'Não foi possível trazer este arquivo do WhatsApp agora. Confira se o chip está conectado e tente de novo; ele continua no celular.',
  };
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

/** assumir = a IA para de responder nesta conversa até alguém devolver; devolver = a IA volta a responder nela. */
const ACOES_DA_CONVERSA = { resolver: 'resolve', reabrir: 'reopen', marcar_lida: 'mark_read', assumir: 'claim', devolver: 'release' } as const;

export type AcaoDaConversa = keyof typeof ACOES_DA_CONVERSA;

function motivoDaAcao(mensagem: string): string {
  if (/another_open_conversation/.test(mensagem)) {
    return 'Este contato já tem uma conversa mais nova em aberto. Responda por ela (procure o contato na lista de ativas).';
  }
  if (/Conversation is not resolved/.test(mensagem)) return 'Esta conversa já está aberta. Atualize a página.';
  if (/assigned to another teammate/.test(mensagem)) return 'Esta conversa já foi assumida por outra pessoa da equipe.';
  if (/Conversation is not active/.test(mensagem)) return 'Esta conversa está resolvida. Reabra a conversa primeiro.';
  if (/Archived conversation/.test(mensagem)) return 'Esta conversa está arquivada.';
  if (/Conversation not found/.test(mensagem)) return 'Esta conversa não existe mais. Atualize a página.';
  if (/Workspace membership required/.test(mensagem)) return 'Você não participa mais desta empresa.';
  return ALGO_DEU_ERRADO;
}

/** Resolver, reabrir, marcar como lida, assumir a conversa ou devolver para a IA. */
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
    const esperada =
      /another_open_conversation|Conversation is not resolved|Archived conversation|Conversation not found|Workspace membership|another teammate|Conversation is not active/.test(
        error.message,
      );
    if (!esperada) console.error('[inbox] não foi possível mudar a conversa:', { acao, erro: error });
    return { ok: false, erro: motivoDaAcao(error.message) };
  }
  atualizarTelas();
  return { ok: true };
}

export type ResultadoDeEnsinar = { ok: true; texto: string } | { ok: false; erro: string };

/**
 * "Corrigir resposta em 1 clique": guarda no Treinamento o jeito certo de responder, a partir de uma
 * mensagem da conversa. Vira uma pergunta frequente ou uma regra de ouro da base que o chip usa.
 *
 * Só o dono da conta altera o treinamento (o banco confere de novo). Nada é enviado ao contato: isto
 * muda só o que a IA sabe, e vale a partir da próxima resposta dela.
 */
export async function ensinarIa(dados: { mensagemId: string; destino: string; pergunta: string; resposta: string }): Promise<ResultadoDeEnsinar> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados?.mensagemId)) return { ok: false, erro: 'Esta mensagem não existe mais. Atualize a página.' };
  const conferido = conferirEnsino(dados);
  if (!conferido.ok) return { ok: false, erro: conferido.erro };

  const { data, error } = await contexto.supabase.rpc('teach_my_ai_from_message', {
    p_workspace_id: contexto.workspaceId,
    p_message_id: dados.mensagemId,
    p_target: conferido.ensino.destino,
    p_question: conferido.ensino.pergunta,
    p_answer: conferido.ensino.resposta,
  });
  if (error) {
    const conhecido = explicarRecusaDoEnsino(error);
    if (!conhecido) console.error('[inbox] não foi possível ensinar a IA:', { codigo: error.code, mensagem: error.message });
    return { ok: false, erro: conhecido ?? ALGO_DEU_ERRADO };
  }

  revalidatePath('/treinamento');
  const resultado = lerResultadoDoEnsino(data);
  // O banco aceitou. Se a resposta dele vier num formato inesperado, o ensino está guardado do mesmo jeito.
  return { ok: true, texto: resultado ? descreverEnsino(resultado) : 'Guardado no Treinamento. A IA já usa na próxima resposta.' };
}

/* -------------------------------------------------------------------------- */
/* Fase 3 — CRM completo (contatos, negócio, notas, etiquetas, agendas, lote) */
/* -------------------------------------------------------------------------- */

function traduzirErroCrm(mensagem: string): string {
  if (/invalid_phone/.test(mensagem)) return 'Informe um número de WhatsApp válido (com DDD, ex: 86 99999-0000).';
  if (/invalid_name/.test(mensagem)) return 'Informe o nome do contato.';
  if (/invalid_crm_stage/.test(mensagem)) return 'Etapa do funil inválida.';
  if (/invalid_deal_status/.test(mensagem)) return 'Situação do negócio inválida.';
  if (/invalid_tag_name/.test(mensagem)) return 'Escreva o nome da etiqueta.';
  if (/tag_already_exists/.test(mensagem)) return 'Já existe uma etiqueta com esse nome.';
  if (/invalid_quick_reply/.test(mensagem)) return 'Preencha o atalho e o texto da resposta rápida.';
  if (/quick_reply_shortcut_exists/.test(mensagem)) return 'Já existe uma resposta rápida com este atalho.';
  if (/invalid_schedule_time/.test(mensagem)) return 'Escolha um horário futuro para o agendamento.';
  if (/instance_unavailable/.test(mensagem)) return 'Escolha um chip conectado ou ativo para iniciar a conversa.';
  if (/Contact not found/.test(mensagem)) return 'Contato não encontrado.';
  if (/Conversation not found/.test(mensagem)) return 'Conversa não encontrada.';
  if (/Tag not found/.test(mensagem)) return 'Etiqueta não encontrada.';
  if (/Scheduled message cannot be cancelled/.test(mensagem)) return 'Este agendamento já foi processado.';
  if (/Workspace membership required/.test(mensagem)) return 'Você não participa mais desta empresa.';
  return ALGO_DEU_ERRADO;
}

export async function salvarContato(dados: {
  contatoId?: string | null;
  nome: string;
  telefone?: string;
  email?: string;
  empresa?: string;
  documento?: string;
  cidade?: string;
  origem?: string;
  observacoes?: string;
  iaIgnorada?: boolean;
  bloqueado?: boolean;
}): Promise<{ ok: true; contatoId: string } | { ok: false; erro: string }> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (dados.contatoId && !ehIdentificador(dados.contatoId)) return { ok: false, erro: 'Contato inválido.' };
  const nome = dados.nome?.trim() ?? '';
  if (!nome && !dados.contatoId) return { ok: false, erro: 'Informe o nome do contato.' };

  const { data, error } = await contexto.supabase.rpc('save_my_contact', {
    p_workspace_id: contexto.workspaceId,
    p_contact_id: dados.contatoId ?? null,
    p_patch: {
      display_name: nome,
      phone: dados.telefone ?? null,
      email: dados.email ?? null,
      company: dados.empresa ?? null,
      document_id: dados.documento ?? null,
      city: dados.cidade ?? null,
      lead_source: dados.origem ?? null,
      notes: dados.observacoes ?? null,
      ...(typeof dados.iaIgnorada === 'boolean' ? { ai_ignored: dados.iaIgnorada } : {}),
      ...(typeof dados.bloqueado === 'boolean' ? { is_blocked: dados.bloqueado } : {}),
    },
  });
  if (error || !data) {
    return { ok: false, erro: traduzirErroCrm(error?.message ?? '') };
  }
  atualizarTelas();
  return { ok: true, contatoId: String((data as { id?: string }).id ?? dados.contatoId ?? '') };
}

export async function iniciarConversaManual(dados: {
  chipId: string;
  telefone: string;
  nome?: string | null;
}): Promise<{ ok: true; conversaId: string; contatoId: string; criada: boolean } | { ok: false; erro: string }> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.chipId)) return { ok: false, erro: 'Escolha um chip para enviar pelo WhatsApp.' };

  const { data, error } = await contexto.supabase.rpc('start_or_open_my_conversation', {
    p_workspace_id: contexto.workspaceId,
    p_instance_id: dados.chipId,
    p_phone: dados.telefone ?? '',
    p_display_name: dados.nome?.trim() || null,
  });
  if (error || !data) {
    return { ok: false, erro: traduzirErroCrm(error?.message ?? '') };
  }
  atualizarTelas();
  const res = data as { conversation_id: string; contact_id: string; created: boolean };
  return { ok: true, conversaId: res.conversation_id, contatoId: res.contact_id, criada: Boolean(res.created) };
}

export async function atualizarFlagsContato(dados: {
  contatoId: string;
  iaIgnorada?: boolean | null;
  bloqueado?: boolean | null;
}): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.contatoId)) return { ok: false, erro: 'Contato inválido.' };

  const { error } = await contexto.supabase.rpc('update_my_contact_flags', {
    p_workspace_id: contexto.workspaceId,
    p_contact_id: dados.contatoId,
    p_ai_ignored: typeof dados.iaIgnorada === 'boolean' ? dados.iaIgnorada : null,
    p_is_blocked: typeof dados.bloqueado === 'boolean' ? dados.bloqueado : null,
  });
  if (error) return { ok: false, erro: traduzirErroCrm(error.message) };
  atualizarTelas();
  return { ok: true };
}

export async function atualizarNegocioConversa(dados: {
  conversaId: string;
  etapaCrm?: string;
  valorNegocio?: number;
  situacaoNegocio?: 'open' | 'won' | 'lost';
  motivoPerda?: string;
  fixada?: boolean;
  retornoEm?: string | null;
  etapa?: 'resolved' | 'archived' | 'human';
}): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.conversaId)) return { ok: false, erro: 'Conversa inválida.' };

  const patch: Record<string, unknown> = {};
  if (dados.etapaCrm !== undefined) patch.crm_stage = dados.etapaCrm;
  if (dados.valorNegocio !== undefined) patch.deal_value = dados.valorNegocio;
  if (dados.situacaoNegocio !== undefined) patch.deal_status = dados.situacaoNegocio;
  if (dados.motivoPerda !== undefined) patch.deal_lost_reason = dados.motivoPerda;
  if (dados.fixada !== undefined) patch.is_pinned = dados.fixada;
  if (dados.retornoEm !== undefined) patch.follow_up_at = dados.retornoEm;
  if (dados.etapa !== undefined) patch.stage = dados.etapa;

  const { error } = await contexto.supabase.rpc('update_my_conversation_crm', {
    p_workspace_id: contexto.workspaceId,
    p_conversation_id: dados.conversaId,
    p_patch: patch,
  });
  if (error) return { ok: false, erro: traduzirErroCrm(error.message) };
  atualizarTelas();
  return { ok: true };
}

export async function aplicarAcaoEmLote(dados: {
  conversaIds: string[];
  acao: 'mark_read' | 'mark_unread' | 'resolve' | 'reopen' | 'archive' | 'unarchive' | 'set_crm_stage' | 'add_tag' | 'remove_tag';
  etapaCrm?: string;
  etiquetaId?: string;
}): Promise<{ ok: true; atualizadas: number } | { ok: false; erro: string }> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  const ids = dados.conversaIds.filter((id) => ehIdentificador(id));
  if (ids.length === 0) return { ok: false, erro: 'Selecione ao menos uma conversa.' };

  const { data, error } = await contexto.supabase.rpc('bulk_update_my_conversations', {
    p_workspace_id: contexto.workspaceId,
    p_conversation_ids: ids,
    p_action: dados.acao,
    p_payload: {
      ...(dados.etapaCrm ? { crm_stage: dados.etapaCrm } : {}),
      ...(dados.etiquetaId ? { tag_id: dados.etiquetaId } : {}),
    },
  });
  if (error) return { ok: false, erro: traduzirErroCrm(error.message) };
  atualizarTelas();
  return { ok: true, atualizadas: Number((data as { updated?: number } | null)?.updated ?? 0) };
}

export async function adicionarNotaConversa(dados: {
  conversaId: string;
  texto: string;
}): Promise<{ ok: true; notaId: string } | { ok: false; erro: string }> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.conversaId)) return { ok: false, erro: 'Conversa inválida.' };
  const limpo = dados.texto?.trim() ?? '';
  if (!limpo) return { ok: false, erro: 'Escreva a nota antes de salvar.' };

  const { data, error } = await contexto.supabase.rpc('add_my_conversation_note', {
    p_workspace_id: contexto.workspaceId,
    p_conversation_id: dados.conversaId,
    p_body_text: limpo,
  });
  if (error || !data) return { ok: false, erro: traduzirErroCrm(error?.message ?? '') };
  atualizarTelas();
  return { ok: true, notaId: String((data as { id?: string }).id ?? '') };
}

export async function salvarEtiquetaCrm(dados: {
  etiquetaId?: string | null;
  nome: string;
  cor: string;
}): Promise<{ ok: true; id: string } | { ok: false; erro: string }> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (dados.etiquetaId && !ehIdentificador(dados.etiquetaId)) return { ok: false, erro: 'Etiqueta inválida.' };

  const { data, error } = await contexto.supabase.rpc('save_my_crm_tag', {
    p_workspace_id: contexto.workspaceId,
    p_tag_id: dados.etiquetaId ?? null,
    p_name: dados.nome ?? '',
    p_color: dados.cor ?? '#64748b',
  });
  if (error || !data) return { ok: false, erro: traduzirErroCrm(error?.message ?? '') };
  atualizarTelas();
  return { ok: true, id: String((data as { id?: string }).id ?? '') };
}

export async function excluirEtiquetaCrm(dados: { etiquetaId: string }): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.etiquetaId)) return { ok: false, erro: 'Etiqueta inválida.' };

  const { error } = await contexto.supabase.rpc('delete_my_crm_tag', {
    p_workspace_id: contexto.workspaceId,
    p_tag_id: dados.etiquetaId,
  });
  if (error) return { ok: false, erro: traduzirErroCrm(error.message) };
  atualizarTelas();
  return { ok: true };
}

export async function alternarEtiquetaContato(dados: {
  contatoId: string;
  etiquetaId: string;
  marcar: boolean;
}): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.contatoId) || !ehIdentificador(dados.etiquetaId)) return { ok: false, erro: 'Dados inválidos.' };

  const { error } = await contexto.supabase.rpc('toggle_my_contact_tag', {
    p_workspace_id: contexto.workspaceId,
    p_contact_id: dados.contatoId,
    p_tag_id: dados.etiquetaId,
    p_attach: Boolean(dados.marcar),
  });
  if (error) return { ok: false, erro: traduzirErroCrm(error.message) };
  atualizarTelas();
  return { ok: true };
}

export async function salvarRespostaRapida(dados: {
  respostaId?: string | null;
  atalho: string;
  titulo: string;
  texto: string;
}): Promise<{ ok: true; id: string } | { ok: false; erro: string }> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (dados.respostaId && !ehIdentificador(dados.respostaId)) return { ok: false, erro: 'Resposta rápida inválida.' };

  const { data, error } = await contexto.supabase.rpc('save_my_quick_reply', {
    p_workspace_id: contexto.workspaceId,
    p_reply_id: dados.respostaId ?? null,
    p_shortcut: dados.atalho ?? '',
    p_title: dados.titulo ?? '',
    p_body_text: dados.texto ?? '',
  });
  if (error || !data) return { ok: false, erro: traduzirErroCrm(error?.message ?? '') };
  atualizarTelas();
  return { ok: true, id: String((data as { id?: string }).id ?? '') };
}

export async function excluirRespostaRapida(dados: { respostaId: string }): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.respostaId)) return { ok: false, erro: 'Resposta rápida inválida.' };

  const { error } = await contexto.supabase.rpc('delete_my_quick_reply', {
    p_workspace_id: contexto.workspaceId,
    p_reply_id: dados.respostaId,
  });
  if (error) return { ok: false, erro: traduzirErroCrm(error.message) };
  atualizarTelas();
  return { ok: true };
}

export async function agendarMensagem(dados: {
  conversaId: string;
  texto: string;
  paraQuandoIso: string;
}): Promise<{ ok: true; id: string } | { ok: false; erro: string }> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.conversaId)) return { ok: false, erro: 'Conversa inválida.' };
  const texto = validarTexto(dados.texto);
  if (!texto) return { ok: false, erro: 'Escreva a mensagem (até 4.096 letras).' };
  const data = new Date(dados.paraQuandoIso);
  if (Number.isNaN(data.getTime())) return { ok: false, erro: 'Escolha uma data e hora válidas.' };

  const { data: gravado, error } = await contexto.supabase.rpc('schedule_my_message', {
    p_workspace_id: contexto.workspaceId,
    p_conversation_id: dados.conversaId,
    p_body_text: texto,
    p_scheduled_for: data.toISOString(),
  });
  if (error || !gravado) return { ok: false, erro: traduzirErroCrm(error?.message ?? '') };
  atualizarTelas();
  return { ok: true, id: String((gravado as { id?: string }).id ?? '') };
}

export async function cancelarMensagemAgendada(dados: { agendamentoId: string }): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.agendamentoId)) return { ok: false, erro: 'Agendamento inválido.' };

  const { error } = await contexto.supabase.rpc('cancel_my_scheduled_message', {
    p_workspace_id: contexto.workspaceId,
    p_scheduled_id: dados.agendamentoId,
  });
  if (error) return { ok: false, erro: traduzirErroCrm(error.message) };
  atualizarTelas();
  return { ok: true };
}

export async function apagarContatoEConversa(dados: { contatoId: string }): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.contatoId)) return { ok: false, erro: 'Contato inválido.' };

  const { data, error } = await contexto.supabase.rpc('delete_my_contact_and_conversation', {
    p_workspace_id: contexto.workspaceId,
    p_contact_id: dados.contatoId,
  });
  if (error || !data) return { ok: false, erro: traduzirErroCrm(error?.message ?? '') };

  const chaves = ((data as { object_keys?: unknown } | null)?.object_keys ?? []) as string[];
  if (Array.isArray(chaves) && chaves.length > 0) {
    const validas = chaves.filter(
      (c) =>
        typeof c === 'string' &&
        c.startsWith(`${contexto.workspaceId}/`) &&
        !c.startsWith(`${contexto.workspaceId}/catalogo/`) &&
        !c.startsWith(`${contexto.workspaceId}/audios/`) &&
        !c.startsWith(`${contexto.workspaceId}/campanhas/`),
    );
    if (validas.length > 0) {
      await criarClienteDeServico()?.storage.from(DEPOSITO).remove(validas);
    }
  }
  atualizarTelas();
  return { ok: true };
}

async function enviarRecursoDoWorkspaceNaConversa(
  contexto: Contexto,
  dados: {
    conversaId: string;
    chave: string;
    caminho: string;
    tipo: 'image' | 'audio' | 'document';
    nome: string | null;
    legenda: string | null;
    duracao?: number | null;
    voz?: boolean;
    sentVoiceId?: string | null;
    dadosEmMemoria?: Buffer;
    conteudoEmMemoria?: string;
  },
): Promise<ResultadoDoEnvio> {
  const { supabase, workspaceId } = contexto;
  const inicio = await supabase.rpc('start_my_workspace_resource_message', {
    p_workspace_id: workspaceId,
    p_conversation_id: dados.conversaId,
    p_idempotency_key: dados.chave,
    p_object_key: dados.caminho,
    p_kind: dados.tipo,
    p_file_name: dados.nome,
    p_caption: dados.legenda,
    p_duration_seconds: inteiro(dados.duracao ?? null),
    p_is_voice: dados.tipo === 'audio' ? dados.voz !== false : false,
    p_sent_voice_id: dados.sentVoiceId ?? null,
  });

  if (inicio.error || !inicio.data) {
    const mensagem = inicio.error?.message ?? '';
    return { ok: false, erro: motivoDaRecusaDoArquivo(mensagem, dados.tipo) };
  }

  const mensagem = inicio.data as InicioDoEnvioDeArquivo;
  if (mensagem.already_exists) {
    return { ok: true, mensagemId: mensagem.message_id, situacao: situacaoPeloBanco(mensagem.status) };
  }
  if (mensagem.engine === 'baileys') {
    atualizarTelas();
    return { ok: true, mensagemId: mensagem.message_id, situacao: 'enviando' };
  }

  let bytes = dados.dadosEmMemoria ?? null;
  if (!bytes) {
    const lido = await comLimiteDeTempo(supabase.storage.from(DEPOSITO).download(dados.caminho), TEMPO_LIMITE_PARA_LER_O_ARQUIVO);
    bytes = lido && !lido.error && lido.data ? Buffer.from(await lido.data.arrayBuffer()) : null;
  }

  const numero = numeroParaEnvio(mensagem.recipient);
  if (!bytes || bytes.length === 0) {
    return terminarEnvio(
      contexto,
      mensagem.message_id,
      { situacao: 'nao_enviada', motivo: 'nao_configurada' },
      'Não foi possível ler o arquivo no depósito para envio.',
    );
  }

  const resposta: RespostaDaEvolution =
    numero && mensagem.provider_instance_name
      ? await enviarArquivoPelaEvolution(mensagem.provider_instance_name, numero, {
          tipo: dados.tipo,
          dados: bytes,
          conteudo: dados.conteudoEmMemoria ?? mensagem.content_type ?? 'application/octet-stream',
          nome: mensagem.file_name ?? dados.nome,
          legenda: mensagem.caption ?? dados.legenda,
          voz: dados.voz,
        })
      : { situacao: 'nao_enviada', motivo: 'sem_whatsapp' };

  return terminarEnvio(contexto, mensagem.message_id, resposta);
}

export async function enviarPixNaConversa(dados: {
  conversaId: string;
  valor?: string | null;
}): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.conversaId)) return { ok: false, erro: 'Conversa inválida.' };

  const { data: pixData, error: pixErr } = await contexto.supabase.rpc('read_my_pix_settings', {
    p_workspace_id: contexto.workspaceId,
  });
  if (pixErr) return { ok: false, erro: 'Não foi possível ler a configuração do PIX.' };
  const pix = lerConfiguracaoPix(pixData);
  const formatado = formatarMensagemPix(pix, dados.valor ?? null);
  if (!formatado) return { ok: false, erro: 'Configure e ative uma chave PIX em Catálogo & PIX antes de enviar.' };

  const baseChave = `pix_${randomUUID().replace(/-/g, '')}`;
  const resResumo = await enviarMensagem({
    conversaId: dados.conversaId,
    chave: `${baseChave}_sum`,
    texto: formatado.summaryText,
  });
  if (!resResumo.ok) return { ok: false, erro: resResumo.erro };

  if (formatado.sendQrImage) {
    try {
      const pngBuffer = await gerarPngQrPix(formatado.qrBrcode);
      const qrChave = `${baseChave}_qr`;
      const caminhoQr = caminhoDoEnvio(contexto.workspaceId, dados.conversaId, qrChave, 'pix-qrcode.png');
      const { error: upErr } = await contexto.supabase.storage
        .from(DEPOSITO)
        .upload(caminhoQr, pngBuffer, { contentType: 'image/png', upsert: true });
      if (!upErr) {
        const resQr = await enviarRecursoDoWorkspaceNaConversa(contexto, {
          conversaId: dados.conversaId,
          chave: qrChave,
          caminho: caminhoQr,
          tipo: 'image',
          nome: 'pix-qrcode.png',
          legenda: null,
          dadosEmMemoria: pngBuffer,
          conteudoEmMemoria: 'image/png',
        });
        if (!resQr.ok) return { ok: false, erro: resQr.erro };
      }
    } catch {
      // Segue para enviar ao menos o Copia e Cola
    }
  }

  if (formatado.brcode) {
    const resBrc = await enviarMensagem({
      conversaId: dados.conversaId,
      chave: `${baseChave}_brc`,
      texto: formatado.brcode,
    });
    if (!resBrc.ok) return { ok: false, erro: resBrc.erro };
  }

  return { ok: true };
}

export async function enviarAudioEstrategicoNaConversa(dados: {
  conversaId: string;
  voiceId: string;
}): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.conversaId) || !ehIdentificador(dados.voiceId)) {
    return { ok: false, erro: 'Áudio ou conversa inválida.' };
  }

  const { data: audiosData, error } = await contexto.supabase.rpc('list_my_voice_library', {
    p_workspace_id: contexto.workspaceId,
  });
  if (error) return { ok: false, erro: 'Não foi possível carregar a biblioteca de áudios.' };
  const audio = mapearAudiosEstrategicos(audiosData).find((a) => a.id === dados.voiceId);
  if (!audio) return { ok: false, erro: 'Áudio não encontrado na biblioteca.' };

  const res = await enviarRecursoDoWorkspaceNaConversa(contexto, {
    conversaId: dados.conversaId,
    chave: `aud_${randomUUID().replace(/-/g, '')}`,
    caminho: audio.objectKey,
    tipo: 'audio',
    nome: audio.fileName,
    legenda: null,
    duracao: audio.durationSec,
    voz: true,
    sentVoiceId: audio.id,
  });
  if (!res.ok) return { ok: false, erro: res.erro };
  if (res.aviso) return { ok: false, erro: res.aviso };
  return { ok: true };
}

export async function enviarItemCatalogoNaConversa(dados: {
  conversaId: string;
  itemId: string;
}): Promise<Resultado> {
  const contexto = await abrirContexto();
  if ('erro' in contexto) return { ok: false, erro: contexto.erro };
  if (!ehIdentificador(dados.conversaId) || !ehIdentificador(dados.itemId)) {
    return { ok: false, erro: 'Item do catálogo ou conversa inválida.' };
  }

  const { data: catData, error } = await contexto.supabase.rpc('list_my_catalog_items', {
    p_workspace_id: contexto.workspaceId,
  });
  if (error) return { ok: false, erro: 'Não foi possível carregar o catálogo.' };
  const item = mapearCatalogo(catData).find((i) => i.id === dados.itemId);
  if (!item) return { ok: false, erro: 'Item não encontrado no catálogo.' };

  const baseChave = `cat_${randomUUID().replace(/-/g, '')}`;
  const linhas = [
    `*${item.name}*`,
    item.price.trim() ? `*Preço:* R$ ${item.price.trim()}` : '',
    item.description.trim() || '',
    item.paymentLink.trim() ? `*Link:* ${item.paymentLink.trim()}` : '',
  ].filter(Boolean);

  const resTexto = await enviarMensagem({
    conversaId: dados.conversaId,
    chave: `${baseChave}_txt`,
    texto: linhas.join('\n').slice(0, 4096),
  });
  if (!resTexto.ok) return { ok: false, erro: resTexto.erro };

  for (const [idx, arq] of item.files.entries()) {
    const tipoWa = tipoParaEnvio(arq.contentType);
    const kind = tipoWa === 'image' ? 'image' : 'document';
    const resArq = await enviarRecursoDoWorkspaceNaConversa(contexto, {
      conversaId: dados.conversaId,
      chave: `${baseChave}_f${idx}`,
      caminho: arq.objectKey,
      tipo: kind,
      nome: arq.fileName,
      legenda: null,
      voz: false,
    });
    if (!resArq.ok) return { ok: false, erro: resArq.erro };
  }

  return { ok: true };
}
