import 'server-only';

import { Buffer } from 'node:buffer';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enviarAlertaViaRpc } from '@/lib/atendente/alertas';
import { montarDossieParaAdmin } from '@/lib/atendente/dossie';
import {
  cortarRecado,
  dividirResposta,
  escolherArquivo,
  instrucaoDaAbertura,
  lerArquivoDoHistorico,
  lerHistorico,
  mensagensPendentes,
  montarConversa,
  porQueNaoDaParaLer,
  tempoDeDigitacao,
  LIMITE_DO_ARQUIVO_PARA_A_IA,
  type ArquivoDoHistorico,
  type MensagemDoHistorico,
} from '@/lib/atendente/regras';
import { enviarTexto, type ResultadoDoEnvio } from '@/lib/evolution/cliente';
import { contextoDaChaveDeIa, decifrar, lerChaveDoCofre } from '@/lib/ia/cofre';
import { lerResposta, montarInstrucoes } from '@/lib/ia/instrucoes';
import { ErroDeIa, gerarResposta, type AnexoParaIa, type RespostaDeIa } from '@/lib/ia/provedores';
import {
  NOME_DO_PROVEDOR,
  PROVEDORES,
  doProvedor,
  explicarErroDeIa,
  lerMotor,
  modeloDoProvedor,
  ordemDeUso,
  provedorRecebe,
  type ConfiguracaoDoMotor,
  type EventoDeAlertaDoAdmin,
  type MotivoDoErroDeIa,
  type Provedor,
} from '@/lib/ia/regras';
import { lerBase } from '@/lib/ia/treinamento';
import { DEPOSITO } from '@/lib/inbox/arquivos';
import { numeroParaEnvio } from '@/lib/inbox/regras';

/**
 * O atendente de IA: responde, no WhatsApp, uma mensagem que chegou.
 *
 * O caminho de uma resposta:
 *   1. espera o cliente terminar de escrever (o tempo configurado no Motor de IA);
 *   2. pega a vez no banco — só um pedido consegue, e só se a IA ainda pode responder naquela conversa;
 *   3. monta as instruções com a base de treinamento e pede a resposta ao provedor (com as reservas);
 *   4. lê os comandos da resposta (passar para uma pessoa, ficar em silêncio, encerrar...);
 *   5. envia pela Evolution, um balão de cada vez, conferindo no banco antes de cada um;
 *   6. conta ao banco como terminou.
 *
 * Regras que não se quebram:
 *   - NUNCA reenvia. Se não dá para saber se um balão saiu, ele fica "sem confirmação" e a conversa vai para uma pessoa.
 *   - Tudo o que dá errado termina com a conversa em "Esperando você" e um recado claro. Nada fica perdido em silêncio.
 *   - A chave de cada cliente só é aberta aqui, na hora de usar, e nunca vai para um registro.
 */

/** Quanto tempo um pedido tem, no total, para esperar, pedir a resposta e enviar. */
const ORCAMENTO_PADRAO = 55_000;
/** Tempo guardado para enviar a resposta depois que o provedor responde. */
const RESERVA_PARA_ENVIAR = 10_000;
/** Menos que isto não dá para um provedor responder; nem tenta. */
const TEMPO_MINIMO_DA_IA = 4_000;
/** O máximo que se espera de um provedor numa conversa de verdade. */
const TEMPO_MAXIMO_DA_IA = 25_000;
/** Sem ao menos isto de sobra, o pedido nem pega a vez: ela fica para o próximo aviso da empresa. */
const TEMPO_MINIMO_PARA_RESPONDER = TEMPO_MINIMO_DA_IA + RESERVA_PARA_ENVIAR;
/** Quanto se espera, no máximo, por um arquivo que ainda está vindo do WhatsApp. */
const ESPERA_PELO_ARQUIVO = 8_000;

/**
 * O tempo total de um pedido. O padrão cabe numa hospedagem que encerra o pedido em 60 segundos;
 * num servidor próprio, sem esse limite, dá para aumentar com IENVIA_ATENDENTE_ORCAMENTO_MS.
 */
export function orcamentoDoAtendente(ambiente: Record<string, string | undefined> = process.env): number {
  const definido = Number(ambiente.IENVIA_ATENDENTE_ORCAMENTO_MS);
  return Number.isFinite(definido) && definido >= 20_000 && definido <= 600_000 ? Math.round(definido) : ORCAMENTO_PADRAO;
}

export interface Ambiente {
  /** Cliente do banco com a chave do servidor. */
  supabase: SupabaseClient;
  /** Até quando este pedido pode trabalhar (em milésimos de segundo, como Date.now()). */
  prazo: number;
  /** Só os testes trocam estes três. */
  dormir?: (ms: number) => Promise<void>;
  agora?: () => number;
  sorteio?: () => number;
}

export interface PedidoDeVez {
  workspaceId: string;
  vezId: string;
  /** A mensagem que marcou a vez. `null` para pegar uma vez que ficou sem dono. */
  gatilhoId: string | null;
  /** Quanto falta para a espera pelo cliente acabar. */
  esperaMs: number;
}

/** Como a vez terminou, para os registros e para os testes. */
export type Desfecho =
  | { desfecho: 'respondeu'; baloes: number; provedor: Provedor }
  | { desfecho: 'silencio' }
  | { desfecho: 'passou'; motivo: string }
  | { desfecho: 'encerrou'; motivo: 'recusa' | 'pediu_para_parar' }
  | { desfecho: 'falhou'; motivo: string }
  /** Este pedido não respondeu nada: a vez não era dele, a IA não podia mais responder, ou faltou tempo. */
  | { desfecho: 'nada'; motivo: string };

type Json = Record<string, unknown>;
const objeto = (valor: unknown): Json => (valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Json) : {});
const texto = (valor: unknown): string => (typeof valor === 'string' ? valor : '');
const numero = (valor: unknown): number => (typeof valor === 'number' && Number.isFinite(valor) ? valor : 0);
const esperar = (ms: number) => new Promise<void>((pronto) => setTimeout(pronto, ms));

class ErroDoBanco extends Error {
  constructor(funcao: string, codigo: string | undefined, mensagem: string) {
    super(`${funcao}: ${codigo ?? 'sem código'} ${mensagem}`);
    this.name = 'ErroDoBanco';
  }
}

async function chamar(supabase: SupabaseClient, funcao: string, parametros: Json): Promise<Json> {
  const { data, error } = await supabase.rpc(funcao, parametros);
  if (error) throw new ErroDoBanco(funcao, error.code, error.message);
  return objeto(data);
}

interface Meta {
  provider?: Provedor;
  model?: string;
  duration_ms?: number;
  tokens_in?: number | null;
  tokens_out?: number | null;
  attempts: Array<{ provider: Provedor; model: string; error: MotivoDoErroDeIa }>;
}

type DesfechoNoBanco = 'answered' | 'silent' | 'handoff' | 'silent_handoff' | 'uncertain_send' | 'failed' | 'closed' | 'opt_out';

interface Vez {
  ambiente: Ambiente;
  workspaceId: string;
  vezId: string;
  meta: Meta;
}

/** Conta ao banco como a vez terminou. Uma falha aqui não derruba o pedido: a varredura arruma depois. */
async function fechar(vez: Vez, desfecho: DesfechoNoBanco, extras: { detalhe?: string; recado?: string; trava?: boolean } = {}): Promise<void> {
  const parametros = {
    p_workspace_id: vez.workspaceId,
    p_turn_id: vez.vezId,
    p_outcome: desfecho,
    p_detail: extras.detalhe ?? null,
    p_note: extras.recado ? cortarRecado(extras.recado) : null,
    p_lock: extras.trava === true,
    p_meta: vez.meta,
  };
  try {
    await chamar(vez.ambiente.supabase, 'finish_ai_turn', parametros);
  } catch {
    try {
      await chamar(vez.ambiente.supabase, 'finish_ai_turn', parametros);
    } catch (erro) {
      console.error('[atendente] não foi possível contar ao banco como a vez terminou:', { vez: vez.vezId, desfecho, erro: String(erro) });
    }
  }
}

type Pega = { pega: true; pacote: Json } | { pega: false; motivo: string; alertaSeguranca?: boolean };

/** Espera o cliente terminar de escrever e pega a vez. */
async function pegarVez(ambiente: Ambiente, pedido: PedidoDeVez): Promise<Pega> {
  const dormir = ambiente.dormir ?? esperar;
  const agora = ambiente.agora ?? Date.now;
  const cabe = (ms: number) => agora() + ms <= ambiente.prazo - TEMPO_MINIMO_PARA_RESPONDER;

  // Sem tempo para esperar e ainda responder: a vez continua marcada, e o próximo aviso da empresa cuida dela.
  if (!cabe(pedido.esperaMs)) return { pega: false, motivo: 'sem_tempo' };
  if (pedido.esperaMs > 0) await dormir(pedido.esperaMs);

  for (let tentativa = 0; tentativa < 12; tentativa += 1) {
    const resposta = await chamar(ambiente.supabase, 'claim_ai_turn', {
      p_workspace_id: pedido.workspaceId,
      p_turn_id: pedido.vezId,
      p_trigger_message_id: pedido.gatilhoId,
    });
    const resultado = texto(resposta.result);
    if (resultado === 'claimed') return { pega: true, pacote: resposta };
    // Ainda não é a hora (o relógio do banco é quem manda), ou outra resposta desta conversa ainda está saindo.
    if (resultado === 'early' || resultado === 'busy') {
      const pausa = resultado === 'early' ? Math.min(Math.max(numero(resposta.wait_ms), 0) + 50, 20_000) : 1_500;
      if (!cabe(pausa)) return { pega: false, motivo: 'sem_tempo' };
      await dormir(pausa);
      continue;
    }
    return {
      pega: false,
      motivo: texto(resposta.reason) ? `${resultado}:${texto(resposta.reason)}` : resultado || 'desconhecido',
      alertaSeguranca: resultado === 'handed_off' && texto(resposta.reason) === 'rate_limit',
    };
  }
  return { pega: false, motivo: 'ocupada' };
}

/**
 * Envia o dossiê completo para o WhatsApp administrativo usando o próprio chip da conversa.
 * Só dispara quando os alertas estão ativos nas configurações da conta e o motivo está habilitado.
 * Falhas aqui são só registradas no servidor para nunca derrubar o fluxo principal do atendimento.
 */
async function despacharDossieParaAdmin(params: {
  ambiente: Ambiente;
  workspaceId: string;
  vezId: string;
  motor: ConfiguracaoDoMotor;
  dadosDaConversa: Json;
  mensagens: readonly MensagemDoHistorico[];
  tipo: EventoDeAlertaDoAdmin;
  detalhe?: string;
  recado?: string;
}): Promise<void> {
  const { ambiente, workspaceId, vezId, motor, dadosDaConversa, mensagens, tipo, detalhe, recado } = params;
  if (!motor.alertaAdminAtivo) return;
  if (!/^[0-9]{10,15}$/.test(motor.alertaAdminWhatsapp)) return;
  if (!motor.alertaAdminEventos.includes(tipo)) return;

  const instanceId = texto(dadosDaConversa.instance_id);
  const chip = texto(dadosDaConversa.provider_instance_name);
  if (!instanceId) return;

  const agora = ambiente.agora ?? Date.now;
  const sobra = ambiente.prazo - agora();
  if (sobra < 2_500) return;

  const dossie = montarDossieParaAdmin({
    tipo,
    agora: new Date(agora()),
    nomeDoContato: texto(dadosDaConversa.contact_name) || null,
    telefoneDoContato: texto(dadosDaConversa.contact_phone) || null,
    emailDoContato: texto(dadosDaConversa.contact_email) || null,
    recipientJid: texto(dadosDaConversa.recipient) || null,
    nomeDoChip: texto(dadosDaConversa.instance_label) || null,
    telefoneDoChip: texto(dadosDaConversa.instance_phone) || null,
    recado: recado ?? null,
    detalhe: detalhe ?? null,
    mensagens,
    incluirMensagens: motor.alertaAdminIncluirMensagens,
  });

  if (!chip) {
    await enviarAlertaViaRpc({
      supabase: ambiente.supabase,
      workspaceId,
      kind: tipo,
      bodyText: dossie,
      preferredInstanceId: instanceId,
      turnId: vezId,
      conversationId: texto(dadosDaConversa.id) || null,
      tempoLimiteMs: Math.max(Math.min(12_000, sobra - 500), 3_000),
    });
    return;
  }

  try {
    const { data: deliveryId, error: erroInicio } = await ambiente.supabase.rpc('start_admin_alert_delivery', {
      p_workspace_id: workspaceId,
      p_turn_id: vezId,
      p_conversation_id: texto(dadosDaConversa.id) || null,
      p_instance_id: instanceId,
      p_kind: tipo,
      p_recipient_whatsapp: motor.alertaAdminWhatsapp,
      p_body_prefix: dossie.slice(0, 120),
    });
    if (erroInicio || typeof deliveryId !== 'string' || !deliveryId) {
      if (erroInicio) {
        console.error('[atendente] não foi possível registrar envio do dossiê ao admin:', { vezId, erro: erroInicio.message });
      }
      return;
    }

    const envio = await enviarTexto(chip, motor.alertaAdminWhatsapp, dossie, {
      digitandoMs: 0,
      tempoLimite: Math.max(Math.min(12_000, sobra - 500), 3_000),
    });

    await ambiente.supabase.rpc('finish_admin_alert_delivery', {
      p_workspace_id: workspaceId,
      p_delivery_id: deliveryId,
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
    console.error('[atendente] erro ao enviar dossiê administrativo:', { vezId, tipo, erro: erro instanceof Error ? erro.message : String(erro) });
  }
}

async function notificarSegurancaDoAdmin(ambiente: Ambiente, workspaceId: string, vezId: string): Promise<void> {
  try {
    const { data, error } = await ambiente.supabase.rpc('read_admin_alert_context', {
      p_workspace_id: workspaceId,
      p_turn_id: vezId,
    });
    if (error || !data) return;
    const ctx = objeto(data);
    const motor = lerMotor(ctx.settings).configuracao;
    const dadosDaConversa = objeto(ctx.conversation);
    const historico = lerHistorico(ctx.messages);
    await despacharDossieParaAdmin({
      ambiente,
      workspaceId,
      vezId,
      motor,
      dadosDaConversa,
      mensagens: historico,
      tipo: 'safety',
      detalhe: 'rate_limit',
      recado: 'A IA respondeu muitas vezes em pouco tempo nesta conversa e parou por segurança. Pode haver um robô do outro lado.',
    });
  } catch (erro) {
    console.error('[atendente] erro ao buscar contexto de segurança para dossiê:', { vezId, erro: String(erro) });
  }
}

/** Lê do depósito o arquivo que vai junto com o pedido à IA. `null` quando não deu para ler. */
async function baixarArquivo(supabase: SupabaseClient, caminho: string): Promise<Buffer | null> {
  try {
    const { data, error } = await supabase.storage.from(DEPOSITO).download(caminho);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
}

/** O arquivo de uma mensagem pode ainda estar vindo do WhatsApp: espera um pouco por ele. */
async function esperarArquivo(vez: Vez, mensagemId: string, inicial: ArquivoDoHistorico): Promise<ArquivoDoHistorico> {
  const dormir = vez.ambiente.dormir ?? esperar;
  const agora = vez.ambiente.agora ?? Date.now;
  let arquivo = inicial;
  const limite = Math.min(agora() + ESPERA_PELO_ARQUIVO, vez.ambiente.prazo - TEMPO_MINIMO_PARA_RESPONDER);
  while (arquivo.situacao === 'pending' && agora() + 1_000 <= limite) {
    await dormir(1_000);
    const { data, error } = await vez.ambiente.supabase.rpc('read_ai_attachment', { p_workspace_id: vez.workspaceId, p_message_id: mensagemId });
    if (error) break;
    arquivo = lerArquivoDoHistorico(data) ?? arquivo;
  }
  return arquivo;
}

type Fim =
  | { tipo: 'fim'; desfecho: Desfecho }
  /** O cliente escreveu de novo enquanto a IA preparava a resposta: quem responde é a vez mais nova. */
  | { tipo: 'trocar'; proxima: PedidoDeVez };

const fim = (desfecho: Desfecho): Fim => ({ tipo: 'fim', desfecho });

async function falhar(
  vez: Vez,
  detalhe: string,
  recado: string,
  alerta?: { motor: ConfiguracaoDoMotor; dadosDaConversa: Json; mensagens: readonly MensagemDoHistorico[] },
): Promise<Fim> {
  await fechar(vez, 'failed', { detalhe, recado });
  if (alerta) {
    await despacharDossieParaAdmin({
      ambiente: vez.ambiente,
      workspaceId: vez.workspaceId,
      vezId: vez.vezId,
      motor: alerta.motor,
      dadosDaConversa: alerta.dadosDaConversa,
      mensagens: alerta.mensagens,
      tipo: 'error',
      detalhe,
      recado,
    });
  }
  return fim({ desfecho: 'falhou', motivo: detalhe });
}

/**
 * Os recados abaixo aparecem na Inbox logo depois de um título que já diz o que houve
 * ("A IA não conseguiu responder", "Não deu para confirmar se a resposta da IA chegou"...): por isso
 * cada um traz só o motivo e o que fazer, sem repetir o título.
 */
function recadoDoEnvioQueNaoSaiu(motivo: Extract<ResultadoDoEnvio, { situacao: 'nao_enviada' }>['motivo']): string {
  if (motivo === 'sem_whatsapp') return 'A resposta não foi enviada: este número não tem WhatsApp.';
  if (motivo === 'chip_nao_encontrado') return 'A resposta não foi enviada: o chip desta conversa não existe mais na Evolution. Confira em Instâncias.';
  return 'A resposta não foi enviada: a conexão com a Evolution não está configurada direito neste ambiente.';
}

const RECADO_DO_ENVIO_INCERTO = 'Confira no WhatsApp do chip e marque, na própria mensagem, se ela foi enviada ou não.';

const NOME_DO_COMANDO: Record<string, string> = { ENVIAR_ITEM: 'uma foto ou arquivo do catálogo', ENVIAR_AUDIO: 'um áudio', ENVIAR_PIX: 'o PIX' };

/** Com a vez na mão: pede a resposta, envia e fecha. */
async function responder(ambiente: Ambiente, workspaceId: string, pacote: Json): Promise<Fim> {
  const agora = ambiente.agora ?? Date.now;
  const sorteio = ambiente.sorteio ?? Math.random;
  const vez: Vez = { ambiente, workspaceId, vezId: texto(objeto(pacote.turn).id), meta: { attempts: [] } };
  const motor = lerMotor(pacote.settings).configuracao;
  const dadosDaConversa = objeto(pacote.conversation);

  const cofre = lerChaveDoCofre();
  const historicoInicial = lerHistorico(pacote.messages);
  const contextoAlerta = { motor, dadosDaConversa, mensagens: historicoInicial };

  if (!cofre) {
    return falhar(vez, 'no_vault', 'O painel está sem o segredo que protege as chaves de IA neste ambiente. Avise o suporte.', contextoAlerta);
  }
  const base = lerBase(pacote.agent);
  if (!base) {
    return falhar(vez, 'no_training', 'Ainda não existe uma base de treinamento. Preencha a aba Treinamento.', contextoAlerta);
  }

  const historico = historicoInicial;
  const pendentes = mensagensPendentes(historico);
  if (pendentes.length === 0) {
    // Alguém já respondeu depois da mensagem que marcou a vez: não há o que responder.
    await fechar(vez, 'silent', { detalhe: 'nothing_pending' });
    return fim({ desfecho: 'silencio' });
  }

  // As chaves chegam cifradas; só são abertas aqui.
  const cifras = objeto(pacote.keys);
  const chaves: Partial<Record<Provedor, string>> = {};
  const naoAbrem: Provedor[] = [];
  for (const provedor of PROVEDORES) {
    const cifra = texto(cifras[provedor]);
    if (!cifra) continue;
    const aberta = decifrar(cifra, contextoDaChaveDeIa(workspaceId, provedor), cofre);
    if (aberta) chaves[provedor] = aberta;
    else naoAbrem.push(provedor);
  }
  const ordem = ordemDeUso(motor);
  const comChave = ordem.filter((provedor) => chaves[provedor]);
  if (comChave.length === 0) {
    const principal = ordem[0]!;
    return naoAbrem.includes(principal)
      ? falhar(vez, 'key_unreadable', `A chave ${doProvedor(principal)} guardada não abre mais. Cadastre a chave de novo no Motor de IA.`, contextoAlerta)
      : falhar(vez, 'no_key', `Falta a chave ${doProvedor(principal)} no Motor de IA.`, contextoAlerta);
  }

  // Arquivo (foto, áudio ou PDF) que acompanha as mensagens pendentes.
  let rota = comChave;
  let anexo: AnexoParaIa | null = null;
  let entregue: string | null = null;
  let motivoDeNaoEntregar: 'sem_provedor' | 'nao_guardado' | 'grande_demais' | null = null;
  const escolhido = escolherArquivo(pendentes);
  if (escolhido) {
    const quemRecebe = comChave.filter((provedor) => provedorRecebe(provedor, escolhido.tipo));
    if (quemRecebe.length === 0) {
      motivoDeNaoEntregar = 'sem_provedor';
    } else {
      const arquivo = await esperarArquivo(vez, escolhido.mensagemId, escolhido.arquivo);
      if (arquivo.situacao !== 'stored' || !arquivo.caminho) motivoDeNaoEntregar = 'nao_guardado';
      else if (arquivo.tamanho > LIMITE_DO_ARQUIVO_PARA_A_IA[escolhido.tipo]) motivoDeNaoEntregar = 'grande_demais';
      else {
        const dados = await baixarArquivo(ambiente.supabase, arquivo.caminho);
        if (!dados) motivoDeNaoEntregar = 'nao_guardado';
        else {
          anexo = { tipo: arquivo.conteudo || escolhido.arquivo.conteudo, dados };
          entregue = escolhido.mensagemId;
          rota = quemRecebe;
        }
      }
    }
  }
  const semLeitura = porQueNaoDaParaLer(pendentes, entregue, motivoDeNaoEntregar);
  if (semLeitura) {
    await fechar(vez, 'silent_handoff', { detalhe: 'unreadable_media', recado: semLeitura });
    await despacharDossieParaAdmin({ ...contextoAlerta, ambiente, workspaceId, vezId: vez.vezId, tipo: 'silent_handoff', detalhe: 'unreadable_media', recado: semLeitura });
    return fim({ desfecho: 'passou', motivo: 'arquivo_sem_leitura' });
  }

  const conversa = montarConversa(historico, entregue);
  const falasCliente = historico.filter((m) => m.recebida).map((m) => m.texto).filter(Boolean);
  let instrucoes = montarInstrucoes(base, {
    agora: new Date(agora()),
    nomeDoContato: texto(dadosDaConversa.contact_name) || null,
    mensagemAtual: pendentes.map((m) => m.texto).filter(Boolean).join(' ').trim() || falasCliente.at(-1) || '',
    historicoRecente: falasCliente.slice(-5),
    temAudio: Boolean(anexo && anexo.tipo.startsWith('audio/')),
    temFoto: Boolean(anexo && anexo.tipo.startsWith('image/')),
  });
  if (conversa.abertura) instrucoes = `${instrucoes}\n\n${instrucaoDaAbertura(conversa.abertura)}`;

  // Pede a resposta: o principal primeiro; se falhar, a reserva; depois a segunda reserva.
  let resposta: RespostaDeIa | null = null;
  let usado: Provedor | null = null;
  let faltouTempo = false;
  for (const provedor of rota) {
    const sobra = ambiente.prazo - agora() - RESERVA_PARA_ENVIAR;
    if (sobra < TEMPO_MINIMO_DA_IA) {
      faltouTempo = true;
      break;
    }
    const modelo = modeloDoProvedor(motor, provedor);
    try {
      resposta = await gerarResposta({
        provedor,
        chave: chaves[provedor]!,
        modelo,
        sistema: instrucoes,
        conversa: conversa.falas,
        anexo,
        temperatura: motor.criatividade,
        tempoLimiteMs: Math.min(TEMPO_MAXIMO_DA_IA, sobra),
      });
      usado = provedor;
      vez.meta.provider = provedor;
      vez.meta.model = modelo;
      vez.meta.duration_ms = resposta.duracaoMs;
      vez.meta.tokens_in = resposta.tokens.entrada;
      vez.meta.tokens_out = resposta.tokens.saida;
      break;
    } catch (erro) {
      const motivo: MotivoDoErroDeIa = erro instanceof ErroDeIa ? erro.motivo : 'recusada';
      vez.meta.attempts.push({ provider: provedor, model: modelo, error: motivo });
      console.error('[atendente] o provedor não respondeu:', {
        vez: vez.vezId,
        provedor,
        modelo,
        motivo,
        status: erro instanceof ErroDeIa ? erro.status : undefined,
        mensagem: erro instanceof ErroDeIa ? erro.message : 'erro inesperado',
      });
    }
  }

  if (!resposta || !usado) {
    const tentativas = vez.meta.attempts;
    if (tentativas.length === 0) {
      return falhar(vez, 'no_time', 'Não deu tempo de pedir a resposta ao provedor.', contextoAlerta);
    }
    // Foto que nenhum modelo da ordem de uso enxerga: não é defeito, é só um arquivo que a IA não lê.
    if (anexo && tentativas.every((tentativa) => tentativa.error === 'nao_suportado')) {
      const recadoFoto = 'O contato mandou uma foto, e o modelo escolhido no Motor de IA não enxerga fotos.';
      await fechar(vez, 'silent_handoff', {
        detalhe: 'unreadable_media',
        recado: recadoFoto,
      });
      await despacharDossieParaAdmin({ ...contextoAlerta, ambiente, workspaceId, vezId: vez.vezId, tipo: 'silent_handoff', detalhe: 'unreadable_media', recado: recadoFoto });
      return fim({ desfecho: 'passou', motivo: 'arquivo_sem_leitura' });
    }
    const primeira = tentativas[0]!;
    const explicacao = explicarErroDeIa(primeira.error, primeira.provider, primeira.model);
    const outras = tentativas.length > 1 ? ` ${tentativas.length === 2 ? 'A reserva também falhou' : 'As reservas também falharam'}.` : '';
    return falhar(vez, primeira.error, `${explicacao}${outras}${faltouTempo ? ' Não deu tempo de tentar a próxima reserva.' : ''}`, contextoAlerta);
  }

  const lida = lerResposta(resposta.texto);

  if (lida.pausaSilenciosa !== null) {
    await fechar(vez, 'silent_handoff', { detalhe: 'silent_pause', recado: lida.pausaSilenciosa });
    await despacharDossieParaAdmin({ ...contextoAlerta, ambiente, workspaceId, vezId: vez.vezId, tipo: 'silent_handoff', detalhe: 'silent_pause', recado: lida.pausaSilenciosa });
    return fim({ desfecho: 'passou', motivo: 'pausa_silenciosa' });
  }
  if (lida.silencioDeCortesia) {
    await fechar(vez, 'silent', { detalhe: 'courtesy' });
    return fim({ desfecho: 'silencio' });
  }

  // A IA usou um comando de enviar foto, áudio ou PIX, que o painel ainda não atende: o contato ficaria esperando.
  const prometido = lida.foraDoAlcance.map((comando) => NOME_DO_COMANDO[comando] ?? comando).join(', ');
  const recadoDoRepasse =
    lida.foraDoAlcance.length > 0
      ? `A IA quis enviar ${prometido}, e isso ela ainda não faz.${lida.chamarHumano ? ` ${lida.chamarHumano}` : ''}`
      : lida.chamarHumano;

  const baloes = dividirResposta(lida.texto, motor.dividirMensagensLongas);
  if (baloes === null) {
    return falhar(vez, 'reply_too_long', 'A IA escreveu uma resposta grande demais para o WhatsApp. Nada foi enviado.', contextoAlerta);
  }

  let enviados = 0;
  for (const [indice, balao] of baloes.entries()) {
    const inicio = await chamar(ambiente.supabase, 'start_ai_message', {
      p_workspace_id: workspaceId,
      p_turn_id: vez.vezId,
      p_part: indice + 1,
      p_body_text: balao,
    });
    const resultado = texto(inicio.result);

    if (resultado === 'aborted') {
      // O banco já fechou a vez (uma pessoa respondeu ou assumiu, a IA foi pausada, ou o cliente escreveu de novo).
      const motivo = texto(inicio.reason) || 'aborted';
      const proxima = objeto(inicio.next);
      if (indice === 0 && motivo === 'superseded' && texto(proxima.turn_id)) {
        return {
          tipo: 'trocar',
          proxima: { workspaceId, vezId: texto(proxima.turn_id), gatilhoId: texto(proxima.trigger_message_id) || null, esperaMs: Math.max(numero(proxima.wait_ms), 0) },
        };
      }
      return fim(enviados > 0 ? { desfecho: 'respondeu', baloes: enviados, provedor: usado } : { desfecho: 'nada', motivo });
    }
    if (resultado === 'queued_local') {
      enviados += 1;
      continue;
    }
    if (resultado !== 'started') {
      // Este balão já tinha sido começado por outro pedido. Não dá para saber se saiu: nunca envia de novo.
      await fechar(vez, 'uncertain_send', { detalhe: 'part_already_started', recado: RECADO_DO_ENVIO_INCERTO });
      await despacharDossieParaAdmin({ ...contextoAlerta, ambiente, workspaceId, vezId: vez.vezId, tipo: 'uncertain_send', detalhe: 'part_already_started', recado: RECADO_DO_ENVIO_INCERTO });
      return fim({ desfecho: 'passou', motivo: 'envio_incerto' });
    }

    const mensagemId = texto(inicio.message_id);
    const destino = numeroParaEnvio(inicio.recipient);
    const chip = texto(inicio.provider_instance_name);

    // O "digitando…" encolhe quando o tempo do pedido está no fim: melhor responder sem ele do que não responder.
    const sobra = ambiente.prazo - agora();
    const typingPacote = objeto(pacote.typing);
    const limitesDigitacao =
      numero(typingPacote.min_ms) > 0 && numero(typingPacote.max_ms) >= numero(typingPacote.min_ms)
        ? { minMs: numero(typingPacote.min_ms), maxMs: numero(typingPacote.max_ms) }
        : undefined;
    const digitando = motor.simularDigitando
      ? Math.max(Math.min(tempoDeDigitacao(balao, sorteio(), limitesDigitacao), sobra - 8_000), 0)
      : 0;
    const envio: ResultadoDoEnvio =
      destino && chip
        ? await enviarTexto(chip, destino, balao, { digitandoMs: digitando, tempoLimite: Math.max(Math.min(25_000 + digitando, sobra - 1_500), 5_000) })
        : { situacao: 'nao_enviada', motivo: 'sem_whatsapp' };

    const terminar = () =>
      chamar(ambiente.supabase, 'finish_ai_message', {
        p_workspace_id: workspaceId,
        p_message_id: mensagemId,
        p_outcome: envio.situacao === 'enviada' ? 'sent' : envio.situacao === 'nao_enviada' ? 'failed' : 'uncertain',
        p_provider_message_id: envio.situacao === 'enviada' ? envio.idNoWhatsApp : null,
      });
    try {
      await terminar();
    } catch {
      try {
        await terminar();
      } catch (erro) {
        // A mensagem fica "enviando"; se saiu, o aviso da Evolution confirma sozinho.
        console.error('[atendente] não foi possível gravar como o envio terminou:', { vez: vez.vezId, mensagem: mensagemId, erro: String(erro) });
      }
    }

    if (envio.situacao === 'incerta') {
      console.error('[atendente] envio sem confirmação:', { vez: vez.vezId, mensagem: mensagemId, detalhe: envio.detalhe });
      await fechar(vez, 'uncertain_send', { detalhe: `uncertain_part_${indice + 1}`, recado: RECADO_DO_ENVIO_INCERTO });
      await despacharDossieParaAdmin({ ...contextoAlerta, ambiente, workspaceId, vezId: vez.vezId, tipo: 'uncertain_send', detalhe: `uncertain_part_${indice + 1}`, recado: RECADO_DO_ENVIO_INCERTO });
      return fim({ desfecho: 'passou', motivo: 'envio_incerto' });
    }
    if (envio.situacao === 'nao_enviada') {
      const recadoNaoSaiu = recadoDoEnvioQueNaoSaiu(envio.motivo);
      await fechar(vez, 'failed', { detalhe: `not_sent:${envio.motivo}`, recado: recadoNaoSaiu });
      await despacharDossieParaAdmin({
        ...contextoAlerta,
        ambiente,
        workspaceId,
        vezId: vez.vezId,
        tipo: 'error',
        detalhe: `not_sent:${envio.motivo}`,
        recado: recadoNaoSaiu,
      });
      return fim({ desfecho: 'falhou', motivo: `nao_enviada:${envio.motivo}` });
    }
    enviados += 1;
  }

  // Tudo enviado (ou não havia texto para enviar). O que a IA pediu para fazer com a conversa?
  if (lida.pararContato !== null) {
    await fechar(vez, 'opt_out', { detalhe: 'opt_out', recado: lida.pararContato });
    return fim({ desfecho: 'encerrou', motivo: 'pediu_para_parar' });
  }
  if (lida.encerrarContato !== null) {
    await fechar(vez, 'closed', { detalhe: 'declined', recado: lida.encerrarContato });
    return fim({ desfecho: 'encerrou', motivo: 'recusa' });
  }
  if (recadoDoRepasse !== null) {
    const detalheRepasse = lida.foraDoAlcance.length > 0 ? `unsupported:${lida.foraDoAlcance.join(',')}` : 'asked';
    await fechar(vez, 'handoff', {
      detalhe: detalheRepasse,
      recado: recadoDoRepasse,
      trava: base.travaAteRetomar,
    });
    await despacharDossieParaAdmin({ ...contextoAlerta, ambiente, workspaceId, vezId: vez.vezId, tipo: 'handoff', detalhe: detalheRepasse, recado: recadoDoRepasse });
    return fim({ desfecho: 'passou', motivo: lida.foraDoAlcance.length > 0 ? 'comando_fora_do_alcance' : 'a_ia_pediu' });
  }
  if (enviados === 0) {
    return falhar(vez, 'empty_reply', `${provedorComArtigo(usado)} devolveu uma resposta sem texto.`, contextoAlerta);
  }
  await fechar(vez, 'answered');
  return fim({ desfecho: 'respondeu', baloes: enviados, provedor: usado });
}

/** "O Google Gemini", "O OpenRouter", "A NVIDIA". */
const provedorComArtigo = (provedor: Provedor): string => `${provedor === 'nvidia' ? 'A' : 'O'} ${NOME_DO_PROVEDOR[provedor]}`;

/**
 * Responde uma vez da IA, do começo ao fim. Nunca lança erro: o que der errado vira um desfecho
 * (e, quando a vez já tinha sido pega, a conversa vai para uma pessoa).
 */
export async function atenderVez(ambiente: Ambiente, pedido: PedidoDeVez): Promise<Desfecho> {
  let alvo = pedido;
  // Cada troca é o cliente escrevendo de novo no meio da resposta; três seguidas é o bastante para um pedido só.
  for (let volta = 0; volta < 3; volta += 1) {
    let pega: Pega;
    try {
      pega = await pegarVez(ambiente, alvo);
    } catch (erro) {
      console.error('[atendente] não foi possível pegar a vez:', { vez: alvo.vezId, erro: String(erro) });
      return { desfecho: 'nada', motivo: 'banco_indisponivel' };
    }
    if (!pega.pega) {
      if (pega.alertaSeguranca) {
        await notificarSegurancaDoAdmin(ambiente, alvo.workspaceId, alvo.vezId);
      }
      return { desfecho: 'nada', motivo: pega.motivo };
    }

    let resultado: Fim;
    try {
      resultado = await responder(ambiente, alvo.workspaceId, pega.pacote);
    } catch (erro) {
      console.error('[atendente] erro inesperado ao responder:', { vez: alvo.vezId, erro: erro instanceof Error ? erro.message : String(erro) });
      const recadoErro = 'Houve um problema do nosso lado. Confira a conversa antes de responder.';
      await fechar({ ambiente, workspaceId: alvo.workspaceId, vezId: alvo.vezId, meta: { attempts: [] } }, 'failed', {
        detalhe: 'unexpected_error',
        recado: recadoErro,
      });
      await despacharDossieParaAdmin({
        ambiente,
        workspaceId: alvo.workspaceId,
        vezId: alvo.vezId,
        motor: lerMotor(pega.pacote.settings).configuracao,
        dadosDaConversa: objeto(pega.pacote.conversation),
        mensagens: lerHistorico(pega.pacote.messages),
        tipo: 'error',
        detalhe: 'unexpected_error',
        recado: recadoErro,
      });
      return { desfecho: 'falhou', motivo: 'erro_inesperado' };
    }
    if (resultado.tipo === 'fim') return resultado.desfecho;
    alvo = resultado.proxima;
  }
  return { desfecho: 'nada', motivo: 'cliente_ainda_escrevendo' };
}

/**
 * Arruma o que ficou para trás na empresa (resposta interrompida, vez esquecida) e responde as vezes que
 * ficaram sem dono há pouco. É chamada quando um aviso da Evolution percebe que há algo para trás.
 */
export async function atenderSobras(ambiente: Ambiente, workspaceId: string): Promise<Desfecho[]> {
  let sobras: Json;
  try {
    sobras = await chamar(ambiente.supabase, 'sweep_ai_turns', { p_workspace_id: workspaceId });
  } catch (erro) {
    console.error('[atendente] não foi possível conferir o que ficou para trás:', { empresa: workspaceId, erro: String(erro) });
    return [];
  }
  const desfechos: Desfecho[] = [];
  for (const item of Array.isArray(sobras.orphans) ? sobras.orphans : []) {
    const vezId = texto(objeto(item).turn_id);
    if (!vezId) continue;
    desfechos.push(await atenderVez(ambiente, { workspaceId, vezId, gatilhoId: null, esperaMs: 0 }));
  }
  return desfechos;
}
