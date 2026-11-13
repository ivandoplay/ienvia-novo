/**
 * Regras puras de Catálogo (até 5 fotos/PDFs por item) e Biblioteca de Áudios Estratégicos (PTT).
 * Compartilhado entre web, shared, Edge Function e motor local — zero dependências de Node ou DOM.
 */

export const LIMITE_ITENS_CATALOGO = 500;
export const LIMITE_MIDIAS_POR_ITEM = 5;
export const LIMITE_AUDIOS_BIBLIOTECA = 250;

const MB = 1024 * 1024;
export const LIMITE_BYTES_MIDIA_CATALOGO = 16 * MB;
export const LIMITE_BYTES_PDF_CATALOGO = 25 * MB;
export const LIMITE_BYTES_AUDIO_ESTRATEGICO = 16 * MB;

export const TIPOS_IMAGEM_CATALOGO = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const TIPOS_MIDIA_CATALOGO = [...TIPOS_IMAGEM_CATALOGO, 'application/pdf'] as const;

export const VOICE_MIME_CANONICO = 'audio/ogg; codecs=opus';
export const TIPOS_AUDIO_ESTRATEGICO = [
  'audio/ogg',
  'audio/ogg; codecs=opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/aac',
] as const;

export interface ArquivoDeCatalogo {
  id: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  sortOrder: number;
}

export interface ItemDoCatalogo {
  id: string;
  name: string;
  category: string;
  price: string;
  description: string;
  paymentLink: string;
  active: boolean;
  sortOrder: number;
  files: ArquivoDeCatalogo[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AudioEstrategico {
  id: string;
  name: string;
  transcription: string;
  whenToUse: string;
  linkedMessageCode: string;
  aiEnabled: boolean;
  objectKey: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  durationSec: number | null;
  waveform: number[];
  createdAt: string | null;
  updatedAt: string | null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOME_SEGURO_NO_DEPOSITO = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;

export function ehUrlPagamentoSegura(url: string): boolean {
  const limpa = url.trim();
  if (!limpa) return true;
  if (limpa.length > 2000 || /[\u0000-\u001f\u007f\s]/.test(limpa)) return false;
  if (!/^https:\/\//i.test(limpa)) return false;
  const resto = limpa.slice('https://'.length);
  const autoridade = resto.split(/[/?#]/, 1)[0] ?? '';
  if (!autoridade || autoridade.includes('@')) return false;
  return /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(autoridade);
}

export function nomeSeguroParaDeposito(nomeOriginal: string, fallbackExtensao = 'bin'): string {
  const semPasta = nomeOriginal.split(/[\\/]/).pop() ?? '';
  let limpo = semPasta
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/[-.]+$/, '');

  const matchExt = /\.([a-z0-9]{1,8})$/i.exec(limpo);
  let extensao = matchExt?.[1]?.toLowerCase() ?? '';
  if (extensao) {
    limpo = limpo.slice(0, -(extensao.length + 1)).replace(/[-.]+$/, '');
  } else {
    extensao = fallbackExtensao;
  }
  const base = limpo.slice(0, 80).replace(/[-.]+$/, '') || 'arquivo';
  const resultado = extensao ? `${base}.${extensao}` : base;
  return NOME_SEGURO_NO_DEPOSITO.test(resultado) ? resultado : `arquivo.${fallbackExtensao}`;
}

export function caminhoArquivoDeCatalogo(
  workspaceId: string,
  itemId: string,
  fileId: string,
  nomeNoDeposito: string,
): string {
  return `${workspaceId}/catalogo/${itemId}/${fileId}/${nomeNoDeposito}`;
}

export function ehCaminhoArquivoDeCatalogo(caminho: unknown, workspaceId?: string): caminho is string {
  if (typeof caminho !== 'string' || caminho.length > 400) return false;
  const partes = caminho.split('/');
  if (partes.length !== 5) return false;
  const [ws, pasta, itemId, fileId, nome] = partes;
  if (pasta !== 'catalogo') return false;
  if (workspaceId && ws !== workspaceId) return false;
  return (
    UUID_REGEX.test(ws ?? '') &&
    UUID_REGEX.test(itemId ?? '') &&
    UUID_REGEX.test(fileId ?? '') &&
    NOME_SEGURO_NO_DEPOSITO.test(nome ?? '')
  );
}

export function caminhoAudioEstrategico(
  workspaceId: string,
  audioId: string,
  fileId: string,
  nomeNoDeposito: string,
): string {
  return `${workspaceId}/audios/${audioId}/${fileId}/${nomeNoDeposito}`;
}

export function ehCaminhoAudioEstrategico(caminho: unknown, workspaceId?: string): caminho is string {
  if (typeof caminho !== 'string' || caminho.length > 400) return false;
  const partes = caminho.split('/');
  if (partes.length !== 5) return false;
  const [ws, pasta, audioId, fileId, nome] = partes;
  if (pasta !== 'audios') return false;
  if (workspaceId && ws !== workspaceId) return false;
  return (
    UUID_REGEX.test(ws ?? '') &&
    UUID_REGEX.test(audioId ?? '') &&
    UUID_REGEX.test(fileId ?? '') &&
    NOME_SEGURO_NO_DEPOSITO.test(nome ?? '')
  );
}

const MIME_POR_EXTENSAO_CATALOGO: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};

const EXT_POR_MIME_CATALOGO: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

export function avaliarArquivoDeCatalogo(arquivo: {
  nome: string;
  tipoInformado?: string | null;
  tamanho: number;
}): { ok: true; contentType: string; nomeNoDeposito: string } | { ok: false; erro: string } {
  if (!Number.isFinite(arquivo.tamanho) || arquivo.tamanho <= 0) {
    return { ok: false, erro: 'O arquivo selecionado está vazio.' };
  }
  const ext = /\.([a-z0-9]{1,8})$/i.exec(arquivo.nome)?.[1]?.toLowerCase() ?? '';
  const bruto = (arquivo.tipoInformado ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const contentType =
    (TIPOS_MIDIA_CATALOGO as readonly string[]).includes(bruto)
      ? bruto
      : (MIME_POR_EXTENSAO_CATALOGO[ext] ?? '');

  if (!contentType) {
    return { ok: false, erro: 'Use apenas fotos (JPG, PNG, WebP, GIF) ou PDF para o catálogo.' };
  }
  const limite = contentType === 'application/pdf' ? LIMITE_BYTES_PDF_CATALOGO : LIMITE_BYTES_MIDIA_CATALOGO;
  if (arquivo.tamanho > limite) {
    const limiteMb = Math.round(limite / MB);
    return { ok: false, erro: `O arquivo passa do limite de ${limiteMb} MB.` };
  }
  return {
    ok: true,
    contentType,
    nomeNoDeposito: nomeSeguroParaDeposito(arquivo.nome, EXT_POR_MIME_CATALOGO[contentType] ?? 'bin'),
  };
}

const MIME_POR_EXTENSAO_AUDIO: Record<string, string> = {
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  weba: 'audio/webm',
  aac: 'audio/aac',
};

const EXT_POR_MIME_AUDIO: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
};

export function avaliarArquivoDeAudio(arquivo: {
  nome: string;
  tipoInformado?: string | null;
  tamanho: number;
}): { ok: true; contentType: string; nomeNoDeposito: string } | { ok: false; erro: string } {
  if (!Number.isFinite(arquivo.tamanho) || arquivo.tamanho <= 0) {
    return { ok: false, erro: 'O arquivo de áudio está vazio.' };
  }
  if (arquivo.tamanho > LIMITE_BYTES_AUDIO_ESTRATEGICO) {
    return { ok: false, erro: 'O áudio passa do limite máximo de 16 MB.' };
  }
  const ext = /\.([a-z0-9]{1,8})$/i.exec(arquivo.nome)?.[1]?.toLowerCase() ?? '';
  const limpo = (arquivo.tipoInformado ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const tipoMapeado =
    limpo === 'audio/mp3'
      ? 'audio/mpeg'
      : limpo === 'audio/m4a' || limpo === 'audio/x-m4a' || limpo === 'video/mp4'
        ? 'audio/mp4'
        : limpo === 'audio/opus' || limpo === 'application/ogg'
          ? 'audio/ogg'
          : limpo === 'audio/x-wav' || limpo === 'audio/wave'
            ? 'audio/wav'
            : limpo;
  const contentType =
    (TIPOS_AUDIO_ESTRATEGICO as readonly string[]).includes(tipoMapeado)
      ? tipoMapeado
      : (MIME_POR_EXTENSAO_AUDIO[ext] ?? '');

  if (!contentType) {
    return { ok: false, erro: 'Formato não aceito. Use OGG/Opus, MP3, M4A, WAV, AAC ou WebM.' };
  }
  return {
    ok: true,
    contentType,
    nomeNoDeposito: nomeSeguroParaDeposito(arquivo.nome, EXT_POR_MIME_AUDIO[contentType] ?? 'ogg'),
  };
}

export function normalizarWaveform(valores: unknown): number[] {
  if (!Array.isArray(valores) || valores.length === 0) return [];
  const limpos = valores.map((v) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 18;
    return Math.max(8, Math.min(100, Math.round(n)));
  });
  if (limpos.length === 64) return limpos;
  const resultado: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    const idx = Math.min(limpos.length - 1, Math.floor((i * limpos.length) / 64));
    resultado.push(limpos[idx] ?? 24);
  }
  return resultado;
}

export function gerarWaveformSimulada(seedTexto: string): number[] {
  let hash = 2166136261;
  for (let i = 0; i < seedTexto.length; i += 1) {
    hash ^= seedTexto.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const barras: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    hash ^= (i + 7) * 374761393;
    hash = Math.imul(hash, 668265263);
    const val = ((hash >>> 0) % 72) + 18;
    barras.push(val);
  }
  return barras;
}

function bytesContemAscii(bytes: Uint8Array, inicio: number, fim: number, assinatura: readonly number[]): boolean {
  const limite = Math.min(bytes.length, fim) - assinatura.length;
  for (let i = Math.max(0, inicio); i <= limite; i += 1) {
    let ok = true;
    for (let j = 0; j < assinatura.length; j += 1) {
      if (bytes[i + j] !== assinatura[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

const ASSINATURA_OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64] as const;

/** Verifica se os bytes representam um container Ogg (`OggS`) contendo cabeçalho `OpusHead`. */
export function ehOggOpusNativo(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < 47) return false;
  if (bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53) return false;
  return bytesContemAscii(bytes, 4, 256, ASSINATURA_OPUS_HEAD);
}

/**
 * Inspetor puro de Ogg/Opus (sem ffmpeg): lê `preSkip` e `granule_position` para extrair a duração
 * em segundos e gera 64 barras de densidade energética a partir dos pacotes VBR.
 */
export function inspecionarOggOpus(bytes: Uint8Array): { durationSec: number; waveform: number[] } | null {
  if (!ehOggOpusNativo(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let preSkip = 312;
  let maxGranule = 0n;
  const packetSizes: number[] = [];
  let offset = 0;

  while (offset + 27 <= bytes.length) {
    if (bytes[offset] !== 0x4f || bytes[offset + 1] !== 0x67 || bytes[offset + 2] !== 0x67 || bytes[offset + 3] !== 0x53) {
      break;
    }
    const granule = view.getBigInt64(offset + 6, true);
    if (granule > maxGranule) maxGranule = granule;
    const numSegments = bytes[offset + 26] ?? 0;
    const headerLen = 27 + numSegments;
    if (offset + headerLen > bytes.length) break;

    let bodyLen = 0;
    let curPacket = 0;
    for (let s = 0; s < numSegments; s += 1) {
      const seg = bytes[offset + 27 + s] ?? 0;
      bodyLen += seg;
      curPacket += seg;
      if (seg < 255) {
        packetSizes.push(curPacket);
        curPacket = 0;
      }
    }
    const bodyStart = offset + headerLen;
    if (bodyLen >= 19 && bodyStart + 12 <= bytes.length) {
      if (bytesContemAscii(bytes, bodyStart, bodyStart + 8, ASSINATURA_OPUS_HEAD)) {
        preSkip = view.getUint16(bodyStart + 10, true);
      }
    }
    offset += headerLen + bodyLen;
  }

  const totalSamples48k = maxGranule > BigInt(preSkip) ? Number(maxGranule - BigInt(preSkip)) : 0;
  const durationSec = Math.max(1, Math.round(totalSamples48k / 48000) || Math.round(bytes.length / 4000) || 1);

  const amostras = packetSizes.slice(2);
  if (amostras.length === 0) {
    return { durationSec, waveform: gerarWaveformSimulada(`ogg-${bytes.length}`) };
  }
  const maxPkt = Math.max(...amostras, 1);
  const waveform: number[] = [];
  for (let i = 0; i < 64; i += 1) {
    const start = Math.floor((i * amostras.length) / 64);
    const end = Math.max(start + 1, Math.floor(((i + 1) * amostras.length) / 64));
    let sum = 0;
    for (let k = start; k < end; k += 1) {
      sum += amostras[k] ?? 0;
    }
    const avg = sum / Math.max(1, end - start);
    waveform.push(Math.max(14, Math.min(100, Math.round((avg / maxPkt) * 100))));
  }

  return { durationSec, waveform };
}

/**
 * Skill S06: detecta quando o cliente avisou recentemente que não pode ouvir áudio
 * (ou prefere texto escrito). Quando ativo, o atendente NÃO envia `[[ENVIAR_AUDIO:...]]`
 * e responde com base na transcrição fiel do áudio.
 */
export function detectarRecusaDeAudioDoCliente(mensagemAtual = '', historicoRecente: readonly string[] = []): boolean {
  const combinado = [...historicoRecente.slice(-4), mensagemAtual].join(' ');
  const normalizado = combinado
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return /\b(nao\s+(consigo|posso|da\s+pra|da\s+para)\s+(ouvir|escutar)\s+audio|sem\s+audio|nao\s+manda\s+audio|manda\s+(por\s+)?(texto|escrito)|prefiro\s+texto|to\s+sem\s+fone)\b/.test(
    normalizado,
  );
}

export function formatarDuracaoAudio(segundos: number | null | undefined): string {
  if (typeof segundos !== 'number' || !Number.isFinite(segundos) || segundos <= 0) return '0:00';
  const total = Math.round(segundos);
  const min = Math.floor(total / 60);
  const seg = String(total % 60).padStart(2, '0');
  return `${min}:${seg}`;
}

export function validarItemCatalogoParaSalvar(item: {
  name?: string;
  category?: string;
  price?: string;
  description?: string;
  paymentLink?: string;
  active?: boolean;
  files?: readonly { objectKey: string; fileName: string; contentType: string; byteSize: number }[];
}): { ok: true } | { ok: false; erro: string } {
  const nome = (item.name ?? '').trim();
  if (!nome || nome.length > 200) {
    return { ok: false, erro: 'Informe o nome do item do catálogo (até 200 caracteres).' };
  }
  if ((item.category ?? '').length > 100) {
    return { ok: false, erro: 'A categoria pode ter até 100 caracteres.' };
  }
  if ((item.price ?? '').length > 200) {
    return { ok: false, erro: 'O preço pode ter até 200 caracteres.' };
  }
  if ((item.description ?? '').length > 12000) {
    return { ok: false, erro: 'A descrição pode ter até 12.000 caracteres.' };
  }
  if (item.paymentLink && !ehUrlPagamentoSegura(item.paymentLink)) {
    return { ok: false, erro: 'O link de pagamento precisa começar com https:// e não pode conter senha na URL.' };
  }
  if (item.files && item.files.length > LIMITE_MIDIAS_POR_ITEM) {
    return { ok: false, erro: `Cada item aceita no máximo ${LIMITE_MIDIAS_POR_ITEM} fotos ou PDFs.` };
  }
  return { ok: true };
}

export function validarAudioEstrategicoParaSalvar(audio: {
  name?: string;
  transcription?: string;
  whenToUse?: string;
  linkedMessageCode?: string;
  objectKey?: string;
}): { ok: true } | { ok: false; erro: string } {
  const nome = (audio.name ?? '').trim();
  if (!nome || nome.length > 200) {
    return { ok: false, erro: 'Dê um nome curto para identificar este áudio.' };
  }
  const transcricao = (audio.transcription ?? '').trim();
  if (!transcricao || transcricao.length > 16000) {
    return { ok: false, erro: 'Informe a transcrição fiel do que é falado no áudio (a IA lê este texto).' };
  }
  if ((audio.whenToUse ?? '').length > 4000) {
    return { ok: false, erro: 'A orientação de quando usar deve ter até 4.000 caracteres.' };
  }
  if ((audio.linkedMessageCode ?? '').length > 100) {
    return { ok: false, erro: 'O código da mensagem equivalente deve ter até 100 caracteres.' };
  }
  if (!audio.objectKey?.trim()) {
    return { ok: false, erro: 'Grave pelo microfone ou envie um arquivo de áudio antes de salvar.' };
  }
  return { ok: true };
}
