/**
 * Regras puras do domínio de Segurança, Anti-Bloqueio, Horário de Atendimento,
 * Fila Segura e Contatos Ignorados.
 * Compartilhado entre o painel, ações de servidor e testes (sem dependências de Node ou DOM).
 */

export type PresetAntiban = 'conservador' | 'equilibrado' | 'moderado' | 'personalizado';
export type ModoHorario = 'always' | 'business_hours_only' | 'outside_hours_only';
export type EventoAlertaSeguranca =
  | 'handoff'
  | 'silent_handoff'
  | 'uncertain_send'
  | 'error'
  | 'safety'
  | 'chip_disconnected'
  | 'campaign_uncertain';

export const PRESETS_ANTIBAN: ReadonlyArray<{
  valor: Exclude<PresetAntiban, 'personalizado'>;
  rotulo: string;
  resumo: string;
  minTypingMs: number;
  maxTypingMs: number;
  maxRepliesPerMinutePerContact: number;
  proactiveMinDelaySec: number;
  proactiveMaxDelaySec: number;
  dailyProactiveLimit: number;
}> = [
  {
    valor: 'conservador',
    rotulo: 'Conservador',
    resumo: 'Chip novo ou em aquecimento: intervalos longos e teto baixo.',
    minTypingMs: 2200,
    maxTypingMs: 5500,
    maxRepliesPerMinutePerContact: 4,
    proactiveMinDelaySec: 55,
    proactiveMaxDelaySec: 120,
    dailyProactiveLimit: 20,
  },
  {
    valor: 'equilibrado',
    rotulo: 'Equilibrado',
    resumo: 'Padrão seguro para operação diária com bom ritmo humano.',
    minTypingMs: 1800,
    maxTypingMs: 5200,
    maxRepliesPerMinutePerContact: 6,
    proactiveMinDelaySec: 45,
    proactiveMaxDelaySec: 110,
    dailyProactiveLimit: 25,
  },
  {
    valor: 'moderado',
    rotulo: 'Moderado',
    resumo: 'Chip antigo e aquecido: respostas mais ágeis e teto maior.',
    minTypingMs: 1200,
    maxTypingMs: 3600,
    maxRepliesPerMinutePerContact: 10,
    proactiveMinDelaySec: 30,
    proactiveMaxDelaySec: 65,
    dailyProactiveLimit: 45,
  },
];

export const MODOS_HORARIO: ReadonlyArray<{ valor: ModoHorario; rotulo: string; descricao: string }> = [
  { valor: 'always', rotulo: 'Sempre ativo (24h)', descricao: 'A IA atende em qualquer dia e horário.' },
  { valor: 'business_hours_only', rotulo: 'Só no horário comercial', descricao: 'Responde automaticamente só nos dias e horas marcados.' },
  { valor: 'outside_hours_only', rotulo: 'Só fora do horário (plantão)', descricao: 'Equipe atende no expediente; a IA assume à noite, fins de semana e feriados.' },
];

export const DIAS_DA_SEMANA: ReadonlyArray<{ valor: number; curto: string; nome: string }> = [
  { valor: 0, curto: 'Dom', nome: 'Domingo' },
  { valor: 1, curto: 'Seg', nome: 'Segunda-feira' },
  { valor: 2, curto: 'Ter', nome: 'Terça-feira' },
  { valor: 3, curto: 'Qua', nome: 'Quarta-feira' },
  { valor: 4, curto: 'Qui', nome: 'Quinta-feira' },
  { valor: 5, curto: 'Sex', nome: 'Sexta-feira' },
  { valor: 6, curto: 'Sáb', nome: 'Sábado' },
];

export const FUSOS_HORARIOS_COMUNS: ReadonlyArray<{ valor: string; rotulo: string }> = [
  { valor: 'America/Fortaleza', rotulo: 'Nordeste / Brasília sem horário de verão (America/Fortaleza)' },
  { valor: 'America/Sao_Paulo', rotulo: 'Sudeste / Sul / Brasília (America/Sao_Paulo)' },
  { valor: 'America/Belem', rotulo: 'Pará / Amapá (America/Belem)' },
  { valor: 'America/Manaus', rotulo: 'Amazonas / Rondônia / Roraima (America/Manaus)' },
  { valor: 'America/Cuiaba', rotulo: 'Mato Grosso / MS (America/Cuiaba)' },
  { valor: 'America/Rio_Branco', rotulo: 'Acre (America/Rio_Branco)' },
  { valor: 'America/Noronha', rotulo: 'Fernando de Noronha (America/Noronha)' },
];

export const TODOS_EVENTOS_ALERTA_SEGURANCA: readonly EventoAlertaSeguranca[] = [
  'handoff',
  'silent_handoff',
  'uncertain_send',
  'error',
  'safety',
  'chip_disconnected',
  'campaign_uncertain',
];

export const EVENTOS_ALERTA_SEGURANCA_INFO: ReadonlyArray<{ valor: EventoAlertaSeguranca; rotulo: string; descricao: string }> = [
  { valor: 'handoff', rotulo: 'Repasses para humano', descricao: 'Sempre que a IA transferir a conversa para uma pessoa.' },
  { valor: 'silent_handoff', rotulo: 'Pausas silenciosas', descricao: 'Quando a IA entrar em silêncio por mensagem solta ou mídia sem leitura.' },
  { valor: 'uncertain_send', rotulo: 'Envio sem confirmação', descricao: 'Quando não for possível confirmar se uma resposta saiu no WhatsApp.' },
  { valor: 'error', rotulo: 'Falhas da IA', descricao: 'Quando nenhum provedor responder ou ocorrer erro no turno.' },
  { valor: 'safety', rotulo: 'Parada de segurança', descricao: 'Quando o contato mandar mensagens demais em sequência (proteção contra robô).' },
  { valor: 'chip_disconnected', rotulo: 'Chip desconectado', descricao: 'Quando um chip cair ou perder sessão (envia por outro chip conectado).' },
  { valor: 'campaign_uncertain', rotulo: 'Campanha / Fila pausada por envio incerto', descricao: 'Quando um disparo ficar sem confirmação e pausar esperando você conferir.' },
];

export interface ConfiguracaoDeSeguranca {
  antibanPreset: PresetAntiban;
  simulateTyping: boolean;
  minTypingMs: number;
  maxTypingMs: number;
  splitLongMessages: boolean;
  debounceSeconds: number;
  pauseOnHumanReply: boolean;
  humanPauseMinutes: number;
  maxRepliesPerMinutePerContact: number;
  proactiveMinDelaySec: number;
  proactiveMaxDelaySec: number;
  dailyProactiveLimit: number;
  scheduleMode: ModoHorario;
  scheduleStart: string;
  scheduleEnd: string;
  scheduleWorkDays: number[];
  scheduleTimezone: string;
  offHoursReplyMessage: string;
  adminAlertEnabled: boolean;
  adminAlertWhatsapp: string;
  adminAlertEvents: EventoAlertaSeguranca[];
  adminAlertIncludeMessages: boolean;
}

export const PADRAO_SEGURANCA: ConfiguracaoDeSeguranca = {
  antibanPreset: 'equilibrado',
  simulateTyping: true,
  minTypingMs: 1800,
  maxTypingMs: 5200,
  splitLongMessages: true,
  debounceSeconds: 6,
  pauseOnHumanReply: true,
  humanPauseMinutes: 60,
  maxRepliesPerMinutePerContact: 6,
  proactiveMinDelaySec: 45,
  proactiveMaxDelaySec: 110,
  dailyProactiveLimit: 25,
  scheduleMode: 'always',
  scheduleStart: '08:00',
  scheduleEnd: '18:00',
  scheduleWorkDays: [1, 2, 3, 4, 5, 6],
  scheduleTimezone: 'America/Fortaleza',
  offHoursReplyMessage: '',
  adminAlertEnabled: false,
  adminAlertWhatsapp: '',
  adminAlertEvents: ['handoff', 'silent_handoff', 'uncertain_send', 'error', 'safety'],
  adminAlertIncludeMessages: true,
};

export const LIMITES_SEGURANCA = {
  minTypingMs: { min: 500, max: 10_000 },
  maxTypingMs: { min: 1_000, max: 15_000 },
  debounceSeconds: { min: 1, max: 20 },
  humanPauseMinutes: { min: 5, max: 1440 },
  maxRepliesPerMinutePerContact: { min: 1, max: 60 },
  proactiveMinDelaySec: { min: 20, max: 600 },
  proactiveMaxDelaySec: { min: 30, max: 900 },
  dailyProactiveLimit: { min: 1, max: 150 },
} as const;

/**
 * Normaliza telefone digitado ou colado para formato internacional só com dígitos (ex.: 5586999887766).
 * Números brasileiros de 10 ou 11 dígitos sem DDI ganham prefixo 55 automaticamente.
 */
export function normalizarDigitosTelefone(bruto: unknown): string | null {
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null;
  let digitos = String(bruto).replace(/@.+$/, '').replace(/\D/g, '');
  if (!digitos) return null;
  if (digitos.startsWith('00')) digitos = digitos.slice(2);
  if (digitos.startsWith('0') && (digitos.length === 11 || digitos.length === 12)) {
    digitos = digitos.slice(1);
  }
  if ((digitos.length === 10 || digitos.length === 11) && !digitos.startsWith('55')) {
    const ddd = Number(digitos.slice(0, 2));
    if (ddd >= 11 && ddd <= 99) digitos = `55${digitos}`;
  }
  if (!/^[1-9][0-9]{7,14}$/.test(digitos)) return null;
  return digitos;
}

/**
 * Núcleo canônico idêntico a `private.phone_core` no Postgres:
 * números móveis BR (55 + DDD + 9 + 8 dígitos) removem o nono dígito na comparação.
 */
export function mioloDoTelefone(digitosOuBruto: unknown): string {
  const limpo = String(digitosOuBruto ?? '').replace(/@.+$/, '').replace(/\D/g, '');
  if (/^55[1-9][0-9]9[0-9]{8}$/.test(limpo)) {
    return `${limpo.slice(0, 4)}${limpo.slice(5)}`;
  }
  return limpo;
}

export function formatarTelefoneLegivel(digitos: string | null | undefined): string {
  const limpo = String(digitos ?? '').replace(/\D/g, '');
  if (!limpo) return '—';
  if (limpo.startsWith('55') && (limpo.length === 12 || limpo.length === 13)) {
    const ddd = limpo.slice(2, 4);
    const resto = limpo.slice(4);
    const meio = resto.length === 9 ? `${resto.slice(0, 5)}-${resto.slice(5)}` : `${resto.slice(0, 4)}-${resto.slice(4)}`;
    return `+55 (${ddd}) ${meio}`;
  }
  return `+${limpo}`;
}

const HORA_VALIDA = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export function ehHoraValida(valor: unknown): valor is string {
  return typeof valor === 'string' && HORA_VALIDA.test(valor);
}

const DIAS_CURTOS_EN: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function minutosDoDia(hhmm: string): number {
  const m = HORA_VALIDA.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Avalia se a IA está dentro da janela configurada (fiel à `private.is_within_schedule` no banco).
 */
export function dentroDoHorarioDeAtendimento(
  config: Pick<ConfiguracaoDeSeguranca, 'scheduleMode' | 'scheduleStart' | 'scheduleEnd' | 'scheduleWorkDays' | 'scheduleTimezone'>,
  agoraMs: number = Date.now(),
): { ativo: boolean; dentroDaJanela: boolean; diaSemana: number; horaLocal: string } {
  const fuso = config.scheduleTimezone || 'America/Fortaleza';
  let partes: Intl.DateTimeFormatPart[] = [];
  try {
    partes = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(agoraMs));
  } catch {
    partes = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Fortaleza',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(agoraMs));
  }

  const weekday = partes.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  let hour = partes.find((p) => p.type === 'hour')?.value ?? '12';
  if (hour === '24') hour = '00';
  const minute = partes.find((p) => p.type === 'minute')?.value ?? '00';
  const diaSemana = DIAS_CURTOS_EN[weekday] ?? 1;
  const horaLocal = `${hour}:${minute}`;

  const inicioMin = minutosDoDia(config.scheduleStart);
  const fimMin = minutosDoDia(config.scheduleEnd);
  const atualMin = Number(hour) * 60 + Number(minute);
  const diaAtivo = config.scheduleWorkDays.includes(diaSemana);
  const naFaixaHoraria = inicioMin <= fimMin ? atualMin >= inicioMin && atualMin <= fimMin : atualMin >= inicioMin || atualMin <= fimMin;
  const dentroDaJanela = diaAtivo && naFaixaHoraria;

  const ativo =
    config.scheduleMode === 'always'
      ? true
      : config.scheduleMode === 'business_hours_only'
        ? dentroDaJanela
        : !dentroDaJanela;

  return { ativo, dentroDaJanela, diaSemana, horaLocal };
}

export function lerSegurancaDoBanco(linha: Record<string, unknown> | null | undefined): ConfiguracaoDeSeguranca {
  if (!linha || typeof linha !== 'object') return { ...PADRAO_SEGURANCA, scheduleWorkDays: [...PADRAO_SEGURANCA.scheduleWorkDays], adminAlertEvents: [...PADRAO_SEGURANCA.adminAlertEvents] };
  const n = (chave: string, padrao: number, min: number, max: number) => {
    const v = Number(linha[chave]);
    return Number.isInteger(v) && v >= min && v <= max ? v : padrao;
  };
  const b = (chave: string, padrao: boolean) => (typeof linha[chave] === 'boolean' ? (linha[chave] as boolean) : padrao);
  const s = (chave: string, padrao: string) => (typeof linha[chave] === 'string' ? (linha[chave] as string) : padrao);

  const presetBruto = s('antiban_preset', PADRAO_SEGURANCA.antibanPreset);
  const antibanPreset: PresetAntiban =
    presetBruto === 'conservador' || presetBruto === 'equilibrado' || presetBruto === 'moderado' || presetBruto === 'personalizado'
      ? presetBruto
      : 'equilibrado';

  const modoBruto = s('schedule_mode', PADRAO_SEGURANCA.scheduleMode);
  const scheduleMode: ModoHorario =
    modoBruto === 'always' || modoBruto === 'business_hours_only' || modoBruto === 'outside_hours_only' ? modoBruto : 'always';

  const minTypingMs = n('min_typing_ms', PADRAO_SEGURANCA.minTypingMs, LIMITES_SEGURANCA.minTypingMs.min, LIMITES_SEGURANCA.minTypingMs.max);
  const maxTypingMs = Math.max(
    minTypingMs,
    n('max_typing_ms', PADRAO_SEGURANCA.maxTypingMs, LIMITES_SEGURANCA.maxTypingMs.min, LIMITES_SEGURANCA.maxTypingMs.max),
  );
  const proactiveMinDelaySec = n(
    'proactive_min_delay_sec',
    PADRAO_SEGURANCA.proactiveMinDelaySec,
    LIMITES_SEGURANCA.proactiveMinDelaySec.min,
    LIMITES_SEGURANCA.proactiveMinDelaySec.max,
  );
  const proactiveMaxDelaySec = Math.max(
    proactiveMinDelaySec,
    n(
      'proactive_max_delay_sec',
      PADRAO_SEGURANCA.proactiveMaxDelaySec,
      LIMITES_SEGURANCA.proactiveMaxDelaySec.min,
      LIMITES_SEGURANCA.proactiveMaxDelaySec.max,
    ),
  );

  const diasBrutos = Array.isArray(linha.schedule_work_days) ? linha.schedule_work_days : PADRAO_SEGURANCA.scheduleWorkDays;
  const diasLimpos = Array.from(new Set(diasBrutos.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, x) => a - x);

  const eventosBrutos = Array.isArray(linha.admin_alert_events) ? linha.admin_alert_events : PADRAO_SEGURANCA.adminAlertEvents;
  const eventosLimpos = Array.from(
    new Set(
      eventosBrutos.filter((ev): ev is EventoAlertaSeguranca =>
        typeof ev === 'string' && (TODOS_EVENTOS_ALERTA_SEGURANCA as readonly string[]).includes(ev),
      ),
    ),
  );

  const startBruto = s('schedule_start', PADRAO_SEGURANCA.scheduleStart);
  const endBruto = s('schedule_end', PADRAO_SEGURANCA.scheduleEnd);

  return {
    antibanPreset,
    simulateTyping: b('simulate_typing', PADRAO_SEGURANCA.simulateTyping),
    minTypingMs,
    maxTypingMs,
    splitLongMessages: b('split_long_messages', PADRAO_SEGURANCA.splitLongMessages),
    debounceSeconds: n('debounce_seconds', PADRAO_SEGURANCA.debounceSeconds, LIMITES_SEGURANCA.debounceSeconds.min, LIMITES_SEGURANCA.debounceSeconds.max),
    pauseOnHumanReply: b('pause_on_human_reply', PADRAO_SEGURANCA.pauseOnHumanReply),
    humanPauseMinutes: n('human_pause_minutes', PADRAO_SEGURANCA.humanPauseMinutes, LIMITES_SEGURANCA.humanPauseMinutes.min, LIMITES_SEGURANCA.humanPauseMinutes.max),
    maxRepliesPerMinutePerContact: n(
      'max_replies_per_minute_per_contact',
      PADRAO_SEGURANCA.maxRepliesPerMinutePerContact,
      LIMITES_SEGURANCA.maxRepliesPerMinutePerContact.min,
      LIMITES_SEGURANCA.maxRepliesPerMinutePerContact.max,
    ),
    proactiveMinDelaySec,
    proactiveMaxDelaySec,
    dailyProactiveLimit: n(
      'daily_proactive_limit',
      PADRAO_SEGURANCA.dailyProactiveLimit,
      LIMITES_SEGURANCA.dailyProactiveLimit.min,
      LIMITES_SEGURANCA.dailyProactiveLimit.max,
    ),
    scheduleMode,
    scheduleStart: ehHoraValida(startBruto) ? startBruto : PADRAO_SEGURANCA.scheduleStart,
    scheduleEnd: ehHoraValida(endBruto) ? endBruto : PADRAO_SEGURANCA.scheduleEnd,
    scheduleWorkDays: diasLimpos,
    scheduleTimezone: s('schedule_timezone', PADRAO_SEGURANCA.scheduleTimezone).slice(0, 80) || PADRAO_SEGURANCA.scheduleTimezone,
    offHoursReplyMessage: s('off_hours_reply_message', '').slice(0, 4000),
    adminAlertEnabled: b('admin_alert_enabled', false),
    adminAlertWhatsapp: s('admin_alert_whatsapp', '').replace(/\D/g, ''),
    adminAlertEvents: eventosLimpos,
    adminAlertIncludeMessages: b('admin_alert_include_messages', true),
  };
}

export function conferirSeguranca(cfg: ConfiguracaoDeSeguranca): string | null {
  if (cfg.minTypingMs < LIMITES_SEGURANCA.minTypingMs.min || cfg.minTypingMs > LIMITES_SEGURANCA.minTypingMs.max) {
    return 'Tempo mínimo de digitação deve ficar entre 500 ms e 10.000 ms.';
  }
  if (cfg.maxTypingMs < LIMITES_SEGURANCA.maxTypingMs.min || cfg.maxTypingMs > LIMITES_SEGURANCA.maxTypingMs.max || cfg.maxTypingMs < cfg.minTypingMs) {
    return 'Tempo máximo de digitação precisa ser maior ou igual ao mínimo (até 15.000 ms).';
  }
  if (cfg.debounceSeconds < LIMITES_SEGURANCA.debounceSeconds.min || cfg.debounceSeconds > LIMITES_SEGURANCA.debounceSeconds.max) {
    return 'Espera de mensagens seguidas deve ficar entre 1 e 20 segundos.';
  }
  if (cfg.humanPauseMinutes < LIMITES_SEGURANCA.humanPauseMinutes.min || cfg.humanPauseMinutes > LIMITES_SEGURANCA.humanPauseMinutes.max) {
    return 'Pausa após resposta humana deve ficar entre 5 e 1440 minutos.';
  }
  if (
    cfg.maxRepliesPerMinutePerContact < LIMITES_SEGURANCA.maxRepliesPerMinutePerContact.min ||
    cfg.maxRepliesPerMinutePerContact > LIMITES_SEGURANCA.maxRepliesPerMinutePerContact.max
  ) {
    return 'Limite de respostas por minuto por contato deve ficar entre 1 e 60.';
  }
  if (cfg.proactiveMinDelaySec < LIMITES_SEGURANCA.proactiveMinDelaySec.min || cfg.proactiveMinDelaySec > LIMITES_SEGURANCA.proactiveMinDelaySec.max) {
    return 'Espera mínima da fila segura deve ficar entre 20 e 600 segundos.';
  }
  if (
    cfg.proactiveMaxDelaySec < LIMITES_SEGURANCA.proactiveMaxDelaySec.min ||
    cfg.proactiveMaxDelaySec > LIMITES_SEGURANCA.proactiveMaxDelaySec.max ||
    cfg.proactiveMaxDelaySec < cfg.proactiveMinDelaySec
  ) {
    return 'Espera máxima da fila segura deve ser maior ou igual à mínima (até 900 segundos).';
  }
  if (cfg.dailyProactiveLimit < LIMITES_SEGURANCA.dailyProactiveLimit.min || cfg.dailyProactiveLimit > LIMITES_SEGURANCA.dailyProactiveLimit.max) {
    return 'Teto diário por chip da fila segura deve ficar entre 1 e 150.';
  }
  if (!ehHoraValida(cfg.scheduleStart) || !ehHoraValida(cfg.scheduleEnd)) {
    return 'Informe os horários no formato HH:MM (ex.: 08:00 e 18:00).';
  }
  if (cfg.scheduleMode !== 'always' && cfg.scheduleWorkDays.length === 0) {
    return 'Escolha ao menos um dia da semana para a janela de atendimento.';
  }
  const whatsappLimpo = cfg.adminAlertWhatsapp.replace(/\D/g, '');
  if (whatsappLimpo && !/^[0-9]{10,15}$/.test(whatsappLimpo)) {
    return 'Informe o WhatsApp de alertas com DDI e DDD (10 a 15 dígitos).';
  }
  if (cfg.adminAlertEnabled && !whatsappLimpo) {
    return 'Informe um WhatsApp válido para ativar os alertas.';
  }
  if (cfg.offHoursReplyMessage.length > 4000) {
    return 'Mensagem automática fora do horário pode ter no máximo 4000 caracteres.';
  }
  return null;
}

export function segurancaParaOBanco(cfg: ConfiguracaoDeSeguranca): Record<string, unknown> {
  return {
    antiban_preset: cfg.antibanPreset,
    simulate_typing: cfg.simulateTyping,
    min_typing_ms: cfg.minTypingMs,
    max_typing_ms: cfg.maxTypingMs,
    split_long_messages: cfg.splitLongMessages,
    debounce_seconds: cfg.debounceSeconds,
    pause_on_human_reply: cfg.pauseOnHumanReply,
    human_pause_minutes: cfg.humanPauseMinutes,
    max_replies_per_minute_per_contact: cfg.maxRepliesPerMinutePerContact,
    proactive_min_delay_sec: cfg.proactiveMinDelaySec,
    proactive_max_delay_sec: cfg.proactiveMaxDelaySec,
    daily_proactive_limit: cfg.dailyProactiveLimit,
    schedule_mode: cfg.scheduleMode,
    schedule_start: cfg.scheduleStart,
    schedule_end: cfg.scheduleEnd,
    schedule_work_days: cfg.scheduleWorkDays,
    schedule_timezone: cfg.scheduleTimezone,
    off_hours_reply_message: cfg.offHoursReplyMessage.trim(),
    admin_alert_enabled: cfg.adminAlertEnabled,
    admin_alert_whatsapp: cfg.adminAlertWhatsapp.replace(/\D/g, ''),
    admin_alert_events: cfg.adminAlertEvents,
    admin_alert_include_messages: cfg.adminAlertIncludeMessages,
  };
}
