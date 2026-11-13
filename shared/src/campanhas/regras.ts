/**
 * Regras puras de Campanhas: blocos (texto fixo, spintax, rotação, IA, imagem, áudio),
 * cadência anti-ban, renderização de variáveis e estados de campanha/destinatário.
 */

export type StatusDaCampanha =
  | 'draft'
  | 'scheduled'
  | 'preparing'
  | 'awaiting_confirmation'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type StatusDoDestinatario =
  | 'pending'
  | 'suppressed'
  | 'queued'
  | 'awaiting_human_confirmation'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'replied'
  | 'failed'
  | 'cancelled';

export type DistribuicaoDaCampanha = 'fixed' | 'round_robin';
export type ModoDoTexto = 'fixed' | 'spintax' | 'rotation' | 'ai';
export type OrdemDeSelecao = 'sequential' | 'random';

export interface BlocoDeTexto {
  id: string;
  type: 'text';
  mode: ModoDoTexto;
  texts: string[];
  selection: OrdemDeSelecao;
}

export interface BlocoDeMidia {
  id: string;
  type: 'image' | 'audio';
  folder_id: string;
  selection: OrdemDeSelecao;
  is_voice?: boolean;
}

export type BlocoDeCampanha = BlocoDeTexto | BlocoDeMidia;

export interface CadenciaDeCampanha {
  intervalMinSec: number;
  intervalMaxSec: number;
  batchMin: number;
  batchMax: number;
  batchPauseMinSec: number;
  batchPauseMaxSec: number;
  stepIntervalSec: number;
  restrictHours: boolean;
  workDays: number[];
  windowStart: string;
  windowEnd: string;
  timezone: string;
  dailyLimitPerChip: number;
}

export const CADENCIA_PADRAO: CadenciaDeCampanha = {
  intervalMinSec: 35,
  intervalMaxSec: 80,
  batchMin: 8,
  batchMax: 15,
  batchPauseMinSec: 180,
  batchPauseMaxSec: 420,
  stepIntervalSec: 4,
  restrictHours: false,
  workDays: [1, 2, 3, 4, 5, 6],
  windowStart: '08:00',
  windowEnd: '19:00',
  timezone: 'America/Fortaleza',
  dailyLimitPerChip: 0,
};

export const LIMITES_CADENCIA = {
  intervalMinSec: { min: 15, max: 600 },
  intervalMaxSec: { min: 15, max: 900 },
  batchMin: { min: 1, max: 100 },
  batchMax: { min: 1, max: 100 },
  batchPauseMinSec: { min: 30, max: 3600 },
  batchPauseMaxSec: { min: 30, max: 7200 },
  stepIntervalSec: { min: 2, max: 30 },
  dailyLimitPerChip: { min: 0, max: 2000 },
} as const;

export function descreverStatusCampanha(status: string): { rotulo: string; tom: 'ok' | 'neutro' | 'atencao' | 'erro' } {
  switch (status) {
    case 'draft':
      return { rotulo: 'Rascunho', tom: 'neutro' };
    case 'awaiting_confirmation':
      return { rotulo: 'Pronta para confirmar', tom: 'atencao' };
    case 'scheduled':
      return { rotulo: 'Agendada', tom: 'atencao' };
    case 'preparing':
      return { rotulo: 'Preparando', tom: 'atencao' };
    case 'running':
      return { rotulo: 'Disparando', tom: 'ok' };
    case 'paused':
      return { rotulo: 'Pausada', tom: 'atencao' };
    case 'completed':
      return { rotulo: 'Concluída', tom: 'ok' };
    case 'cancelled':
      return { rotulo: 'Cancelada', tom: 'neutro' };
    case 'failed':
      return { rotulo: 'Com falha', tom: 'erro' };
    default:
      return { rotulo: status || 'Desconhecida', tom: 'neutro' };
  }
}

export function descreverStatusDestinatario(status: string): { rotulo: string; tom: 'ok' | 'neutro' | 'atencao' | 'erro' } {
  switch (status) {
    case 'pending':
      return { rotulo: 'Pendente', tom: 'neutro' };
    case 'queued':
      return { rotulo: 'Na fila', tom: 'neutro' };
    case 'sending':
      return { rotulo: 'Enviando…', tom: 'atencao' };
    case 'awaiting_human_confirmation':
      return { rotulo: 'Conferir envio', tom: 'atencao' };
    case 'sent':
      return { rotulo: 'Enviada', tom: 'ok' };
    case 'delivered':
      return { rotulo: 'Entregue', tom: 'ok' };
    case 'read':
      return { rotulo: 'Lida', tom: 'ok' };
    case 'replied':
      return { rotulo: 'Respondeu', tom: 'ok' };
    case 'suppressed':
      return { rotulo: 'Ignorada', tom: 'neutro' };
    case 'failed':
      return { rotulo: 'Falhou', tom: 'erro' };
    case 'cancelled':
      return { rotulo: 'Cancelada', tom: 'neutro' };
    default:
      return { rotulo: status || 'Desconhecido', tom: 'neutro' };
  }
}

export function explicarMotivoSupressao(motivo: string | null | undefined): string {
  switch (motivo) {
    case 'ignored':
      return 'Na lista de contatos ignorados';
    case 'own_chip':
      return 'É o próprio número de um chip conectado';
    case 'blocked':
      return 'Contato bloqueado ou marcado para não receber IA';
    case 'opted_out':
      return 'Contato pediu para não receber mensagens';
    case 'duplicate':
      return 'Número repetido na importação';
    case 'invalid_phone':
      return 'Telefone inválido';
    default:
      return motivo || 'Suprimido';
  }
}

export function explicarMotivoPausa(motivo: string | null | undefined): string {
  switch (motivo) {
    case 'uncertain_send':
      return 'Um envio ficou sem confirmação do WhatsApp. Confira no aparelho antes de retomar.';
    case 'chip_disconnected':
      return 'O chip selecionado desconectou durante a campanha. Reconecte antes de retomar.';
    case 'no_media':
      return 'A pasta de mídia escolhida está sem arquivos disponíveis.';
    case 'manual':
      return 'Campanha pausada manualmente por você.';
    case 'daily_limit':
      return 'Teto diário de envios do chip atingido por hoje.';
    case 'window_closed':
      return 'Fora da janela de horário configurada.';
    default:
      return motivo || 'Campanha pausada.';
  }
}

/**
 * Expande sintaxe spintax `{opção A|opção B|opção C}` respeitando `{{variáveis}}` duplas.
 * Suporta múltiplos blocos e até 4 níveis aninhados sem usar regex catastrófico.
 */
export function expandirSpintax(texto: string, sorteio: () => number = Math.random): string {
  let atual = texto;
  const protegerDuplas = (entrada: string) => entrada.replace(/\{\{/g, '\u0001').replace(/\}\}/g, '\u0002');
  const restaurarDuplas = (entrada: string) => entrada.replace(/\u0001/g, '{{').replace(/\u0002/g, '}}');

  atual = protegerDuplas(atual);
  for (let rodada = 0; rodada < 4; rodada += 1) {
    const proximo = atual.replace(/\{([^{}]+)\}/g, (_tudo, miolo: string) => {
      if (!miolo.includes('|')) return `{${miolo}}`;
      const opcoes = miolo.split('|');
      const r = Math.min(Math.max(sorteio(), 0), 0.999999999);
      const indice = Math.floor(r * opcoes.length);
      return opcoes[indice] ?? opcoes[0] ?? '';
    });
    if (proximo === atual) break;
    atual = proximo;
  }
  return restaurarDuplas(atual);
}

/** Extrai nomes de placeholders `{{campo}}` normalizados em minúsculas. */
export function extrairPlaceholders(texto: string): string[] {
  const encontrados = new Set<string>();
  for (const m of texto.matchAll(/\{\{\s*([a-zA-Z0-9_À-ÿ-]+)\s*\}\}/g)) {
    const chave = normalizarChaveCampo(m[1] ?? '');
    if (chave) encontrados.add(chave);
  }
  return Array.from(encontrados);
}

export function normalizarChaveCampo(chave: string): string {
  return chave
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export interface DadosDoDestinatarioParaTexto {
  nome?: string | null;
  telefone?: string | null;
  campos?: Record<string, string> | null;
}

/** Substitui `{{nome}}`, `{{primeiro_nome}}`, `{{telefone}}` e campos extras. */
export function substituirVariaveis(template: string, destinatario: DadosDoDestinatarioParaTexto): string {
  const nome = (destinatario.nome ?? '').trim();
  const primeiroNome = nome ? nome.split(/\s+/)[0] ?? '' : '';
  const telefone = (destinatario.telefone ?? '').trim();
  const extras: Record<string, string> = {};
  for (const [k, v] of Object.entries(destinatario.campos ?? {})) {
    const limpa = normalizarChaveCampo(k);
    if (limpa && typeof v === 'string') extras[limpa] = v.trim();
  }

  return template.replace(/\{\{\s*([a-zA-Z0-9_À-ÿ-]+)\s*\}\}/g, (_tudo, bruto: string) => {
    const chave = normalizarChaveCampo(bruto);
    if (chave === 'nome' || chave === 'cliente' || chave === 'contato') return nome || 'olá';
    if (chave === 'primeiro_nome' || chave === 'primeironome') return primeiroNome || nome || 'olá';
    if (chave === 'telefone' || chave === 'numero' || chave === 'whatsapp') return telefone;
    return extras[chave] ?? '';
  });
}

/** Escolhe variação + expande spintax (se aplicável) + substitui placeholders. */
export function renderizarBlocoDeTexto(
  bloco: Pick<BlocoDeTexto, 'mode' | 'texts' | 'selection'>,
  destinatario: DadosDoDestinatarioParaTexto,
  indiceSequencial: number,
  sorteio: () => number = Math.random,
): string {
  const opcoes = bloco.texts.map((t) => t.trim()).filter(Boolean);
  if (opcoes.length === 0) return '';
  let escolhida: string;
  if (bloco.mode === 'rotation' && opcoes.length > 1) {
    if (bloco.selection === 'random') {
      const idx = Math.floor(Math.min(Math.max(sorteio(), 0), 0.999999999) * opcoes.length);
      escolhida = opcoes[idx] ?? opcoes[0]!;
    } else {
      escolhida = opcoes[indiceSequencial % opcoes.length] ?? opcoes[0]!;
    }
  } else {
    escolhida = opcoes[0]!;
  }
  const comSpintax = bloco.mode === 'spintax' ? expandirSpintax(escolhida, sorteio) : escolhida;
  return substituirVariaveis(comSpintax, destinatario).trim();
}

/**
 * Garante que uma variação gerada pela IA preservou TODOS os placeholders `{{...}}` do texto-base.
 * Se a IA removeu ou inventou placeholder, o chamador deve descartar e cair para o texto-base.
 */
export function variacaoIaPreservaPlaceholders(textoBase: string, textoVariado: string): boolean {
  const base = extrairPlaceholders(textoBase).sort();
  const variado = extrairPlaceholders(textoVariado).sort();
  if (base.length !== variado.length) return false;
  return base.every((chave, idx) => variado[idx] === chave);
}

export function conferirCadencia(cadencia: CadenciaDeCampanha): string | null {
  if (cadencia.intervalMinSec < LIMITES_CADENCIA.intervalMinSec.min || cadencia.intervalMinSec > LIMITES_CADENCIA.intervalMinSec.max) {
    return 'Intervalo mínimo entre envios deve ficar entre 15 e 600 segundos.';
  }
  if (
    cadencia.intervalMaxSec < LIMITES_CADENCIA.intervalMaxSec.min ||
    cadencia.intervalMaxSec > LIMITES_CADENCIA.intervalMaxSec.max ||
    cadencia.intervalMaxSec < cadencia.intervalMinSec
  ) {
    return 'Intervalo máximo precisa ser maior ou igual ao mínimo (até 900 segundos).';
  }
  if (cadencia.batchMin < LIMITES_CADENCIA.batchMin.min || cadencia.batchMin > LIMITES_CADENCIA.batchMin.max) {
    return 'Tamanho mínimo do lote deve ficar entre 1 e 100 mensagens.';
  }
  if (cadencia.batchMax < LIMITES_CADENCIA.batchMax.min || cadencia.batchMax > LIMITES_CADENCIA.batchMax.max || cadencia.batchMax < cadencia.batchMin) {
    return 'Tamanho máximo do lote precisa ser maior ou igual ao mínimo (até 100).';
  }
  if (cadencia.batchPauseMinSec < LIMITES_CADENCIA.batchPauseMinSec.min || cadencia.batchPauseMinSec > LIMITES_CADENCIA.batchPauseMinSec.max) {
    return 'Pausa mínima entre lotes deve ficar entre 30 e 3600 segundos.';
  }
  if (
    cadencia.batchPauseMaxSec < LIMITES_CADENCIA.batchPauseMaxSec.min ||
    cadencia.batchPauseMaxSec > LIMITES_CADENCIA.batchPauseMaxSec.max ||
    cadencia.batchPauseMaxSec < cadencia.batchPauseMinSec
  ) {
    return 'Pausa máxima entre lotes precisa ser maior ou igual à mínima.';
  }
  if (cadencia.stepIntervalSec < LIMITES_CADENCIA.stepIntervalSec.min || cadencia.stepIntervalSec > LIMITES_CADENCIA.stepIntervalSec.max) {
    return 'Intervalo entre blocos da mesma pessoa deve ficar entre 2 e 30 segundos.';
  }
  if (cadencia.dailyLimitPerChip < LIMITES_CADENCIA.dailyLimitPerChip.min || cadencia.dailyLimitPerChip > LIMITES_CADENCIA.dailyLimitPerChip.max) {
    return 'Teto diário por chip deve ficar entre 0 (sem teto extra) e 2000.';
  }
  if (cadencia.restrictHours && cadencia.workDays.length === 0) {
    return 'Escolha ao menos um dia da semana na janela da campanha.';
  }
  return null;
}

export function lerCadencia(bruto: unknown): CadenciaDeCampanha {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { ...CADENCIA_PADRAO, workDays: [...CADENCIA_PADRAO.workDays] };
  const o = bruto as Record<string, unknown>;
  const num = (k: string, def: number, min: number, max: number) => {
    const v = Number(o[k]);
    return Number.isInteger(v) && v >= min && v <= max ? v : def;
  };
  const intervalMinSec = num('intervalMinSec', CADENCIA_PADRAO.intervalMinSec, LIMITES_CADENCIA.intervalMinSec.min, LIMITES_CADENCIA.intervalMinSec.max);
  const intervalMaxSec = Math.max(
    intervalMinSec,
    num('intervalMaxSec', CADENCIA_PADRAO.intervalMaxSec, LIMITES_CADENCIA.intervalMaxSec.min, LIMITES_CADENCIA.intervalMaxSec.max),
  );
  const batchMin = num('batchMin', CADENCIA_PADRAO.batchMin, LIMITES_CADENCIA.batchMin.min, LIMITES_CADENCIA.batchMin.max);
  const batchMax = Math.max(batchMin, num('batchMax', CADENCIA_PADRAO.batchMax, LIMITES_CADENCIA.batchMax.min, LIMITES_CADENCIA.batchMax.max));
  const batchPauseMinSec = num('batchPauseMinSec', CADENCIA_PADRAO.batchPauseMinSec, LIMITES_CADENCIA.batchPauseMinSec.min, LIMITES_CADENCIA.batchPauseMinSec.max);
  const batchPauseMaxSec = Math.max(
    batchPauseMinSec,
    num('batchPauseMaxSec', CADENCIA_PADRAO.batchPauseMaxSec, LIMITES_CADENCIA.batchPauseMaxSec.min, LIMITES_CADENCIA.batchPauseMaxSec.max),
  );
  const dias = Array.isArray(o.workDays)
    ? Array.from(new Set(o.workDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b)
    : [...CADENCIA_PADRAO.workDays];

  return {
    intervalMinSec,
    intervalMaxSec,
    batchMin,
    batchMax,
    batchPauseMinSec,
    batchPauseMaxSec,
    stepIntervalSec: num('stepIntervalSec', CADENCIA_PADRAO.stepIntervalSec, LIMITES_CADENCIA.stepIntervalSec.min, LIMITES_CADENCIA.stepIntervalSec.max),
    restrictHours: typeof o.restrictHours === 'boolean' ? o.restrictHours : CADENCIA_PADRAO.restrictHours,
    workDays: dias,
    windowStart: typeof o.windowStart === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(o.windowStart) ? o.windowStart : CADENCIA_PADRAO.windowStart,
    windowEnd: typeof o.windowEnd === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(o.windowEnd) ? o.windowEnd : CADENCIA_PADRAO.windowEnd,
    timezone: typeof o.timezone === 'string' && o.timezone.trim() ? o.timezone.trim().slice(0, 80) : CADENCIA_PADRAO.timezone,
    dailyLimitPerChip: num('dailyLimitPerChip', CADENCIA_PADRAO.dailyLimitPerChip, LIMITES_CADENCIA.dailyLimitPerChip.min, LIMITES_CADENCIA.dailyLimitPerChip.max),
  };
}
