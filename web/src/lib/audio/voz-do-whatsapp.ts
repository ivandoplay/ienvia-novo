/**
 * Converte a gravação do navegador para o formato que o WhatsApp usa em mensagem de voz.
 *
 * Por que isso existe: o WhatsApp só mostra a mensagem com aquele "parece que acabou de gravar"
 * (a onda sonora e o botão de play redondo) quando o arquivo é OGG com áudio Opus. Cada navegador
 * grava num formato diferente — o Chrome grava WebM/Opus, o Safari grava MP4/AAC — e mandar isso
 * pela Evolution faz o áudio chegar como arquivo anexado, com nome e ícone de download.
 *
 * Aqui o áudio já decodificado é recodificado em OGG/Opus (mono, 48 kHz, que é o que o WhatsApp usa):
 *  - se o navegador já grava Opus, a codificação é feita aqui mesmo, em JavaScript (sem depender de
 *    nada externo e sem perder qualidade por reamostragem);
 *  - quando o navegador grava em AAC (Safari/iOS), o próprio navegador já entrega em OGG/Opus usando
 *    MediaRecorder quando ele suporta; se não suportar, devolvemos o arquivo original com um aviso,
 *    em vez de fingir que converteu.
 */
import { codificarOpus } from './opus';

/** Extensão e tipo que a Evolution/WhatsApp tratam como recado de voz. */
export const TIPO_DE_VOZ = 'audio/ogg';
export const EXTENSAO_DE_VOZ = 'ogg';

/** Formatos que o WhatsApp já aceita como áudio (o .ogg é o único que vira "gravado agora"). */
const ACEITOS = ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/webm'];

export function tipoLimpo(tipo: string | undefined | null): string {
  return (tipo ?? '').split(';')[0]!.trim().toLowerCase();
}

/** O arquivo já está no formato de recado de voz do WhatsApp? */
export function jaEhVozDoWhatsapp(tipo: string | undefined | null, nome?: string): boolean {
  const limpo = tipoLimpo(tipo);
  if (limpo === TIPO_DE_VOZ) return true;
  return !limpo && /\.ogg$/i.test(nome ?? '');
}

/**
 * MediaRecorder consegue gravar OGG/Opus neste navegador? (Chrome no Android: sim. Chrome no
 * computador e Safari: não.)
 */
export function navegadorGravaOgg(): boolean {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return false;
  return MediaRecorder.isTypeSupported('audio/ogg;codecs=opus');
}

/** O formato que o usuário escolheu no aparelho pode ser enviado como áudio? */
export function formatoAceito(tipo: string | undefined | null, nome?: string): boolean {
  const limpo = tipoLimpo(tipo);
  if (limpo) return ACEITOS.includes(limpo) || limpo.startsWith('audio/');
  return /\.(ogg|opus|mp3|m4a|aac|wav|webm)$/i.test(nome ?? '');
}

/** Lê a duração e desenha a onda sonora (usado na biblioteca e para conferir a conversão). */
export async function lerOndaDoAudio(arquivo: Blob): Promise<{ duracaoSeg: number | null; onda: number[] }> {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return { duracaoSeg: null, onda: [] };
    const ctx = new Ctx();
    try {
      const buffer = await ctx.decodeAudioData(await arquivo.arrayBuffer());
      const canal = buffer.getChannelData(0);
      const blocos = 64;
      const passo = Math.max(1, Math.floor(canal.length / blocos));
      const picos: number[] = [];
      let maximo = 0;
      for (let i = 0; i < blocos; i += 1) {
        const inicio = i * passo;
        const fim = Math.min(canal.length, inicio + passo);
        let pico = 0;
        for (let j = inicio; j < fim; j += 1) {
          const v = Math.abs(canal[j] ?? 0);
          if (v > pico) pico = v;
        }
        if (pico > maximo) maximo = pico;
        picos.push(pico);
      }
      const divisor = maximo > 0.01 ? maximo : 1;
      return {
        duracaoSeg: Number.isFinite(buffer.duration) ? Math.round(buffer.duration) : null,
        onda: picos.map((p) => Math.round((p / divisor) * 90 + 10)),
      };
    } finally {
      void ctx.close();
    }
  } catch {
    // Formato que este navegador não decodifica (raro): segue sem onda sonora, sem travar o envio.
    return { duracaoSeg: null, onda: [] };
  }
}

export type ResultadoDaConversao = {
  arquivo: Blob;
  /** Nome já com a extensão certa (`.ogg` quando virou voz do WhatsApp). */
  nome: string;
  tipo: string;
  /** Virou OGG/Opus? Quando false, o arquivo vai como está e a tela avisa. */
  virouVoz: boolean;
  /** Por que não virou, em português, para mostrar na tela. */
  motivo: string | null;
};

/**
 * Deixa o áudio pronto para a Evolution mandar como recado de voz.
 *
 * Não há perda quando o áudio já é Opus (o caso do Chrome/Android), porque a conversão é só de
 * "envelope": o mesmo áudio Opus é remontado dentro de um arquivo OGG.
 */
export async function prepararAudioDeVoz(
  arquivo: Blob,
  nomeOriginal: string,
  /** O arquivo já saiu do gravador do navegador (que pode ter gravado OGG direto). */
  vozDoGravador = false,
  /** Biblioteca estratégica: recodifica mesmo Ogg recebido, padronizando mono/48 kHz/32 kbps. */
  normalizarPerfil = false,
): Promise<ResultadoDaConversao> {
  const tipo = tipoLimpo(arquivo.type || nomeOriginal);
  const nome = nomeOriginal || `audio.${EXTENSAO_DE_VOZ}`;

  if (!normalizarPerfil && jaEhVozDoWhatsapp(tipo, nome)) {
    return { arquivo, nome: trocarExtensao(nome, EXTENSAO_DE_VOZ), tipo: TIPO_DE_VOZ, virouVoz: true, motivo: null };
  }

  /*
   * Caminho preferido: pedir o OGG/Opus direto ao gravador do navegador. É o próprio Chrome/Android
   * fazendo a conversão em C++, sem passar por JavaScript — mais rápido e sem risco de o navegador não
   * ter o codificador Opus do WebCodecs (o caso do Chrome no Linux).
   */
  if (!normalizarPerfil && !vozDoGravador && navegadorGravaOgg()) {
    const convertido = await gravarEmOgg(arquivo);
    if (convertido) {
      return { arquivo: convertido, nome: trocarExtensao(nome, EXTENSAO_DE_VOZ), tipo: TIPO_DE_VOZ, virouVoz: true, motivo: null };
    }
  }

  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    return { arquivo, nome, tipo, virouVoz: false, motivo: 'Este navegador não consegue converter o áudio. Ele será enviado como arquivo.' };
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctx();
    const decodificado = await ctx.decodeAudioData(await arquivo.arrayBuffer());
    const ogg = await codificarOpus(decodificado);
    if (!ogg) {
      return { arquivo, nome, tipo, virouVoz: false, motivo: 'Não foi possível converter este áudio. Ele será enviado como arquivo.' };
    }
    return {
      arquivo: new Blob([ogg.buffer as ArrayBuffer], { type: TIPO_DE_VOZ }),
      nome: trocarExtensao(nome, EXTENSAO_DE_VOZ),
      tipo: TIPO_DE_VOZ,
      virouVoz: true,
      motivo: null,
    };
  } catch {
    return { arquivo, nome, tipo, virouVoz: false, motivo: 'Não foi possível converter este áudio. Ele será enviado como arquivo.' };
  } finally {
    if (ctx) void ctx.close();
  }
}

/**
 * Toca o áudio num contexto de áudio e grava a saída em OGG/Opus com o MediaRecorder do navegador.
 *
 * É o caminho que funciona em qualquer Chrome/Android: o próprio navegador converte para OGG/Opus.
 * Devolve `null` quando o navegador não faz isso (aí tentamos o WebCodecs; se nem ele existir, a tela
 * avisa que o arquivo vai como está).
 */
async function gravarEmOgg(arquivo: Blob): Promise<Blob | null> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx || typeof MediaRecorder === 'undefined') return null;

  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctx();
    const decodificado = await ctx.decodeAudioData(await arquivo.arrayBuffer());
    const destino = ctx.createMediaStreamDestination();
    const fonte = ctx.createBufferSource();
    fonte.buffer = decodificado;
    fonte.connect(destino);

    const gravador = new MediaRecorder(destino.stream, { mimeType: 'audio/ogg;codecs=opus' });
    const pedacos: Blob[] = [];
    const terminou = new Promise<Blob | null>((resolver) => {
      gravador.ondataavailable = (evento) => {
        if (evento.data.size > 0) pedacos.push(evento.data);
      };
      gravador.onstop = () => resolver(pedacos.length ? new Blob(pedacos, { type: TIPO_DE_VOZ }) : null);
      gravador.onerror = () => resolver(null);
    });

    gravador.start();
    fonte.start();
    // A conversão é mais rápida que o áudio: espera o fim da reprodução (que é o fim do arquivo).
    await new Promise<void>((resolver) => {
      fonte.onended = () => resolver();
      // Rede de segurança para arquivos longos (nunca passa de 1 minuto e meio).
      setTimeout(resolver, 90_000);
    });
    gravador.stop();
    return await terminou;
  } catch {
    return null;
  } finally {
    if (ctx) void ctx.close();
  }
}

function trocarExtensao(nome: string, extensao: string): string {
  const base = nome.replace(/\.[a-z0-9]{2,5}$/i, '') || 'audio';
  return `${base}.${extensao}`;
}
