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
const EVENTOS_DO_AVISO = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];

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
  if (resposta.status === 404) throw new ErroEvolution('nao_encontrada', mensagem, 404);
  if (resposta.status === 403 && /already in use/i.test(mensagem)) throw new ErroEvolution('nome_em_uso', mensagem, 403);
  if (resposta.status >= 500) throw new ErroEvolution('incerta', mensagem, resposta.status);
  throw new ErroEvolution('recusada', mensagem, resposta.status);
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
    events: EVENTOS_DO_AVISO,
  };
}

/** Cria a instância na Evolution e já devolve o primeiro QR Code. */
export async function criarInstancia(dados: { nome: string; aviso: Aviso | null }): Promise<QrCode> {
  const resposta = await chamar<{ qrcode?: unknown }>('POST', '/instance/create', {
    corpo: {
      instanceName: dados.nome,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
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
 * Pede um QR Code novo. Informando o número (só dígitos, com código do país), a Evolution
 * devolve também o código de 8 dígitos para conectar sem câmera.
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

/** Para onde a Evolution está mandando os avisos deste chip. `null` se não houver aviso configurado. */
export async function consultarAviso(nome: string): Promise<{ url: string; ligado: boolean } | null> {
  const resposta = await chamar<{ url?: unknown; enabled?: unknown } | null>('GET', `/webhook/find/${nomeNoCaminho(nome)}`);
  if (!resposta || typeof resposta.url !== 'string' || !resposta.url) return null;
  return { url: resposta.url, ligado: resposta.enabled === true };
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
