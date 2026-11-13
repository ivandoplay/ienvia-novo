import { lerConfiguracaoPix, type ConfiguracaoPix } from '@ienvia/shared/recursos-pix';
import {
  normalizarWaveform,
  type ArquivoDeCatalogo,
  type AudioEstrategico,
  type ItemDoCatalogo,
} from '@ienvia/shared/recursos';

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function mapearArquivoCatalogo(bruto: unknown, fallbackOrdem = 0): ArquivoDeCatalogo | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;
  const objectKey = str(o.object_key ?? o.objectKey).trim();
  if (!objectKey) return null;
  return {
    id: str(o.id) || objectKey,
    objectKey,
    fileName: str(o.file_name ?? o.fileName) || 'arquivo',
    contentType: str(o.content_type ?? o.contentType) || 'application/octet-stream',
    byteSize: Math.max(0, Math.round(num(o.byte_size ?? o.byteSize, 0))),
    sortOrder: Math.max(0, Math.round(num(o.sort_order ?? o.sortOrder, fallbackOrdem))),
  };
}

export function mapearItemCatalogo(bruto: unknown): ItemDoCatalogo | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;
  const id = str(o.id).trim();
  const name = str(o.name).trim();
  if (!id || !name) return null;
  const rawFiles = Array.isArray(o.files) ? o.files : [];
  const files = rawFiles
    .map((f, idx) => mapearArquivoCatalogo(f, idx))
    .filter((f): f is ArquivoDeCatalogo => f !== null);

  return {
    id,
    name,
    category: str(o.category),
    price: str(o.price),
    description: str(o.description),
    paymentLink: str(o.payment_link ?? o.paymentLink),
    active: o.active !== false,
    sortOrder: Math.round(num(o.sort_order ?? o.sortOrder, 0)),
    files,
    createdAt: typeof (o.created_at ?? o.createdAt) === 'string' ? str(o.created_at ?? o.createdAt) : null,
    updatedAt: typeof (o.updated_at ?? o.updatedAt) === 'string' ? str(o.updated_at ?? o.updatedAt) : null,
  };
}

export function mapearCatalogo(lista: unknown): ItemDoCatalogo[] {
  if (!Array.isArray(lista)) return [];
  return lista.map(mapearItemCatalogo).filter((x): x is ItemDoCatalogo => x !== null);
}

export function mapearAudioEstrategico(bruto: unknown): AudioEstrategico | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;
  const id = str(o.id).trim();
  const name = str(o.name).trim();
  const objectKey = str(o.object_key ?? o.objectKey).trim();
  if (!id || !name || !objectKey) return null;

  const rawDur = o.duration_sec ?? o.durationSec;
  const durationSec = typeof rawDur === 'number' && Number.isFinite(rawDur) && rawDur >= 0 ? Math.round(rawDur) : null;

  return {
    id,
    name,
    transcription: str(o.transcription),
    whenToUse: str(o.when_to_use ?? o.whenToUse),
    linkedMessageCode: str(o.linked_message_code ?? o.linkedMessageCode),
    aiEnabled: o.ai_enabled !== false && o.aiEnabled !== false,
    objectKey,
    fileName: str(o.file_name ?? o.fileName) || 'audio.ogg',
    contentType: str(o.content_type ?? o.contentType) || 'audio/ogg; codecs=opus',
    byteSize: Math.max(0, Math.round(num(o.byte_size ?? o.byteSize, 0))),
    durationSec,
    waveform: normalizarWaveform(o.waveform),
    createdAt: typeof (o.created_at ?? o.createdAt) === 'string' ? str(o.created_at ?? o.createdAt) : null,
    updatedAt: typeof (o.updated_at ?? o.updatedAt) === 'string' ? str(o.updated_at ?? o.updatedAt) : null,
  };
}

export function mapearAudiosEstrategicos(lista: unknown): AudioEstrategico[] {
  if (!Array.isArray(lista)) return [];
  return lista.map(mapearAudioEstrategico).filter((x): x is AudioEstrategico => x !== null);
}

export interface RecursosDoWorkspace {
  pix: ConfiguracaoPix;
  catalogo: ItemDoCatalogo[];
  audios: AudioEstrategico[];
  audiosJaEnviados: string[];
}

export function mapearRecursosDoPacote(bruto: unknown): RecursosDoWorkspace {
  const o = bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {};
  const enviadosRaw = Array.isArray(o.sent_voice_ids)
    ? o.sent_voice_ids
    : Array.isArray(o.sentVoiceIds)
      ? o.sentVoiceIds
      : [];
  const audiosJaEnviados = enviadosRaw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return {
    pix: lerConfiguracaoPix(o.pix),
    catalogo: mapearCatalogo(o.catalog ?? o.catalogo),
    audios: mapearAudiosEstrategicos(o.voices ?? o.audios),
    audiosJaEnviados,
  };
}
