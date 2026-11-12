import 'server-only';

import { lerConfigEvolution } from '@/lib/env';
import { telefoneDoJid } from '@/lib/instancias/regras';

/**
 * Conversa com a Evolution API (o servidor que mantém os chips do WhatsApp ligados na nuvem).
 * Só roda no servidor: a chave nunca vai para o navegador nem para os registros (logs).
 *
 * As respostas foram conferidas contra uma Evolution 2.3.7 de verdade.
 */

export type EstadoNaEvolution = 'open' | 'connecting' | 'close';

/**
 * Por que uma chamada não deu certo:
 *   nao_configurada — este ambiente não tem o endereço/chave da Evolution;
 *   nao_encontrada  — a instância não existe lá;
 *   nome_em_uso     — já existe uma instância com esse nome;
 *   recusada        — a Evolution respondeu que não fez (pode tentar de novo sem risco);
 *   incerta         — não houve resposta: NÃO dá para saber se ela fez ou não.
 */
export type MotivoDoErro = 'nao_configurada' | 'nao_encontrada' | 'nome_em_uso' | 'recusada' | 'incerta';

export class ErroEvolution extends Error {
  constructor(
    readonly motivo: MotivoDoErro,
    mensagem: string,
    readonly status?: number,
    /** O que a Evolution respondeu junto com o erro (já lido como JSON), quando houve resposta. */
    readonly corpo?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroEvolution';
  }
}

export interface QrCode {
  /** Imagem do QR Code pronta para um <img> ("data:image/png;base64,..."). */
  imagem: string | null;
  /** Código de 8 dígitos para conectar sem câmera (só vem quando o número é informado). */
  codigoDePareamento: string | null;
}

export interface Aviso {
  /** Endereço do painel que recebe os avisos (webhook). */
  url: string;
  /** Segredo que a Evolution manda junto, para o painel saber que o aviso é dela. */
  token: string;
}

const TEMPO_LIMITE_PADRAO = 15_000;
/** Enviar uma mensagem pode demorar mais que uma consulta; passado isto, o envio fica "sem confirmação". */
const TEMPO_LIMITE_DO_ENVIO = 25_000;
/** Teto do "digitando…" antes de uma mensagem (acima de 20 s a Evolution muda o jeito de esperar). */
const DIGITANDO_NO_MAXIMO = 15_000;

/**
 * O que a Evolution avisa ao painel:
 *   MESSAGES_UPSERT   — mensagem que chegou, ou que foi digitada direto no celular do chip;
 *   SEND_MESSAGE      — mensagem que saiu pela Evolution (é o "eco" do que o painel enviou);
 *   CONNECTION_UPDATE — chip conectou ou caiu.
 */
export const EVENTOS_DO_AVISO = ['MESSAGES_UPSERT', 'SEND_MESSAGE', 'CONNECTION_UPDATE'] as const;

function extrairMensagem(dado: unknown): string {
  if (dado && typeof dado === 'object') {
    const resposta = (dado as { response?: { message?: unknown } }).response?.message;
    if (Array.isArray(resposta)) return resposta.map(String).join(' ');
    if (typeof resposta === 'string') return resposta;
    const direta = (dado as { message?: unknown }).message;
    if (typeof direta === 'string') return direta;
  }
  return 'A Evolution não explicou o motivo.';
}

async function chamar<T>(
  metodo: 'GET' | 'POST' | 'DELETE',
  caminho: string,
  opcoes: { corpo?: unknown; tempoLimite?: number } = {},
): Promise<T> {
  const config = lerConfigEvolution();
  if (!config) throw new ErroEvolution('nao_configurada', 'A Evolution não foi configurada neste ambiente.');

  let resposta: Response;
  try {
    resposta = await fetch(`${config.url}${caminho}`, {
      method: metodo,
      headers: {
        apikey: config.chave,
        ...(opcoes.corpo === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
      signal: AbortSignal.timeout(opcoes.tempoLimite ?? TEMPO_LIMITE_PADRAO),
      cache: 'no-store',
    });
  } catch {
    // Sem resposta (demorou demais, rede caiu): não sabemos se a Evolution executou.
    throw new ErroEvolution('incerta', 'A Evolution não respondeu a tempo.');
  }

  const texto = await resposta.text().catch(() => '');
  let dado: unknown = null;
  try {
    dado = texto ? JSON.parse(texto) : null;
  } catch {
    dado = null;
  }

  if (resposta.ok) return dado as T;

  const mensagem = extrairMensagem(dado);
  if (resposta.status === 404) throw new ErroEvolution('nao_encontrada', mensagem, 404, dado);
  if (resposta.status === 403 && /already in use/i.test(mensagem)) throw new ErroEvolution('nome_em_uso', mensagem, 403, dado);
  if (resposta.status >= 500) throw new ErroEvolution('incerta', mensagem, resposta.status, dado);
  throw new ErroEvolution('recusada', mensagem, resposta.status, dado);
}

const nomeNoCaminho = (nome: string) => encodeURIComponent(nome);

function lerQrCode(dado: unknown): QrCode {
  const bruto = (dado ?? {}) as { base64?: unknown; pairingCode?: unknown };
  return {
    imagem: typeof bruto.base64 === 'string' && bruto.base64.startsWith('data:image/') ? bruto.base64 : null,
    codigoDePareamento: typeof bruto.pairingCode === 'string' && bruto.pairingCode ? bruto.pairingCode : null,
  };
}

function corpoDoAviso(aviso: Aviso) {
  return {
    url: aviso.url,
    byEvents: false,
    base64: false,
    headers: { Authorization: `Bearer ${aviso.token}` },
    events: [...EVENTOS_DO_AVISO],
  };
}

/**
 * Cria a instância na Evolution e já devolve o primeiro QR Code. Informando `numero` (só dígitos,
 * com código do país), a Evolution já devolve também o código de 8 dígitos para conectar sem câmera.
 */
export async function criarInstancia(dados: { nome: string; aviso: Aviso | null; numero?: string }): Promise<QrCode> {
  const resposta = await chamar<{ qrcode?: unknown }>('POST', '/instance/create', {
    corpo: {
      instanceName: dados.nome,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      ...(dados.numero ? { number: dados.numero } : {}),
      // Grupos ficam de fora: o Ienvia atende conversas individuais.
      groupsIgnore: true,
      rejectCall: false,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
      ...(dados.aviso ? { webhook: corpoDoAviso(dados.aviso) } : {}),
    },
    tempoLimite: 30_000,
  });
  return lerQrCode(resposta?.qrcode);
}

/**
 * Pede um QR Code novo. Quando a instância está fechada ("close") e `numero` é informado (só
 * dígitos, com código do país), a Evolution devolve também o código de 8 dígitos para conectar sem
 * câmera; enquanto já estiver em "connecting", a Evolution 2.3.7 ignora `numero` e devolve o
 * QR/código que já estava aguardando leitura.
 */
export async function pedirQrCode(nome: string, numero?: string): Promise<QrCode & { jaConectado: boolean }> {
  const consulta = numero ? `?number=${encodeURIComponent(numero)}` : '';
  const resposta = await chamar<{ instance?: { state?: string } }>('GET', `/instance/connect/${nomeNoCaminho(nome)}${consulta}`, {
    tempoLimite: 30_000,
  });
  return { ...lerQrCode(resposta), jaConectado: resposta?.instance?.state === 'open' };
}

/** Estado da conexão e, quando conectado, o número do chip. */
export async function consultarChip(nome: string): Promise<{ estado: EstadoNaEvolution; telefone: string | null }> {
  const lista = await chamar<Array<{ connectionStatus?: string; ownerJid?: string | null }>>(
    'GET',
    `/instance/fetchInstances?instanceName=${encodeURIComponent(nome)}`,
  );
  const chip = Array.isArray(lista) ? lista[0] : undefined;
  if (!chip) throw new ErroEvolution('nao_encontrada', 'A instância não existe na Evolution.', 404);
  const estado: EstadoNaEvolution =
    chip.connectionStatus === 'open' ? 'open' : chip.connectionStatus === 'connecting' ? 'connecting' : 'close';
  return { estado, telefone: estado === 'open' ? telefoneDoJid(chip.ownerJid) : null };
}

export interface AvisoConfigurado {
  url: string;
  ligado: boolean;
  /** Quais acontecimentos a Evolution avisa hoje para este chip. */
  eventos: string[];
}

/** Para onde a Evolution está mandando os avisos deste chip. `null` se não houver aviso configurado. */
export async function consultarAviso(nome: string): Promise<AvisoConfigurado | null> {
  const resposta = await chamar<{ url?: unknown; enabled?: unknown; events?: unknown } | null>(
    'GET',
    `/webhook/find/${nomeNoCaminho(nome)}`,
  );
  if (!resposta || typeof resposta.url !== 'string' || !resposta.url) return null;
  const eventos = Array.isArray(resposta.events) ? resposta.events.filter((evento): evento is string => typeof evento === 'string') : [];
  return { url: resposta.url, ligado: resposta.enabled === true, eventos };
}

/** O aviso deste chip aponta para o endereço certo, está ligado e avisa tudo de que o painel precisa? */
export function avisoEstaEmDia(atual: AvisoConfigurado | null, url: string): boolean {
  return Boolean(atual && atual.url === url && atual.ligado && EVENTOS_DO_AVISO.every((evento) => atual.eventos.includes(evento)));
}

export async function configurarAviso(nome: string, aviso: Aviso): Promise<void> {
  await chamar('POST', `/webhook/set/${nomeNoCaminho(nome)}`, {
    corpo: { webhook: { enabled: true, ...corpoDoAviso(aviso) } },
  });
}

/** Desconecta o WhatsApp do chip (a instância continua existindo, pronta para um novo QR Code). */
export async function desconectarInstancia(nome: string): Promise<void> {
  await chamar('DELETE', `/instance/logout/${nomeNoCaminho(nome)}`);
}

/** Apaga a instância na Evolution. Se ela já não existe, considera feito. */
export async function apagarInstancia(nome: string): Promise<void> {
  try {
    await chamar('DELETE', `/instance/delete/${nomeNoCaminho(nome)}`);
  } catch (erro) {
    if (erro instanceof ErroEvolution && erro.motivo === 'nao_encontrada') return;
    throw erro;
  }
}

/**
 * Como terminou um envio:
 *   enviada     — a Evolution confirmou (com o identificador da mensagem no WhatsApp, quando ela informou);
 *   nao_enviada — com certeza NÃO saiu, e por quê;
 *   incerta     — não dá para saber se saiu. O painel nunca reenvia sozinho: quem decide é a pessoa
 *                 (ou o aviso da própria Evolution, se ele chegar).
 */
export type ResultadoDoEnvio =
  | { situacao: 'enviada'; idNoWhatsApp: string | null }
  | { situacao: 'nao_enviada'; motivo: 'sem_whatsapp' | 'chip_nao_encontrado' | 'nao_configurada' | 'chave_recusada' }
  | { situacao: 'incerta'; detalhe: string };

/** A Evolution responde assim quando o número não existe no WhatsApp: { response: { message: [{ exists: false }] } }. */
function numeroSemWhatsApp(corpo: unknown): boolean {
  const mensagens = (corpo as { response?: { message?: unknown } } | null)?.response?.message;
  return (
    Array.isArray(mensagens) &&
    mensagens.some((item) => typeof item === 'object' && item !== null && (item as { exists?: unknown }).exists === false)
  );
}

/**
 * Envia um texto por um chip. `numero` vai só com dígitos (código do país + DDD + número): é assim que a
 * Evolution confere o número no WhatsApp, aceitando o celular brasileiro com e sem o nono dígito.
 *
 * Nunca lança erro. Atenção ao que a Evolution 2.3.7 faz: qualquer erro durante o envio vira "400", até os que
 * acontecem depois de a mensagem já ter saído. Por isso só é "não enviada" o que dá para ter certeza; o resto é "incerta".
 */
export async function enviarTexto(
  nome: string,
  numero: string,
  texto: string,
  opcoes: {
    tempoLimite?: number;
    /**
     * Mostrar "digitando…" para o contato por este tempo (em milésimos de segundo) antes de a mensagem sair.
     * A própria Evolution faz a espera (campo `delay`), então a resposta dela demora esse tanto a mais.
     */
    digitandoMs?: number;
  } = {},
): Promise<ResultadoDoEnvio> {
  const digitando = Math.round(Math.min(Math.max(opcoes.digitandoMs ?? 0, 0), DIGITANDO_NO_MAXIMO));
  return enviar(
    `/message/sendText/${nomeNoCaminho(nome)}`,
    { number: numero, text: texto, ...(digitando > 0 ? { delay: digitando } : {}) },
    opcoes.tempoLimite ?? TEMPO_LIMITE_DO_ENVIO + digitando,
  );
}

/** Uma chamada de envio (texto ou arquivo) e a leitura do que a Evolution respondeu. Nunca lança erro. */
async function enviar(caminho: string, corpo: Record<string, unknown>, tempoLimite: number): Promise<ResultadoDoEnvio> {
  try {
    const resposta = await chamar<{ key?: { id?: unknown } } | null>('POST', caminho, { corpo, tempoLimite });
    const id = resposta?.key?.id;
    return { situacao: 'enviada', idNoWhatsApp: typeof id === 'string' && id.length >= 1 && id.length <= 200 ? id : null };
  } catch (erro) {
    if (!(erro instanceof ErroEvolution)) return { situacao: 'incerta', detalhe: 'erro inesperado ao chamar a Evolution' };
    if (erro.motivo === 'nao_configurada') return { situacao: 'nao_enviada', motivo: 'nao_configurada' };
    if (erro.status === 404) return { situacao: 'nao_enviada', motivo: 'chip_nao_encontrado' };
    if (erro.status === 401 || erro.status === 403) return { situacao: 'nao_enviada', motivo: 'chave_recusada' };
    if (erro.status === 400 && numeroSemWhatsApp(erro.corpo)) return { situacao: 'nao_enviada', motivo: 'sem_whatsapp' };
    return { situacao: 'incerta', detalhe: erro.status ? `HTTP ${erro.status}: ${erro.message}` : erro.message };
  }
}

/** Mandar um arquivo demora mais que um texto: a Evolution recebe, converte e sobe para o WhatsApp. */
const TEMPO_LIMITE_DO_ENVIO_DE_ARQUIVO = 40_000;

export interface ArquivoParaEnviar {
  tipo: 'image' | 'video' | 'audio' | 'document';
  dados: Buffer;
  /** Tipo de conteúdo ("application/pdf"). */
  conteudo: string;
  /** Nome que a pessoa do outro lado vê (só vale para documento). */
  nome: string | null;
  /** Legenda (foto, vídeo e documento). Áudio não leva. */
  legenda: string | null;
}

/**
 * Nome do documento do jeito que a Evolution precisa. A Evolution 2.3.7 descobre o tipo do documento
 * pela terminação do nome (.pdf, .xlsx...) e ignora o tipo informado; sem nome, a chamada quebra.
 * Por isso o nome nunca vai vazio e ganha a terminação certa quando não tem nenhuma.
 */
export function nomeDoDocumentoParaEnvio(nome: string | null, conteudo: string): string {
  const limpo = (nome ?? '').replace(/[\u0000-\u001f\u007f\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'documento';
  if (/\.[a-z0-9]{1,8}$/i.test(limpo)) return limpo;
  const terminacao = TERMINACAO_PELO_CONTEUDO[conteudo] ?? 'bin';
  return `${limpo}.${terminacao}`;
}

const TERMINACAO_PELO_CONTEUDO: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

/**
 * Envia um arquivo por um chip. Mesmas garantias de `enviarTexto`: nunca lança erro, e só é
 * "não enviada" o que dá para ter certeza.
 *
 * Como a Evolution 2.3.7 trata cada tipo (conferido no código-fonte dela):
 *   foto      — ela mesma converte para JPEG antes de mandar;
 *   vídeo     — vai como está (por isso o painel só aceita MP4 como vídeo);
 *   áudio     — ela converte para o formato de mensagem de voz do WhatsApp e manda como voz;
 *   documento — vai como está, com o nome do arquivo.
 */
export async function enviarArquivo(
  nome: string,
  numero: string,
  arquivo: ArquivoParaEnviar,
  opcoes: { tempoLimite?: number } = {},
): Promise<ResultadoDoEnvio> {
  const tempoLimite = opcoes.tempoLimite ?? TEMPO_LIMITE_DO_ENVIO_DE_ARQUIVO;
  const base64 = arquivo.dados.toString('base64');

  if (arquivo.tipo === 'audio') {
    return enviar(`/message/sendWhatsAppAudio/${nomeNoCaminho(nome)}`, { number: numero, audio: base64 }, tempoLimite);
  }
  return enviar(
    `/message/sendMedia/${nomeNoCaminho(nome)}`,
    {
      number: numero,
      mediatype: arquivo.tipo,
      media: base64,
      mimetype: arquivo.tipo === 'image' ? 'image/jpeg' : arquivo.conteudo,
      ...(arquivo.legenda ? { caption: arquivo.legenda } : {}),
      // Foto e vídeo vão sem nome: a Evolution usa "image.jpg" / "video.mp4", que dão o tipo certo.
      ...(arquivo.tipo === 'document' ? { fileName: nomeDoDocumentoParaEnvio(arquivo.nome, arquivo.conteudo) } : {}),
    },
    tempoLimite,
  );
}

/** Buscar um arquivo recebido: a Evolution baixa do WhatsApp, abre e devolve inteiro. */
const TEMPO_LIMITE_PARA_BUSCAR_ARQUIVO = 45_000;

export type ArquivoBuscado =
  | { ok: true; dados: Buffer; /** Tipo de conteúdo que a Evolution informou, se informou. */ conteudo: string | null }
  | { ok: false; detalhe: string };

/**
 * Busca na Evolution o arquivo (foto, áudio, vídeo, documento, figurinha) de uma mensagem.
 *
 * `mensagem` é o que identifica a mensagem para a Evolution:
 *   - o aviso inteiro que ela mandou ({ key, message }): ela baixa direto do WhatsApp;
 *   - só a identificação ({ key: { id } }): ela procura a mensagem no próprio histórico (depende de a
 *     Evolution estar configurada para guardar as mensagens).
 * Nunca lança erro.
 */
export async function buscarArquivoDaMensagem(
  nome: string,
  mensagem: { key: Record<string, unknown>; message?: unknown },
  opcoes: { tempoLimite?: number } = {},
): Promise<ArquivoBuscado> {
  try {
    const resposta = await chamar<{ base64?: unknown; mimetype?: unknown } | null>(
      'POST',
      `/chat/getBase64FromMediaMessage/${nomeNoCaminho(nome)}`,
      { corpo: { message: mensagem, convertToMp4: false }, tempoLimite: opcoes.tempoLimite ?? TEMPO_LIMITE_PARA_BUSCAR_ARQUIVO },
    );
    const base64 = resposta?.base64;
    if (typeof base64 !== 'string' || !base64) return { ok: false, detalhe: 'a Evolution respondeu sem o arquivo' };
    const dados = Buffer.from(base64, 'base64');
    if (dados.length === 0) return { ok: false, detalhe: 'a Evolution devolveu um arquivo vazio' };
    return { ok: true, dados, conteudo: typeof resposta?.mimetype === 'string' ? resposta.mimetype : null };
  } catch (erro) {
    if (!(erro instanceof ErroEvolution)) return { ok: false, detalhe: 'erro inesperado ao chamar a Evolution' };
    return { ok: false, detalhe: erro.status ? `HTTP ${erro.status}: ${erro.message}` : erro.message };
  }
}
