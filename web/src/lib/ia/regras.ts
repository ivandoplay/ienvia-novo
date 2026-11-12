/**
 * Regras do Motor de IA que não dependem de banco nem de rede: os valores permitidos, os padrões,
 * a conferência do que vem do formulário e os textos mostrados na tela.
 * A tela, as ações do servidor e os testes usam as mesmas. O banco confere tudo de novo ao gravar.
 */

/**
 * A IA já responde sozinha no WhatsApp?
 * Enquanto era `false`, as telas de Treinamento e do Motor de IA avisavam que o que se configurava ali
 * ficava guardado mas ainda não era usado em conversa nenhuma. Virou `true` junto com o atendente
 * (lib/atendente/atendente.ts): a partir daí, o que está nessas telas vale nas conversas dos chips
 * que estiverem com a IA ligada.
 */
export const ATENDENTE_DE_IA_NO_AR: boolean = true;

export type Provedor = 'gemini' | 'openrouter' | 'nvidia';
/** Na ordem em que aparecem na tela. */
export const PROVEDORES: readonly Provedor[] = ['gemini', 'openrouter', 'nvidia'];

/**
 * Por que uma chamada a um provedor de IA não deu certo:
 *   chave_invalida     — o provedor não aceitou a chave (errada, apagada ou sem permissão);
 *   chave_vazada       — o provedor bloqueou a chave porque ela apareceu em lugar público; só uma chave nova resolve;
 *   sem_credito        — a conta não tem saldo;
 *   limite             — passou do limite de uso; vale tentar de novo mais tarde;
 *   modelo_inexistente — o modelo não existe ou não está liberado para esta conta;
 *   bloqueada          — o provedor recusou o conteúdo (filtro de segurança dele);
 *   nao_suportado      — este provedor ou este modelo não recebe o tipo de arquivo enviado (foto, áudio…);
 *   indisponivel       — o provedor falhou do lado dele;
 *   tempo              — não respondeu dentro do prazo;
 *   rede               — não deu para chegar até o provedor;
 *   resposta_vazia     — respondeu, mas sem texto;
 *   recusada           — o provedor não aceitou o pedido por outro motivo.
 */
export type MotivoDoErroDeIa =
  | 'chave_invalida'
  | 'chave_vazada'
  | 'sem_credito'
  | 'limite'
  | 'modelo_inexistente'
  | 'bloqueada'
  | 'nao_suportado'
  | 'indisponivel'
  | 'tempo'
  | 'rede'
  | 'resposta_vazia'
  | 'recusada';

export const NOME_DO_PROVEDOR: Record<Provedor, string> = { gemini: 'Google Gemini', openrouter: 'OpenRouter', nvidia: 'NVIDIA' };

export const ehProvedor = (valor: unknown): valor is Provedor => valor === 'gemini' || valor === 'openrouter' || valor === 'nvidia';

/** Uma posição de reserva na ordem de uso: um provedor, ou "none" (ninguém). */
export type Reserva = Provedor | 'none';

/**
 * Os tipos de arquivo que podem acompanhar a mensagem de um cliente, do jeito que importa para a IA.
 * O que cada provedor recebe foi conferido com chamadas de verdade em 11/11/2026
 * (apoio-da-reconstrucao/ia-respostas-reais.txt):
 *   - o Gemini recebe foto, áudio e documento;
 *   - o OpenRouter recebe foto quando o modelo escolhido enxerga (senão avisa com um erro claro);
 *   - a NVIDIA recebe foto quando o modelo escolhido enxerga. ÁUDIO NÃO: a maioria dos modelos de lá
 *     descarta o áudio calada e responde como se ele não existisse, o que num atendimento vira resposta inventada.
 */
export type TipoDeAnexo = 'foto' | 'audio' | 'documento';

const O_QUE_RECEBE: Record<Provedor, readonly TipoDeAnexo[]> = {
  gemini: ['foto', 'audio', 'documento'],
  openrouter: ['foto'],
  nvidia: ['foto'],
};

/** Este provedor pode receber este tipo de arquivo? (Para foto, ainda depende do modelo escolhido.) */
export const provedorRecebe = (provedor: Provedor, tipo: TipoDeAnexo): boolean => O_QUE_RECEBE[provedor].includes(tipo);

/** "image/jpeg" → foto, "audio/ogg; codecs=opus" → audio, o resto → documento. */
export function tipoDoAnexo(tipoDoConteudo: string): TipoDeAnexo {
  const tipo = tipoDoConteudo.trim().toLowerCase();
  if (tipo.startsWith('image/')) return 'foto';
  if (tipo.startsWith('audio/')) return 'audio';
  return 'documento';
}

export type EventoDeAlertaDoAdmin = 'handoff' | 'silent_handoff' | 'uncertain_send' | 'error' | 'safety';

export const EVENTOS_DO_ALERTA_DO_ADMIN: ReadonlyArray<{ valor: EventoDeAlertaDoAdmin; rotulo: string; descricao: string }> = [
  { valor: 'handoff', rotulo: 'Repasses para humano', descricao: 'Sempre que a IA usar [[CHAMAR_HUMANO]] ou disparar um gatilho configurado.' },
  { valor: 'silent_handoff', rotulo: 'Pausas silenciosas', descricao: 'Quando a IA entrar em silêncio por mensagem solta ou mídia sem leitura.' },
  { valor: 'uncertain_send', rotulo: 'Envio sem confirmação', descricao: 'Quando a Evolution responder sem confirmar se a mensagem saiu.' },
  { valor: 'error', rotulo: 'Falhas da IA', descricao: 'Quando nenhum provedor responder ou ocorrer erro inesperado no turno.' },
  { valor: 'safety', rotulo: 'Parada de segurança', descricao: 'Quando houver muitas mensagens seguidas (proteção contra loop ou robô).' },
];

export const TODOS_EVENTOS_DO_ALERTA: readonly EventoDeAlertaDoAdmin[] = ['handoff', 'silent_handoff', 'uncertain_send', 'error', 'safety'];

export const ehEventoDeAlerta = (valor: unknown): valor is EventoDeAlertaDoAdmin =>
  typeof valor === 'string' && (TODOS_EVENTOS_DO_ALERTA as readonly string[]).includes(valor);

export const whatsappSomenteDigitos = (valor: unknown): string => (typeof valor === 'string' ? valor.replace(/\D/g, '') : '');

export interface ConfiguracaoDoMotor {
  /** O provedor que responde. */
  provedor: Provedor;
  /** Quem assume quando o principal falha. */
  reserva: Reserva;
  /** Quem assume quando a reserva também falha. Só existe quando há reserva. */
  segundaReserva: Reserva;
  modeloGemini: string;
  modeloOpenRouter: string;
  modeloNvidia: string;
  /** 0 = respostas previsíveis, fiéis ao treinamento; 1 = mais soltas. */
  criatividade: number;
  /** Quantas mensagens anteriores a IA lê antes de responder. */
  memoria: number;
  /** Quanto tempo a IA espera o cliente terminar de escrever antes de responder. */
  esperaEmSegundos: number;
  simularDigitando: boolean;
  dividirMensagensLongas: boolean;
  /** Quando uma pessoa responde (pelo painel ou pelo celular), a IA para naquela conversa. */
  pausarQuandoHumanoResponde: boolean;
  /** Por quanto tempo a IA fica parada depois que uma pessoa respondeu. */
  minutosDePausa: number;
  /** Enviar dossiê completo no WhatsApp administrativo sempre que a conversa entrar em modo manual. */
  alertaAdminAtivo: boolean;
  /** Número administrativo só com dígitos (ex.: 5586999999999). */
  alertaAdminWhatsapp: string;
  /** Quais situações disparam o dossiê administrativo. */
  alertaAdminEventos: EventoDeAlertaDoAdmin[];
  /** Incluir as últimas mensagens do cliente dentro do dossiê. */
  alertaAdminIncluirMensagens: boolean;
}

export interface ChaveCadastrada {
  cadastrada: boolean;
  /** Os últimos caracteres da chave. Só o dono da conta recebe. */
  final: string | null;
  atualizadaEm: string | null;
}

export interface MotorDeIa {
  configuracao: ConfiguracaoDoMotor;
  chaves: Record<Provedor, ChaveCadastrada>;
  /** Só o dono da conta altera o Motor de IA. */
  podeEditar: boolean;
  atualizadoEm: string | null;
}

export const PADRAO_DO_MOTOR: ConfiguracaoDoMotor = {
  provedor: 'gemini',
  reserva: 'none',
  segundaReserva: 'none',
  modeloGemini: 'gemini-3.5-flash-lite',
  modeloOpenRouter: 'deepseek/deepseek-chat',
  // Escolhido com chamadas de verdade (11/11/2026): foi o único que acertou as quatro perguntas de teste
  // (não inventou, passou para uma pessoa quando devia) respondendo em menos de 1 s, e ainda enxerga fotos.
  modeloNvidia: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  criatividade: 0.35,
  memoria: 20,
  esperaEmSegundos: 6,
  simularDigitando: true,
  dividirMensagensLongas: true,
  pausarQuandoHumanoResponde: true,
  minutosDePausa: 60,
  alertaAdminAtivo: false,
  alertaAdminWhatsapp: '',
  alertaAdminEventos: [...TODOS_EVENTOS_DO_ALERTA],
  alertaAdminIncluirMensagens: true,
};

/** Os mesmos limites que o banco confere. */
export const LIMITES_DO_MOTOR = {
  criatividade: { minimo: 0, maximo: 1 },
  memoria: { minimo: 4, maximo: 60 },
  // Até 20 segundos: a espera, a resposta do provedor e o envio precisam caber num único pedido ao servidor.
  esperaEmSegundos: { minimo: 1, maximo: 20 },
  minutosDePausa: { minimo: 5, maximo: 1440 },
} as const;

const NOME_DE_MODELO = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
export const ehNomeDeModelo = (valor: unknown): valor is string => typeof valor === 'string' && NOME_DE_MODELO.test(valor);

type Json = Record<string, unknown>;
const objeto = (valor: unknown): Json => (valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Json) : {});
const textoOuNulo = (valor: unknown): string | null => (typeof valor === 'string' && valor ? valor : null);

function lerChave(valor: unknown): ChaveCadastrada {
  const chave = objeto(valor);
  return { cadastrada: chave.configured === true, final: textoOuNulo(chave.hint), atualizadaEm: textoOuNulo(chave.updated_at) };
}

type Ordem = Pick<ConfiguracaoDoMotor, 'provedor' | 'reserva' | 'segundaReserva'>;

/**
 * Deixa a ordem de uso coerente: ninguém aparece duas vezes, e não existe segunda reserva sem a primeira
 * (a segunda sobe de posto). O banco recusa uma ordem incoerente; isto evita chegar lá.
 */
export function arrumarOrdem(ordem: Ordem): Ordem {
  const reservas = [ordem.reserva, ordem.segundaReserva].filter(
    (reserva, indice, todas): reserva is Provedor => reserva !== 'none' && reserva !== ordem.provedor && todas.indexOf(reserva) === indice,
  );
  return { provedor: ordem.provedor, reserva: reservas[0] ?? 'none', segundaReserva: reservas[1] ?? 'none' };
}

/** Os provedores na ordem em que são tentados: o principal, depois as reservas. */
export function ordemDeUso(configuracao: Ordem): Provedor[] {
  const { provedor, reserva, segundaReserva } = arrumarOrdem(configuracao);
  return [provedor, reserva, segundaReserva].filter((item): item is Provedor => item !== 'none');
}

/** Transforma o que o banco devolve (read_my_ai_settings) no formato usado pelas telas. Tolera campos faltando. */
export function lerMotor(resposta: unknown): MotorDeIa {
  const dados = objeto(resposta);
  const chaves = objeto(dados.keys);
  const numero = (valor: unknown, padrao: number) => (typeof valor === 'number' && Number.isFinite(valor) ? valor : padrao);
  const logico = (valor: unknown, padrao: boolean) => (typeof valor === 'boolean' ? valor : padrao);
  const eventosBrutos = Array.isArray(dados.admin_alert_events)
    ? dados.admin_alert_events.filter((item): item is EventoDeAlertaDoAdmin => ehEventoDeAlerta(item))
    : null;
  const alertaWhatsapp = whatsappSomenteDigitos(dados.admin_alert_whatsapp);
  return {
    configuracao: {
      ...arrumarOrdem({
        provedor: ehProvedor(dados.provider) ? dados.provider : PADRAO_DO_MOTOR.provedor,
        reserva: ehProvedor(dados.fallback_provider) ? dados.fallback_provider : 'none',
        segundaReserva: ehProvedor(dados.second_fallback_provider) ? dados.second_fallback_provider : 'none',
      }),
      modeloGemini: ehNomeDeModelo(dados.gemini_model) ? dados.gemini_model : PADRAO_DO_MOTOR.modeloGemini,
      modeloOpenRouter: ehNomeDeModelo(dados.openrouter_model) ? dados.openrouter_model : PADRAO_DO_MOTOR.modeloOpenRouter,
      modeloNvidia: ehNomeDeModelo(dados.nvidia_model) ? dados.nvidia_model : PADRAO_DO_MOTOR.modeloNvidia,
      criatividade: numero(dados.temperature, PADRAO_DO_MOTOR.criatividade),
      memoria: numero(dados.max_history_messages, PADRAO_DO_MOTOR.memoria),
      esperaEmSegundos: numero(dados.debounce_seconds, PADRAO_DO_MOTOR.esperaEmSegundos),
      simularDigitando: logico(dados.simulate_typing, PADRAO_DO_MOTOR.simularDigitando),
      dividirMensagensLongas: logico(dados.split_long_messages, PADRAO_DO_MOTOR.dividirMensagensLongas),
      pausarQuandoHumanoResponde: logico(dados.pause_on_human_reply, PADRAO_DO_MOTOR.pausarQuandoHumanoResponde),
      minutosDePausa: numero(dados.human_pause_minutes, PADRAO_DO_MOTOR.minutosDePausa),
      alertaAdminAtivo: logico(dados.admin_alert_enabled, PADRAO_DO_MOTOR.alertaAdminAtivo),
      alertaAdminWhatsapp: /^[0-9]{10,15}$/.test(alertaWhatsapp) ? alertaWhatsapp : '',
      alertaAdminEventos:
        eventosBrutos !== null
          ? Array.from(new Set(eventosBrutos))
          : [...PADRAO_DO_MOTOR.alertaAdminEventos],
      alertaAdminIncluirMensagens: logico(dados.admin_alert_include_messages, PADRAO_DO_MOTOR.alertaAdminIncluirMensagens),
    },
    chaves: { gemini: lerChave(chaves.gemini), openrouter: lerChave(chaves.openrouter), nvidia: lerChave(chaves.nvidia) },
    podeEditar: dados.can_edit === true,
    atualizadoEm: textoOuNulo(dados.updated_at),
  };
}

/** O formato que o banco espera em save_my_ai_settings. */
export function configuracaoParaOBanco(configuracao: ConfiguracaoDoMotor): Json {
  return {
    provider: configuracao.provedor,
    fallback_provider: configuracao.reserva,
    second_fallback_provider: configuracao.segundaReserva,
    gemini_model: configuracao.modeloGemini,
    openrouter_model: configuracao.modeloOpenRouter,
    nvidia_model: configuracao.modeloNvidia,
    temperature: configuracao.criatividade,
    max_history_messages: configuracao.memoria,
    debounce_seconds: configuracao.esperaEmSegundos,
    simulate_typing: configuracao.simularDigitando,
    split_long_messages: configuracao.dividirMensagensLongas,
    pause_on_human_reply: configuracao.pausarQuandoHumanoResponde,
    human_pause_minutes: configuracao.minutosDePausa,
    admin_alert_enabled: configuracao.alertaAdminAtivo,
    admin_alert_whatsapp: configuracao.alertaAdminWhatsapp,
    admin_alert_events: configuracao.alertaAdminEventos,
    admin_alert_include_messages: configuracao.alertaAdminIncluirMensagens,
  };
}

type Conferencia = { ok: true; configuracao: ConfiguracaoDoMotor } | { ok: false; erro: string };

function inteiroEntre(valor: unknown, { minimo, maximo }: { minimo: number; maximo: number }): number | null {
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= minimo && valor <= maximo ? valor : null;
}

/**
 * Confere o que veio do formulário (nunca confie no navegador) e devolve a configuração pronta para gravar.
 * Uma ordem de uso com provedor repetido não faz sentido: a repetição é desfeita (ver `arrumarOrdem`).
 */
export function conferirConfiguracao(entrada: unknown): Conferencia {
  const dados = objeto(entrada);
  if (!ehProvedor(dados.provedor)) return { ok: false, erro: 'Escolha o provedor principal.' };
  if (dados.reserva !== 'none' && !ehProvedor(dados.reserva)) return { ok: false, erro: 'Escolha a reserva (ou "sem reserva").' };
  if (dados.segundaReserva !== 'none' && !ehProvedor(dados.segundaReserva)) {
    return { ok: false, erro: 'Escolha a segunda reserva (ou "sem segunda reserva").' };
  }

  const modeloGemini = typeof dados.modeloGemini === 'string' ? dados.modeloGemini.trim() : '';
  const modeloOpenRouter = typeof dados.modeloOpenRouter === 'string' ? dados.modeloOpenRouter.trim() : '';
  const modeloNvidia = typeof dados.modeloNvidia === 'string' ? dados.modeloNvidia.trim() : '';
  if (!ehNomeDeModelo(modeloGemini)) return { ok: false, erro: 'O nome do modelo do Gemini não é válido. Exemplo: gemini-3.5-flash-lite' };
  if (!ehNomeDeModelo(modeloOpenRouter)) return { ok: false, erro: 'O nome do modelo do OpenRouter não é válido. Exemplo: deepseek/deepseek-chat' };
  if (!ehNomeDeModelo(modeloNvidia)) {
    return { ok: false, erro: 'O nome do modelo da NVIDIA não é válido. Exemplo: nvidia/nemotron-3.5-super-vl-120b-a12b' };
  }

  const { criatividade } = dados;
  if (typeof criatividade !== 'number' || !Number.isFinite(criatividade) || criatividade < 0 || criatividade > 1) {
    return { ok: false, erro: 'A criatividade vai de 0 a 1.' };
  }
  const memoria = inteiroEntre(dados.memoria, LIMITES_DO_MOTOR.memoria);
  if (memoria === null) return { ok: false, erro: 'A memória vai de 4 a 60 mensagens.' };
  const esperaEmSegundos = inteiroEntre(dados.esperaEmSegundos, LIMITES_DO_MOTOR.esperaEmSegundos);
  if (esperaEmSegundos === null) return { ok: false, erro: 'O tempo de espera vai de 1 a 20 segundos.' };
  const minutosDePausa = inteiroEntre(dados.minutosDePausa, LIMITES_DO_MOTOR.minutosDePausa);
  if (minutosDePausa === null) return { ok: false, erro: 'A pausa vai de 5 minutos a 24 horas (1440 minutos).' };

  for (const campo of ['simularDigitando', 'dividirMensagensLongas', 'pausarQuandoHumanoResponde'] as const) {
    if (typeof dados[campo] !== 'boolean') return { ok: false, erro: 'Não foi possível ler as opções de comportamento. Atualize a página.' };
  }

  const alertaAdminAtivo = dados.alertaAdminAtivo === true;
  const alertaAdminIncluirMensagens = dados.alertaAdminIncluirMensagens !== false;
  const alertaAdminWhatsapp = whatsappSomenteDigitos(dados.alertaAdminWhatsapp);
  if (alertaAdminWhatsapp !== '' && !/^[0-9]{10,15}$/.test(alertaAdminWhatsapp)) {
    return { ok: false, erro: 'Informe o WhatsApp administrativo completo (DDI + DDD + número, com 10 a 15 dígitos). Exemplo: 5586999999999.' };
  }
  if (alertaAdminAtivo && !alertaAdminWhatsapp) {
    return { ok: false, erro: 'Digite o WhatsApp administrativo antes de ativar o envio automático de dossiês.' };
  }
  const eventosEntrada = Array.isArray(dados.alertaAdminEventos)
    ? dados.alertaAdminEventos.filter((item): item is EventoDeAlertaDoAdmin => ehEventoDeAlerta(item))
    : [...TODOS_EVENTOS_DO_ALERTA];
  const alertaAdminEventos = Array.from(new Set(eventosEntrada));
  if (alertaAdminAtivo && alertaAdminEventos.length === 0) {
    return { ok: false, erro: 'Escolha ao menos um motivo para disparar o dossiê administrativo.' };
  }

  return {
    ok: true,
    configuracao: {
      ...arrumarOrdem({ provedor: dados.provedor, reserva: dados.reserva, segundaReserva: dados.segundaReserva }),
      modeloGemini,
      modeloOpenRouter,
      modeloNvidia,
      criatividade: Math.round(criatividade * 100) / 100,
      memoria,
      esperaEmSegundos,
      simularDigitando: dados.simularDigitando === true,
      dividirMensagensLongas: dados.dividirMensagensLongas === true,
      pausarQuandoHumanoResponde: dados.pausarQuandoHumanoResponde === true,
      minutosDePausa,
      alertaAdminAtivo,
      alertaAdminWhatsapp,
      alertaAdminEventos,
      alertaAdminIncluirMensagens,
    },
  };
}

/** Como começa a chave de cada provedor (Google "AIza…", OpenRouter "sk-or-…", NVIDIA "nvapi-…"). */
const COMECO_DA_CHAVE: Record<Provedor, RegExp> = { gemini: /^AIza/, openrouter: /^sk-or-/i, nvidia: /^nvapi-/i };

/** "do Google Gemini", "do OpenRouter", "da NVIDIA". */
export const doProvedor = (provedor: Provedor): string => `${provedor === 'nvidia' ? 'da' : 'do'} ${NOME_DO_PROVEDOR[provedor]}`;

/**
 * Confere uma chave colada pela pessoa. Devolve a mensagem do problema, ou `null` quando parece boa.
 * Não garante que a chave funciona (isso é o teste de conexão): só pega os enganos comuns.
 */
export function conferirChave(provedor: Provedor, chave: unknown): string | null {
  if (typeof chave !== 'string' || !chave.trim()) return 'Cole a chave no campo.';
  const limpa = chave.trim();
  if (/\s/.test(limpa)) return 'A chave não pode ter espaços nem quebras de linha. Copie de novo, só a chave.';
  // Só os caracteres visíveis mais simples: uma chave de verdade não tem acento nem emoji.
  if (!/^[\x21-\x7e]+$/.test(limpa)) return 'A chave tem caracteres que não fazem parte de uma chave. Copie de novo, só a chave.';
  if (limpa.length < 16) return 'Esta chave está curta demais. Confira se copiou inteira.';
  if (limpa.length > 400) return 'Este texto é comprido demais para ser uma chave.';
  // Cada provedor começa as chaves de um jeito; isto pega a chave colada no cartão errado.
  const dona = PROVEDORES.find((outro) => COMECO_DA_CHAVE[outro].test(limpa));
  if (dona && dona !== provedor) {
    const artigo = dona === 'nvidia' ? 'da' : 'do';
    return `Esta parece ser uma chave ${artigo} ${NOME_DO_PROVEDOR[dona]}. Cole no cartão ${artigo} ${NOME_DO_PROVEDOR[dona]}.`;
  }
  return null;
}

/** De quais provedores a configuração precisa (o principal primeiro). */
export const provedoresNecessarios = (configuracao: Ordem): Provedor[] => ordemDeUso(configuracao);

/**
 * Quem pode atender um pedido, na ordem em que será tentado.
 * Sem arquivo, é a ordem de uso inteira. Com arquivo, ficam só os provedores que recebem aquele tipo
 * (um áudio, por exemplo, só vai para quem escuta). A lista pode sair vazia: aí ninguém responde.
 */
export function rotaDoPedido(configuracao: Ordem, anexo: TipoDeAnexo | null = null): Provedor[] {
  const ordem = ordemDeUso(configuracao);
  return anexo ? ordem.filter((provedor) => provedorRecebe(provedor, anexo)) : ordem;
}

export const modeloDoProvedor = (
  configuracao: Pick<ConfiguracaoDoMotor, 'modeloGemini' | 'modeloOpenRouter' | 'modeloNvidia'>,
  provedor: Provedor,
): string => (provedor === 'gemini' ? configuracao.modeloGemini : provedor === 'openrouter' ? configuracao.modeloOpenRouter : configuracao.modeloNvidia);

/** O nome do campo de modelo de cada provedor na configuração. */
export const CAMPO_DO_MODELO: Record<Provedor, 'modeloGemini' | 'modeloOpenRouter' | 'modeloNvidia'> = {
  gemini: 'modeloGemini',
  openrouter: 'modeloOpenRouter',
  nvidia: 'modeloNvidia',
};

export interface SituacaoDoMotor {
  /** A IA tem o mínimo para responder: a chave do provedor principal. */
  pronta: boolean;
  /** O que falta, já escrito para a tela (vazio quando está tudo certo). */
  faltas: string[];
  /** Algum provedor da ordem de uso, com chave cadastrada, escuta áudio? */
  escutaAudio: boolean;
}

const POSTO = ['o provedor principal', 'a reserva', 'a segunda reserva'];

/** Diz se o Motor de IA está pronto para uso e, se não estiver, o que falta. */
export function situacaoDoMotor(motor: Pick<MotorDeIa, 'configuracao' | 'chaves'>): SituacaoDoMotor {
  const ordem = ordemDeUso(motor.configuracao);
  const faltas = ordem
    .map((provedor, posicao) => (motor.chaves[provedor].cadastrada ? null : `Falta a chave ${doProvedor(provedor)}, ${POSTO[posicao]}.`))
    .filter((falta): falta is string => falta !== null);
  return {
    pronta: motor.chaves[ordem[0]!].cadastrada,
    faltas,
    escutaAudio: ordem.some((provedor) => provedorRecebe(provedor, 'audio') && motor.chaves[provedor].cadastrada),
  };
}

/** O problema de uma chamada ao provedor, em palavras para a tela. */
export function explicarErroDeIa(motivo: MotivoDoErroDeIa, provedor: Provedor, modelo?: string): string {
  const nome = NOME_DO_PROVEDOR[provedor];
  // "O Google Gemini", "O OpenRouter", "A NVIDIA".
  const sujeito = `${provedor === 'nvidia' ? 'A' : 'O'} ${nome}`;
  const de = doProvedor(provedor);
  switch (motivo) {
    case 'chave_invalida':
      return `${sujeito} recusou a chave. Confira se ela foi copiada inteira e se continua ativa.`;
    case 'chave_vazada':
      return `${sujeito} bloqueou esta chave porque ela apareceu em algum lugar público. Ela não volta a funcionar: crie uma chave nova no site ${de}, cadastre aqui e apague a antiga.`;
    case 'sem_credito':
      return `A conta ${de} está sem crédito.`;
    case 'limite':
      return `${sujeito} avisou que o limite de uso desta chave foi atingido. Espere um pouco e tente de novo.`;
    case 'modelo_inexistente':
      return `O modelo ${modelo ? `"${modelo}"` : 'escolhido'} não existe ${provedor === 'nvidia' ? 'na' : 'no'} ${nome}, ou não está liberado para a sua conta. Escolha outro modelo.`;
    case 'bloqueada':
      return `${sujeito} recusou o conteúdo da mensagem.`;
    case 'nao_suportado':
      return `O modelo ${modelo ? `"${modelo}"` : 'escolhido'} ${de} não recebe este tipo de arquivo.`;
    case 'indisponivel':
      return `${sujeito} está com problema agora. Tente de novo em instantes.`;
    case 'tempo':
      return `${sujeito} demorou demais para responder.`;
    case 'rede':
      return `Não foi possível falar com ${provedor === 'nvidia' ? 'a' : 'o'} ${nome}. Tente de novo em instantes.`;
    case 'resposta_vazia':
      return `${sujeito} respondeu sem texto. Tente outro modelo.`;
    default:
      return `${sujeito} não aceitou o pedido.`;
  }
}

/** "0,8 s" ou "12 s": quanto tempo o provedor levou para responder. */
export function duracaoLegivel(ms: number): string {
  const segundos = Math.max(0, ms) / 1000;
  return segundos < 10 ? `${segundos.toFixed(1).replace('.', ',')} s` : `${Math.round(segundos)} s`;
}
