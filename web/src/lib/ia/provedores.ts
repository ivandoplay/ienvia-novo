import 'server-only';

import type { Buffer } from 'node:buffer';
import { enderecoPublico } from '@/lib/env';
import { PROVEDORES, type MotivoDoErroDeIa, type Provedor } from '@/lib/ia/regras';

/**
 * Conversa com os provedores de IA (Google Gemini, OpenRouter e NVIDIA), usando a chave de cada cliente.
 * Só roda no servidor: a chave nunca vai para o navegador nem para os registros (logs).
 *
 * Os formatos de pedido e de resposta seguem a documentação oficial de cada um; as respostas de erro
 * foram conferidas com chamadas de verdade (apoio-da-reconstrucao/ia-respostas-reais.txt).
 */

export { PROVEDORES };
export type { MotivoDoErroDeIa, Provedor };

export class ErroDeIa extends Error {
  constructor(
    readonly provedor: Provedor,
    readonly motivo: MotivoDoErroDeIa,
    /** O que o provedor disse, já sem nada que pareça uma chave. Serve para o registro, não para a tela. */
    mensagem: string,
    readonly status?: number,
  ) {
    super(mensagem);
    this.name = 'ErroDeIa';
  }
}

/** Uma fala da conversa, na ordem em que aconteceu. */
export interface Fala {
  de: 'cliente' | 'atendente';
  texto: string;
}

/** Um arquivo que acompanha a última fala do cliente (foto, áudio, PDF). */
export interface AnexoParaIa {
  /** Tipo do conteúdo, por exemplo "image/jpeg" ou "audio/ogg". */
  tipo: string;
  dados: Buffer;
}

export interface PedidoDeResposta {
  provedor: Provedor;
  chave: string;
  modelo: string;
  /** As instruções do atendente (o "cérebro"). */
  sistema: string;
  /** A conversa até aqui; a última fala tem de ser do cliente. */
  conversa: Fala[];
  anexo?: AnexoParaIa | null;
  /** 0 = previsível, 1 = solta. */
  temperatura?: number;
  tempoLimiteMs?: number;
}

export interface RespostaDeIa {
  provedor: Provedor;
  /**
   * O nome do modelo como o provedor informou na resposta. Pode ser diferente do nome pedido
   * (a NVIDIA responde "private/nvidia/..."). Serve para registro; na tela, mostre o nome pedido.
   */
  modelo: string;
  texto: string;
  tokens: { entrada: number | null; saida: number | null };
  duracaoMs: number;
}

export interface ModeloDisponivel {
  id: string;
  nome: string;
  /** Só o OpenRouter informa (lá existem modelos pagos e gratuitos lado a lado). */
  gratuito?: boolean;
}

const TEMPO_LIMITE_DA_RESPOSTA = 30_000;
const TEMPO_LIMITE_DA_LISTA = 15_000;
/** Teto de tamanho da resposta, em tokens. Uma resposta de WhatsApp usa muito menos; a folga é para os modelos que "pensam" antes. */
const LIMITE_DE_SAIDA = 4096;

const semBarraNoFinal = (endereco: string) => endereco.trim().replace(/\/+$/, '');

const ENDERECO_OFICIAL: Record<Provedor, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
};

const VARIAVEL_DE_TESTE: Record<Provedor, string> = {
  gemini: 'IENVIA_GEMINI_URL',
  openrouter: 'IENVIA_OPENROUTER_URL',
  nvidia: 'IENVIA_NVIDIA_URL',
};

/** O endereço aponta para esta mesma máquina? (É onde o servidor de mentira dos testes roda.) */
function ehDestaMaquina(endereco: string): boolean {
  try {
    const { protocol, hostname } = new URL(endereco);
    return (protocol === 'http:' || protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Endereços dos provedores. As variáveis IENVIA_GEMINI_URL, IENVIA_OPENROUTER_URL e IENVIA_NVIDIA_URL existem
 * só para os testes apontarem para um servidor de mentira, e por isso só valem quando apontam para ESTA máquina:
 * qualquer outro endereço é ignorado, e a chave de um cliente nunca é enviada a um servidor que não
 * seja o do próprio provedor, nem por engano de configuração.
 */
export function enderecoDoProvedor(provedor: Provedor, ambiente: Record<string, string | undefined> = process.env): string {
  const trocado = ambiente[VARIAVEL_DE_TESTE[provedor]]?.trim();
  return semBarraNoFinal(trocado && ehDestaMaquina(trocado) ? trocado : ENDERECO_OFICIAL[provedor]);
}

/** Tira de um texto qualquer coisa com cara de chave de API, antes de ele ir para um registro. */
export function semChaves(texto: string): string {
  return texto
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[chave]')
    .replace(/sk-or-[0-9A-Za-z_-]{6,}/g, '[chave]')
    .replace(/nvapi-[0-9A-Za-z_-]{6,}/g, '[chave]')
    .replace(/(Bearer\s+)[0-9A-Za-z._-]{8,}/gi, '$1[chave]');
}

type Json = Record<string, unknown>;
const objeto = (valor: unknown): Json | null => (valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Json) : null);
const texto = (valor: unknown): string => (typeof valor === 'string' ? valor : '');
const numero = (valor: unknown): number | null => (typeof valor === 'number' && Number.isFinite(valor) ? valor : null);

interface Resposta {
  status: number;
  /** O corpo lido como JSON, ou `null` quando não era JSON. */
  dados: unknown;
  /** O começo do corpo como veio. Alguns erros chegam em texto puro, sem JSON. */
  bruto: string;
}

const MODO_SEM_CACHE: RequestInit = 'Deno' in globalThis ? {} : { cache: 'no-store' };

async function chamar(provedor: Provedor, url: string, inicio: RequestInit, tempoLimiteMs: number): Promise<Resposta> {
  let resposta: Response;
  let bruto: string;
  try {
    resposta = await fetch(url, { ...inicio, signal: AbortSignal.timeout(tempoLimiteMs), ...MODO_SEM_CACHE });
    bruto = await resposta.text();
  } catch (erro) {
    const nome = erro instanceof Error ? erro.name : '';
    if (nome === 'TimeoutError' || nome === 'AbortError') {
      throw new ErroDeIa(provedor, 'tempo', `Sem resposta em ${Math.round(tempoLimiteMs / 1000)} s.`);
    }
    throw new ErroDeIa(provedor, 'rede', semChaves(erro instanceof Error ? erro.message : String(erro)).slice(0, 200));
  }
  let dados: unknown = null;
  try {
    dados = bruto ? JSON.parse(bruto) : null;
  } catch {
    dados = null;
  }
  return { status: resposta.status, dados, bruto: bruto.trim().slice(0, 400) };
}

// ---------------------------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------------------------

/** "models/gemini-x" e "gemini-x" são o mesmo modelo. Devolve `null` quando o nome não serve para o Gemini. */
export function nomeDoModeloGemini(modelo: string): string | null {
  const limpo = modelo.trim().replace(/^models\//, '');
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(limpo) ? limpo : null;
}

function erroDoGemini(status: number, dados: unknown, modelo: string): ErroDeIa {
  const erro = objeto(objeto(dados)?.error);
  const mensagem = semChaves(texto(erro?.message) || `HTTP ${status}`).slice(0, 300);
  const estado = texto(erro?.status);
  const detalhes = Array.isArray(erro?.details) ? erro.details : [];
  const chaveRecusada = detalhes.some((detalhe) => texto(objeto(detalhe)?.reason) === 'API_KEY_INVALID') || /api key not valid/i.test(mensagem);

  let motivo: MotivoDoErroDeIa = 'recusada';
  // O Google bloqueia sozinho a chave que encontra publicada em algum lugar; só uma chave nova resolve.
  if (/reported as leaked/i.test(mensagem)) motivo = 'chave_vazada';
  else if (chaveRecusada || status === 401 || status === 403 || estado === 'PERMISSION_DENIED' || estado === 'UNAUTHENTICATED') motivo = 'chave_invalida';
  else if (status === 404 || estado === 'NOT_FOUND') motivo = 'modelo_inexistente';
  else if (status === 429 || estado === 'RESOURCE_EXHAUSTED') motivo = 'limite';
  else if (status >= 500) motivo = 'indisponivel';
  return new ErroDeIa('gemini', motivo, motivo === 'modelo_inexistente' ? `Modelo "${modelo}": ${mensagem}` : mensagem, status);
}

const PARADAS_POR_FILTRO = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION', 'SPII', 'IMAGE_SAFETY'];

async function gerarComGemini(pedido: PedidoDeResposta, tempoLimiteMs: number): Promise<Omit<RespostaDeIa, 'duracaoMs'>> {
  const modelo = nomeDoModeloGemini(pedido.modelo);
  if (!modelo) throw new ErroDeIa('gemini', 'modelo_inexistente', `Nome de modelo inválido: "${pedido.modelo.slice(0, 60)}".`);

  // O Gemini espera as falas alternando "user" e "model"; falas seguidas da mesma pessoa viram uma só.
  const conteudos: Array<{ role: 'user' | 'model'; parts: Json[] }> = [];
  for (const fala of pedido.conversa) {
    const papel = fala.de === 'cliente' ? 'user' : 'model';
    const anterior = conteudos.at(-1);
    if (anterior && anterior.role === papel) anterior.parts.push({ text: fala.texto });
    else conteudos.push({ role: papel, parts: [{ text: fala.texto }] });
  }
  if (pedido.anexo) {
    const ultima = conteudos.at(-1);
    const parte = { inlineData: { mimeType: pedido.anexo.tipo, data: pedido.anexo.dados.toString('base64') } };
    if (ultima && ultima.role === 'user') ultima.parts.push(parte);
    else conteudos.push({ role: 'user', parts: [parte] });
  }

  const { status, dados } = await chamar(
    'gemini',
    `${enderecoDoProvedor('gemini')}/v1beta/models/${modelo}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': pedido.chave },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: pedido.sistema }] },
        contents: conteudos,
        generationConfig: { temperature: pedido.temperatura ?? 0.35, maxOutputTokens: LIMITE_DE_SAIDA },
      }),
    },
    tempoLimiteMs,
  );
  if (status < 200 || status >= 300) throw erroDoGemini(status, dados, modelo);

  const corpo = objeto(dados);
  const candidato = objeto(Array.isArray(corpo?.candidates) ? corpo.candidates[0] : null);
  const partes = objeto(candidato?.content)?.parts;
  // Modelos que "pensam" devolvem o raciocínio em partes marcadas com thought: isso não é a resposta.
  const resposta = (Array.isArray(partes) ? partes : [])
    .map((parte) => objeto(parte))
    .filter((parte): parte is Json => parte !== null && parte.thought !== true)
    .map((parte) => texto(parte.text))
    .join('')
    .trim();

  if (!resposta) {
    const bloqueio = texto(objeto(corpo?.promptFeedback)?.blockReason);
    const parada = texto(candidato?.finishReason);
    if (bloqueio || PARADAS_POR_FILTRO.includes(parada)) {
      throw new ErroDeIa('gemini', 'bloqueada', `O Gemini recusou o conteúdo (${bloqueio || parada}).`, status);
    }
    throw new ErroDeIa('gemini', 'resposta_vazia', `O Gemini respondeu sem texto${parada ? ` (${parada})` : ''}.`, status);
  }

  const uso = objeto(corpo?.usageMetadata);
  return {
    provedor: 'gemini',
    modelo: texto(corpo?.modelVersion) || modelo,
    texto: resposta,
    tokens: { entrada: numero(uso?.promptTokenCount), saida: numero(uso?.candidatesTokenCount) },
  };
}

/** Modelos que aceitam "generateContent" mas não servem para conversar por texto (voz, imagem, vídeo...). */
const NAO_E_DE_CONVERSA = /(tts|image|imagen|embedding|live|transcribe|translate|omni|banana|veo|aqa|robotics|computer-use)/i;

async function listarModelosDoGemini(chave: string): Promise<ModeloDisponivel[]> {
  const { status, dados } = await chamar(
    'gemini',
    `${enderecoDoProvedor('gemini')}/v1beta/models?pageSize=1000`,
    { method: 'GET', headers: { 'x-goog-api-key': chave } },
    TEMPO_LIMITE_DA_LISTA,
  );
  if (status < 200 || status >= 300) throw erroDoGemini(status, dados, '');
  const modelos = objeto(dados)?.models;
  return (Array.isArray(modelos) ? modelos : [])
    .map((item) => objeto(item))
    .filter((item): item is Json => item !== null)
    .filter((item) => Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes('generateContent'))
    .map((item) => ({ id: texto(item.name).replace(/^models\//, ''), nome: texto(item.displayName) }))
    .filter((modelo) => nomeDoModeloGemini(modelo.id) !== null && !NAO_E_DE_CONVERSA.test(modelo.id))
    .map((modelo) => ({ id: modelo.id, nome: modelo.nome || modelo.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// Transcrição de áudio (Gemini)
// ---------------------------------------------------------------------------------------------

/** Modelos que aceitam áudio e devolvem texto. O primeiro que existir na chave do cliente é usado. */
export const MODELOS_DE_TRANSCRICAO = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'] as const;

/** O arquivo enviado é limitado a 16 MB; o pedido inteiro (base64 + prompt) fica abaixo do teto da API. */
const LIMITE_DO_AUDIO_EM_BYTES = 16 * 1024 * 1024;
const TEMPO_LIMITE_DA_TRANSCRICAO = 55_000;

const INSTRUCAO_DE_TRANSCRICAO = [
  'Transcreva o áudio em português do Brasil, exatamente como foi falado, sem resumir e sem comentar.',
  'Escreva em texto corrido, com pontuação natural. Não use marcadores, títulos, aspas ou negrito.',
  'Se houver mais de um falante, separe as falas começando com "Falante 1:", "Falante 2:" e assim por diante.',
  'Se o áudio estiver mudo, com ruído ou impossível de entender, responda apenas: [inaudível]',
].join(' ');

/** Converte bytes em base64 sem depender de Buffer (o arquivo roda também fora do Node). */
function bytesParaBase64(bytes: Uint8Array): string {
  let binario = '';
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    binario += String.fromCharCode(...bytes.subarray(i, i + passo));
  }
  return btoa(binario);
}

/**
 * Manda o áudio para o Gemini e devolve a transcrição.
 * A chave do cliente nunca sai daqui: só vai para o endereço oficial do Gemini (ou o de teste local).
 */
export async function transcreverAudio(pedido: {
  chave: string;
  audio: Uint8Array;
  contentType: string;
  modelo?: string;
}): Promise<{ texto: string; modelo: string }> {
  if (!pedido.chave) throw new ErroDeIa('gemini', 'chave_invalida', 'Nenhuma chave do Gemini cadastrada.');
  if (pedido.audio.byteLength === 0) throw new ErroDeIa('gemini', 'recusada', 'O arquivo de áudio chegou vazio.');
  if (pedido.audio.byteLength > LIMITE_DO_AUDIO_EM_BYTES) {
    throw new ErroDeIa('gemini', 'recusada', 'O áudio passa de 16 MB. Corte em partes menores.');
  }
  const base64 = bytesParaBase64(pedido.audio);

  const preferido = pedido.modelo ? nomeDoModeloGemini(pedido.modelo) : null;
  const candidatos = preferido ? [preferido] : [...MODELOS_DE_TRANSCRICAO];
  const corpo = {
    contents: [
      {
        role: 'user',
        parts: [
          // A API REST do Gemini só aceita camelCase: em snake_case ela ignora a parte e transcreve o vazio.
          { inlineData: { mimeType: pedido.contentType, data: base64 } },
          { text: INSTRUCAO_DE_TRANSCRICAO },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 },
  };

  let ultimoErro: ErroDeIa | null = null;
  for (const modelo of candidatos) {
    const { status, dados } = await chamar(
      'gemini',
      `${enderecoDoProvedor('gemini')}/v1beta/models/${modelo}:generateContent`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': pedido.chave }, body: JSON.stringify(corpo) },
      TEMPO_LIMITE_DA_TRANSCRICAO,
    );

    if (status < 200 || status >= 300) {
      const erro = erroDoGemini(status, dados, modelo);
      ultimoErro = erro;
      // Modelo que não existe nesta chave: tenta o próximo da lista.
      if (erro.motivo === 'modelo_inexistente') continue;
      throw erro;
    }

    const candidatosDeSaida = objeto(dados)?.candidates;
    const primeira = Array.isArray(candidatosDeSaida) ? objeto(candidatosDeSaida[0]) : null;
    const partes = objeto(primeira?.content)?.parts;
    const dito = (Array.isArray(partes) ? partes : [])
      .map((parte) => texto(objeto(parte)?.text))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const bloqueio = texto(objeto(objeto(dados)?.promptFeedback)?.blockReason);
    if (bloqueio) throw new ErroDeIa('gemini', 'bloqueada', `O Gemini recusou o áudio (${bloqueio}).`, status);
    if (!dito) throw new ErroDeIa('gemini', 'resposta_vazia', 'O Gemini respondeu sem transcrição.', status);

    return { texto: dito, modelo };
  }

  throw ultimoErro ?? new ErroDeIa('gemini', 'modelo_inexistente', 'Nenhum modelo de transcrição disponível nesta chave.');
}

// ---------------------------------------------------------------------------------------------
// OpenRouter (formato "chat completions", igual ao da OpenAI)
// ---------------------------------------------------------------------------------------------

function erroDoOpenRouter(status: number, dados: unknown, modelo: string): ErroDeIa {
  const erro = objeto(objeto(dados)?.error);
  const codigo = numero(erro?.code) ?? status;
  const mensagem = semChaves(texto(erro?.message) || `HTTP ${status}`).slice(0, 300);

  let motivo: MotivoDoErroDeIa = 'recusada';
  if (codigo === 401) motivo = 'chave_invalida';
  // "No endpoints found that support image input": o modelo existe, só não enxerga fotos.
  else if (/support (image|audio|file|video|pdf)\w* input/i.test(mensagem)) motivo = 'nao_suportado';
  else if (codigo === 402) motivo = 'sem_credito';
  else if (codigo === 403) motivo = 'bloqueada';
  else if (codigo === 404 || /not a valid model|no endpoints found|model not found/i.test(mensagem)) motivo = 'modelo_inexistente';
  else if (codigo === 408) motivo = 'tempo';
  else if (codigo === 429) motivo = 'limite';
  else if (codigo >= 500) motivo = 'indisponivel';
  return new ErroDeIa('openrouter', motivo, motivo === 'modelo_inexistente' ? `Modelo "${modelo}": ${mensagem}` : mensagem, status);
}

function cabecalhosDoOpenRouter(chave: string | null): Record<string, string> {
  // O nome e o endereço identificam o aplicativo no painel do OpenRouter; não são segredo.
  const endereco = enderecoPublico();
  return {
    'content-type': 'application/json',
    'x-title': 'Ienvia',
    ...(endereco ? { 'http-referer': endereco } : {}),
    ...(chave ? { authorization: `Bearer ${chave}` } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// NVIDIA (build.nvidia.com) — o mesmo formato "chat completions"
// ---------------------------------------------------------------------------------------------

/**
 * A NVIDIA responde cada erro num formato: {status,title,detail}, {message,type,code}, {error:{message}},
 * texto puro ou corpo vazio. Aqui o que manda é o número do status; o texto só completa.
 */
function erroDaNvidia(status: number, dados: unknown, bruto: string, modelo: string): ErroDeIa {
  const corpo = objeto(dados);
  const dito = texto(corpo?.detail) || texto(corpo?.message) || texto(objeto(corpo?.error)?.message) || texto(corpo?.title) || (corpo ? '' : bruto);
  const mensagem = semChaves(dito || `HTTP ${status}`).slice(0, 300);

  let motivo: MotivoDoErroDeIa = 'recusada';
  if (status === 401 || status === 403) motivo = 'chave_invalida';
  else if (status === 402) motivo = 'sem_credito';
  // 404: o modelo não existe, ou está na lista mas não foi liberado para esta conta ("Function ...: Not found for account").
  else if (status === 404) motivo = 'modelo_inexistente';
  else if (status === 408) motivo = 'tempo';
  else if (status === 429) motivo = 'limite';
  // Foto mandada a um modelo que só lê texto: "multimodal processing is not enabled".
  else if (/multimodal/i.test(mensagem)) motivo = 'nao_suportado';
  else if (/content safety|safety screening/i.test(mensagem)) motivo = 'bloqueada';
  else if (status >= 500) motivo = 'indisponivel';
  return new ErroDeIa('nvidia', motivo, motivo === 'modelo_inexistente' ? `Modelo "${modelo}": ${mensagem}` : mensagem, status);
}

// ---------------------------------------------------------------------------------------------
// O pedido no formato "chat completions", que serve ao OpenRouter e à NVIDIA
// ---------------------------------------------------------------------------------------------

async function gerarNoFormatoDeConversa(
  provedor: 'openrouter' | 'nvidia',
  pedido: PedidoDeResposta,
  tempoLimiteMs: number,
): Promise<Omit<RespostaDeIa, 'duracaoMs'>> {
  const nome = provedor === 'nvidia' ? 'A NVIDIA' : 'O OpenRouter';
  const modelo = pedido.modelo.trim();
  const anexo = pedido.anexo ?? null;
  // Só foto. Áudio NUNCA vai para estes dois: nos testes de verdade, a maioria dos modelos da NVIDIA descartou
  // o áudio calada e respondeu como se ele não existisse (ver apoio-da-reconstrucao/ia-respostas-reais.txt).
  if (anexo && !anexo.tipo.startsWith('image/')) {
    throw new ErroDeIa(provedor, 'nao_suportado', `${nome} não recebe este tipo de arquivo (${anexo.tipo}).`);
  }

  const mensagens: Array<{ role: 'system' | 'user' | 'assistant'; content: string | Json[] }> = [{ role: 'system', content: pedido.sistema }];
  for (const fala of pedido.conversa) {
    const papel = fala.de === 'cliente' ? 'user' : 'assistant';
    const anterior = mensagens.at(-1);
    if (anterior && anterior.role === papel && typeof anterior.content === 'string') anterior.content = `${anterior.content}\n${fala.texto}`;
    else mensagens.push({ role: papel, content: fala.texto });
  }
  if (anexo) {
    const imagem = { type: 'image_url', image_url: { url: `data:${anexo.tipo};base64,${anexo.dados.toString('base64')}` } };
    const ultima = mensagens.at(-1);
    if (ultima && ultima.role === 'user' && typeof ultima.content === 'string') ultima.content = [{ type: 'text', text: ultima.content }, imagem];
    else mensagens.push({ role: 'user', content: [imagem] });
  }

  const corpoDoPedido: Json = { model: modelo, messages: mensagens, temperature: pedido.temperatura ?? 0.35, max_tokens: LIMITE_DE_SAIDA };
  // Quase todo modelo novo da NVIDIA "pensa" antes de responder e, sem este pedido, gasta ~10 s (ou a resposta
  // inteira) raciocinando. Com ele, o modelo padrão respondeu em menos de 1 s. Quem não conhece o campo ignora.
  if (provedor === 'nvidia') corpoDoPedido.chat_template_kwargs = { enable_thinking: false };

  const { status, dados, bruto } = await chamar(
    provedor,
    `${enderecoDoProvedor(provedor)}/chat/completions`,
    {
      method: 'POST',
      headers:
        provedor === 'nvidia'
          ? { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${pedido.chave}` }
          : cabecalhosDoOpenRouter(pedido.chave),
      body: JSON.stringify(corpoDoPedido),
    },
    tempoLimiteMs,
  );
  const corpo = objeto(dados);
  const erroDoProvedor = (situacao: number, conteudo: unknown) =>
    provedor === 'nvidia' ? erroDaNvidia(situacao, conteudo, bruto, modelo) : erroDoOpenRouter(situacao, conteudo, modelo);
  // O OpenRouter às vezes responde "200" com o erro do fornecedor dentro do corpo.
  if (status < 200 || status >= 300 || corpo?.error) throw erroDoProvedor(status, dados);

  const escolha = objeto(Array.isArray(corpo?.choices) ? corpo.choices[0] : null);
  if (escolha?.error) throw erroDoProvedor(status, { error: escolha.error });
  // Só o campo "content" é a resposta. O raciocínio do modelo vem à parte ("reasoning_content") e nunca vai ao cliente.
  const conteudo = objeto(escolha?.message)?.content;
  const resposta = (
    Array.isArray(conteudo)
      ? conteudo.map((parte) => (objeto(parte)?.type === 'text' ? texto(objeto(parte)?.text) : '')).join('')
      : texto(conteudo)
  ).trim();

  if (!resposta) {
    const parada = texto(escolha?.finish_reason);
    if (parada === 'content_filter') throw new ErroDeIa(provedor, 'bloqueada', 'O modelo recusou o conteúdo (content_filter).', status);
    const pensou = texto(objeto(escolha?.message)?.reasoning_content) !== '';
    throw new ErroDeIa(
      provedor,
      'resposta_vazia',
      pensou ? `O modelo gastou a resposta inteira raciocinando e não escreveu nada${parada ? ` (${parada})` : ''}.` : `O modelo respondeu sem texto${parada ? ` (${parada})` : ''}.`,
      status,
    );
  }

  const uso = objeto(corpo?.usage);
  return {
    provedor,
    modelo: texto(corpo?.model) || modelo,
    texto: resposta,
    tokens: { entrada: numero(uso?.prompt_tokens), saida: numero(uso?.completion_tokens) },
  };
}

/**
 * A lista da NVIDIA mistura modelos de conversa com modelos de busca, de filtro, de tradução, de leitura de
 * documentos e de programação, e só traz o nome de cada um. Estes pedaços de nome saíram da lista de verdade
 * (84 modelos em 11/11/2026).
 */
const NAO_CONVERSA_NA_NVIDIA = /(embed|nvclip|guard|safety|topic-control|parse|riva|reward|detector|calibration|deplot|kosmos|fuyu|neva|vila|cosmos|diffusion|code|starcoder)/i;

async function listarModelosDaNvidia(): Promise<ModeloDisponivel[]> {
  // A lista da NVIDIA é pública e igual para todo mundo: ela NÃO diz quais modelos a conta pode usar
  // (vários respondem "não liberado" na hora da conversa). Por isso a chave nem é enviada aqui.
  const { status, dados, bruto } = await chamar(
    'nvidia',
    `${enderecoDoProvedor('nvidia')}/models`,
    { method: 'GET', headers: { accept: 'application/json' } },
    TEMPO_LIMITE_DA_LISTA,
  );
  if (status < 200 || status >= 300) throw erroDaNvidia(status, dados, bruto, '');
  const modelos = objeto(dados)?.data;
  return (Array.isArray(modelos) ? modelos : [])
    .map((item) => texto(objeto(item)?.id))
    .filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(id) && !NAO_CONVERSA_NA_NVIDIA.test(id))
    .map((id) => ({ id, nome: id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function listarModelosDoOpenRouter(chave: string | null): Promise<ModeloDisponivel[]> {
  // A lista do OpenRouter é pública; a chave, quando existe, vai junto só por educação.
  const { status, dados } = await chamar(
    'openrouter',
    `${enderecoDoProvedor('openrouter')}/models`,
    { method: 'GET', headers: cabecalhosDoOpenRouter(chave) },
    TEMPO_LIMITE_DA_LISTA,
  );
  if (status < 200 || status >= 300) throw erroDoOpenRouter(status, dados, '');
  const modelos = objeto(dados)?.data;
  return (Array.isArray(modelos) ? modelos : [])
    .map((item) => objeto(item))
    .filter((item): item is Json => item !== null && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(texto(item.id)))
    .filter((item) => {
      const saidas = objeto(item.architecture)?.output_modalities;
      return !Array.isArray(saidas) || saidas.includes('text');
    })
    .map((item) => {
      const precos = objeto(item.pricing);
      return {
        id: texto(item.id),
        nome: texto(item.name) || texto(item.id),
        gratuito: Number(precos?.prompt) === 0 && Number(precos?.completion) === 0,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------

/** Pede uma resposta ao provedor. Lança `ErroDeIa` quando não dá certo. Nunca tenta de novo sozinha. */
export async function gerarResposta(pedido: PedidoDeResposta): Promise<RespostaDeIa> {
  const inicio = Date.now();
  if (!pedido.chave.trim()) throw new ErroDeIa(pedido.provedor, 'chave_invalida', 'Nenhuma chave cadastrada para este provedor.');
  if (pedido.conversa.length === 0 && !pedido.anexo) throw new ErroDeIa(pedido.provedor, 'recusada', 'Não há o que responder.');
  const prazo = pedido.tempoLimiteMs ?? TEMPO_LIMITE_DA_RESPOSTA;
  const resposta = pedido.provedor === 'gemini' ? await gerarComGemini(pedido, prazo) : await gerarNoFormatoDeConversa(pedido.provedor, pedido, prazo);
  return { ...resposta, duracaoMs: Date.now() - inicio };
}

/**
 * Os modelos de conversa de um provedor. No Gemini a lista depende da chave; no OpenRouter e na NVIDIA ela é
 * pública e funciona mesmo sem chave (e, na NVIDIA, nem todo modelo listado está liberado para a conta).
 */
export async function listarModelos(provedor: Provedor, chave: string | null): Promise<ModeloDisponivel[]> {
  if (provedor === 'gemini') {
    if (!chave?.trim()) throw new ErroDeIa('gemini', 'chave_invalida', 'Nenhuma chave cadastrada para este provedor.');
    return listarModelosDoGemini(chave.trim());
  }
  if (provedor === 'nvidia') return listarModelosDaNvidia();
  return listarModelosDoOpenRouter(chave?.trim() || null);
}

/** Uma pergunta mínima, só para saber se a chave e o modelo funcionam. */
export function testarConexao(provedor: Provedor, chave: string, modelo: string): Promise<RespostaDeIa> {
  return gerarResposta({
    provedor,
    chave,
    modelo,
    sistema: 'Isto é um teste de conexão. Responda apenas com a palavra OK.',
    conversa: [{ de: 'cliente', texto: 'Teste de conexão.' }],
    temperatura: 0,
    tempoLimiteMs: 20_000,
  });
}
