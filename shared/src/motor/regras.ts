export const VERSAO_ATUAL_DO_MOTOR = '6.0.0';

/** Janela máxima sem sinal do aparelho local para ainda considerá-lo on-line no painel. */
export const JANELA_EXECUTOR_ONLINE_MS = 90_000;

export const PLATAFORMAS_DO_MOTOR = ['win32', 'linux', 'android-termux', 'darwin', 'unknown'] as const;
export type PlataformaDoMotor = (typeof PLATAFORMAS_DO_MOTOR)[number];

export type EstadoDoExecutor = 'pending_pair' | 'active' | 'offline' | 'revoked';

export interface ManifestoDoMotor {
  version: string;
  sha256: string;
  size: number;
  published_at: string;
  min_node_major: number;
  notes?: string;
}

export interface ManifestoAssinadoDoMotor {
  manifest: ManifestoDoMotor;
  signature: string;
  algorithm: 'ed25519';
}

export function rotuloDaPlataforma(plataforma: string | null | undefined): string {
  switch (plataforma) {
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'android-termux':
      return 'Android (Termux)';
    case 'darwin':
      return 'macOS';
    default:
      return 'Computador / Celular';
  }
}

export function normalizarPlataforma(valor: string | null | undefined, ehTermux = false): PlataformaDoMotor {
  if (ehTermux) return 'android-termux';
  const limpo = (valor ?? '').trim().toLowerCase();
  if (limpo === 'win32' || limpo === 'windows') return 'win32';
  if (limpo === 'linux') return 'linux';
  if (limpo === 'android' || limpo === 'android-termux' || limpo === 'termux') return 'android-termux';
  if (limpo === 'darwin' || limpo === 'macos') return 'darwin';
  return 'unknown';
}

export function validarApelidoDoAparelho(nome: string | null | undefined): string | null {
  const limpo = (nome ?? '').replace(/\s+/g, ' ').trim();
  if (limpo.length < 1 || limpo.length > 80) return null;
  return limpo;
}

/**
 * Compara versões semânticas `X.Y.Z`. Retorna `true` só quando `candidata` é estritamente mais nova
 * que `atual` (protege contra downgrade malicioso mesmo em manifesto antigo assinado).
 */
export function ehVersaoMaisNova(atual: string, candidata: string): boolean {
  const a = analisarVersao(atual);
  const b = analisarVersao(candidata);
  if (!a || !b) return false;
  if (b[0] !== a[0]) return b[0] > a[0];
  if (b[1] !== a[1]) return b[1] > a[1];
  return b[2] > a[2];
}

export function analisarVersao(versao: string | null | undefined): [number, number, number] | null {
  if (!versao) return null;
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(versao.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Normaliza código de pareamento de aparelho (`IENV-ABCD-EFGH` ou `ABCDEFGH`).
 */
export function normalizarCodigoPareamentoAparelho(entrada: string | null | undefined): string | null {
  const bruto = (entrada ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const corpo = bruto.startsWith('IENV') ? bruto.slice(4) : bruto;
  if (!/^[A-Z0-9]{8}$/.test(corpo)) return null;
  return `IENV-${corpo.slice(0, 4)}-${corpo.slice(4, 8)}`;
}

/**
 * Gera string canônica determinística do manifesto para assinatura/verificação Ed25519.
 */
export function serializarManifestoCanonico(manifesto: ManifestoDoMotor): string {
  return JSON.stringify({
    version: manifesto.version,
    sha256: manifesto.sha256.toLowerCase(),
    size: manifesto.size,
    published_at: manifesto.published_at,
    min_node_major: manifesto.min_node_major,
    ...(manifesto.notes ? { notes: manifesto.notes } : {}),
  });
}

export function executorEstaOnline(
  status: string | null | undefined,
  lastSeenAt: string | null | undefined,
  agoraMs: number = Date.now(),
): boolean {
  if (status !== 'active' && status !== 'offline') return false;
  if (!lastSeenAt) return false;
  const t = Date.parse(lastSeenAt);
  if (!Number.isFinite(t)) return false;
  return agoraMs - t <= JANELA_EXECUTOR_ONLINE_MS;
}

export function descreverEstadoDoExecutor(
  status: string | null | undefined,
  lastSeenAt: string | null | undefined,
  agoraMs: number = Date.now(),
): { codigo: 'online' | 'offline' | 'pending' | 'revoked'; texto: string; tom: 'ok' | 'neutro' | 'atencao' | 'erro' } {
  if (status === 'revoked') return { codigo: 'revoked', texto: 'Revogado', tom: 'erro' };
  if (status === 'pending_pair') return { codigo: 'pending', texto: 'Aguardando pareamento', tom: 'atencao' };
  if (executorEstaOnline(status, lastSeenAt, agoraMs)) return { codigo: 'online', texto: 'On-line', tom: 'ok' };
  return { codigo: 'offline', texto: 'Off-line', tom: 'neutro' };
}
