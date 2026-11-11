/**
 * Regras da Inbox que não dependem de banco nem de rede.
 * Ficam aqui para a tela, as ações do servidor e os testes usarem as mesmas.
 */
import { formatarTelefone } from '@/lib/instancias/regras';
import { FUSO_PADRAO, inicioDoDia } from '@/lib/tempo';

/** Os filtros da lista de conversas. `valor` vai no endereço (?ver=...); `noBanco` é o nome que o banco entende. */
export const VISOES = [
  { valor: 'ativas', noBanco: 'open', rotulo: 'Ativas' },
  { valor: 'nao-lidas', noBanco: 'unread', rotulo: 'Não lidas' },
  { valor: 'esperando', noBanco: 'waiting', rotulo: 'Esperando você' },
  { valor: 'resolvidas', noBanco: 'resolved', rotulo: 'Resolvidas' },
] as const;

export type Visao = (typeof VISOES)[number]['valor'];

export function lerVisao(valor: unknown): Visao {
  return VISOES.find((visao) => visao.valor === valor)?.valor ?? 'ativas';
}

export function visaoNoBanco(visao: Visao): string {
  return VISOES.find((item) => item.valor === visao)?.noBanco ?? 'open';
}

/** Quantas conversas a lista traz por vez (o botão "Ver mais" pede outro tanto). */
export const CONVERSAS_POR_PAGINA = 40;
const LIMITE_MAXIMO = 200;

export function lerLimite(valor: unknown): number {
  const numero = typeof valor === 'string' && /^[0-9]{1,4}$/.test(valor) ? Number(valor) : CONVERSAS_POR_PAGINA;
  return Math.min(Math.max(numero, 1), LIMITE_MAXIMO);
}

/** O limite do próximo "Ver mais", ou `null` quando já chegou ao máximo. */
export function proximoLimite(atual: number): number | null {
  return atual >= LIMITE_MAXIMO ? null : Math.min(atual + CONVERSAS_POR_PAGINA, LIMITE_MAXIMO);
}

/** Quantas mensagens a conversa aberta traz (as mais recentes); "ver anteriores" pede outro tanto. */
export const MENSAGENS_POR_VEZ = 200;
const MENSAGENS_NO_MAXIMO = 1000;

export function lerLimiteDeMensagens(valor: unknown): number {
  const pedido = typeof valor === 'string' && /^[0-9]{1,4}$/.test(valor) ? Number(valor) : MENSAGENS_POR_VEZ;
  return Math.min(Math.max(pedido, 1), MENSAGENS_NO_MAXIMO);
}

/** O limite do próximo "ver mensagens anteriores", ou `null` quando já chegou ao máximo que a tela carrega. */
export function proximoLimiteDeMensagens(atual: number): number | null {
  return atual >= MENSAGENS_NO_MAXIMO ? null : Math.min(atual + MENSAGENS_POR_VEZ, MENSAGENS_NO_MAXIMO);
}

export const BUSCA_MAXIMA = 80;

/** Texto de busca limpo (sem espaços nas pontas, no tamanho máximo). Vazio vira `null`. */
export function lerBusca(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.replace(/\s+/g, ' ').trim().slice(0, BUSCA_MAXIMA);
  return limpo ? limpo : null;
}

/**
 * Se a busca parece um telefone, devolve os trechos de dígitos a procurar.
 * No Brasil o mesmo celular aparece com e sem o nono dígito, então as duas formas entram.
 * "(85) 98888-7777" → ["85988887777", "8588887777"]
 */
export function variacoesDeTelefone(busca: string): string[] {
  if (!/^[0-9\s().+-]+$/.test(busca)) return [];
  const digitos = busca.replace(/\D/g, '').replace(/^0+/, '');
  if (digitos.length < 4 || digitos.length > 20) return [];

  const variacoes = new Set([digitos]);
  // Só o número: 9 + 8 dígitos.
  if (digitos.length === 9 && digitos.startsWith('9')) variacoes.add(digitos.slice(1));
  // DDD + número.
  if (digitos.length === 11 && digitos[2] === '9') variacoes.add(digitos.slice(0, 2) + digitos.slice(3));
  if (digitos.length === 10) variacoes.add(`${digitos.slice(0, 2)}9${digitos.slice(2)}`);
  // 55 + DDD + número.
  if (digitos.length === 13 && digitos.startsWith('55') && digitos[4] === '9') variacoes.add(digitos.slice(0, 4) + digitos.slice(5));
  if (digitos.length === 12 && digitos.startsWith('55')) variacoes.add(`${digitos.slice(0, 4)}9${digitos.slice(4)}`);
  return [...variacoes];
}

/** Monta o endereço da Inbox guardando só o que foge do padrão. */
export function enderecoDaInbox(filtros: {
  visao?: Visao;
  chipId?: string | null;
  busca?: string | null;
  conversaId?: string | null;
  limite?: number | null;
  /** Quantas mensagens da conversa aberta carregar (só entra no endereço quando passa do padrão). */
  mensagens?: number | null;
}): string {
  const consulta = new URLSearchParams();
  if (filtros.visao && filtros.visao !== 'ativas') consulta.set('ver', filtros.visao);
  if (filtros.chipId) consulta.set('chip', filtros.chipId);
  if (filtros.busca) consulta.set('busca', filtros.busca);
  if (filtros.limite && filtros.limite !== CONVERSAS_POR_PAGINA) consulta.set('limite', String(filtros.limite));
  if (filtros.conversaId) consulta.set('c', filtros.conversaId);
  if (filtros.conversaId && filtros.mensagens && filtros.mensagens !== MENSAGENS_POR_VEZ) consulta.set('m', String(filtros.mensagens));
  const texto = consulta.toString();
  return texto ? `/inbox?${texto}` : '/inbox';
}

export type TomDaEtapa = 'atencao' | 'ok' | 'neutro' | 'ia';

/** Etapa da conversa (coluna `conversations.stage`) em português, do ponto de vista de quem atende. */
export function descreverEtapa(etapa: string): { texto: string; tom: TomDaEtapa } {
  switch (etapa) {
    case 'new':
      return { texto: 'Nova', tom: 'atencao' };
    case 'ai':
      return { texto: 'Com a IA', tom: 'ia' };
    case 'waiting_human':
      return { texto: 'Esperando você', tom: 'atencao' };
    case 'human':
      return { texto: 'Com você', tom: 'atencao' };
    case 'waiting_customer':
      return { texto: 'Aguardando o cliente', tom: 'neutro' };
    case 'resolved':
      return { texto: 'Resolvida', tom: 'ok' };
    case 'archived':
      return { texto: 'Arquivada', tom: 'neutro' };
    default:
      return { texto: 'Em andamento', tom: 'neutro' };
  }
}

export const ehConversaEncerrada = (etapa: string): boolean => etapa === 'resolved' || etapa === 'archived';

/** Como chamar o contato na tela: o nome; sem nome, o telefone; sem os dois, um texto neutro. */
export function nomeDoContato(nome: string | null | undefined, telefone: string | null | undefined): string {
  const limpo = nome?.trim();
  if (limpo) return limpo;
  return formatarTelefone(telefone) || 'Contato sem nome';
}

/**
 * Letras do círculo ao lado do nome. Contato sem nome ganha "#".
 * Nomes do WhatsApp vêm cheios de emojis e símbolos; só letras e números contam.
 */
export function iniciaisDoContato(nome: string | null | undefined): string {
  const palavras = (nome ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
  const primeira = palavras[0];
  if (!primeira) return '#';
  const segunda = palavras[1];
  const letras = segunda ? [Array.from(primeira)[0], Array.from(segunda)[0]] : Array.from(primeira).slice(0, 2);
  return letras.join('').toUpperCase();
}

const UM_DIA = 24 * 60 * 60 * 1000;

function partesDaData(data: Date, fuso: string) {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(data);
  const valor = (tipo: string) => partes.find((parte) => parte.type === tipo)?.value ?? '';
  return { dia: valor('day'), mes: valor('month'), ano: valor('year'), hora: valor('hour'), minuto: valor('minute') };
}

/** Quantos dias atrás (0 = hoje, 1 = ontem...), contando pelo calendário de quem atende. */
function diasAtras(data: Date, agora: Date, fuso: string): number {
  return Math.round((inicioDoDia(agora, fuso).getTime() - inicioDoDia(data, fuso).getTime()) / UM_DIA);
}

/** Relógio da mensagem: "14:05". */
export function horaDaMensagem(iso: string, fuso: string = FUSO_PADRAO): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  const { hora, minuto } = partesDaData(data, fuso);
  return `${hora}:${minuto}`;
}

/** Hora curta da lista de conversas: "14:05" hoje, "ontem", ou "09/11" (com o ano, se for de outro ano). */
export function quandoNaLista(iso: string | null | undefined, agora: Date, fuso: string = FUSO_PADRAO): string {
  if (!iso) return '';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  const dias = diasAtras(data, agora, fuso);
  const partes = partesDaData(data, fuso);
  if (dias <= 0) return `${partes.hora}:${partes.minuto}`;
  if (dias === 1) return 'ontem';
  const anoAtual = partesDaData(agora, fuso).ano;
  return partes.ano === anoAtual ? `${partes.dia}/${partes.mes}` : `${partes.dia}/${partes.mes}/${partes.ano}`;
}

/** Título do dia dentro da conversa: "Hoje", "Ontem" ou "9 de novembro de 2026". */
export function diaDaConversa(iso: string, agora: Date, fuso: string = FUSO_PADRAO): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  const dias = diasAtras(data, agora, fuso);
  if (dias <= 0) return 'Hoje';
  if (dias === 1) return 'Ontem';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: 'numeric', month: 'long', year: 'numeric' }).format(data);
}

/** Data por extenso curta, para o cartão do contato: "9 de nov. de 2026". */
export function dataCurta(iso: string | null | undefined, fuso: string = FUSO_PADRAO): string {
  if (!iso) return '';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: 'numeric', month: 'short', year: 'numeric' }).format(data);
}

/**
 * Situação de uma mensagem enviada, do jeito que a tela mostra:
 *   enviando        — saiu do painel agora há pouco e a resposta ainda não voltou;
 *   enviada         — confirmada;
 *   falhou          — com certeza não saiu;
 *   sem_confirmacao — não dá para saber se saiu: a pessoa confere no WhatsApp e decide.
 */
export type SituacaoDoEnvio = 'enviando' | 'enviada' | 'falhou' | 'sem_confirmacao';

/** Depois deste tempo "enviando", o painel assume que a resposta se perdeu e pede a conferência da pessoa. */
export const TEMPO_MAXIMO_ENVIANDO = 60_000;

export function situacaoDoEnvio(status: string, criadaEm: string, agora: Date): SituacaoDoEnvio {
  if (status === 'failed' || status === 'cancelled') return 'falhou';
  if (status === 'awaiting_human_confirmation') return 'sem_confirmacao';
  if (status === 'sending' || status === 'queued') {
    const idade = agora.getTime() - new Date(criadaEm).getTime();
    return Number.isFinite(idade) && idade < TEMPO_MAXIMO_ENVIANDO ? 'enviando' : 'sem_confirmacao';
  }
  return 'enviada';
}

/** Quem escreveu uma mensagem que saiu do nosso lado. */
export function autorDoEnvio(mensagem: { autor: string; doPainel: boolean; minha: boolean }): string {
  if (mensagem.autor === 'ai') return 'IA';
  if (mensagem.autor === 'human') {
    if (mensagem.minha) return 'Você';
    return mensagem.doPainel ? 'Equipe' : 'Pelo celular';
  }
  return 'Sistema';
}

export const TEXTO_MAXIMO = 4096;

/** Texto pronto para enviar, ou `null` quando está vazio ou grande demais. */
export function validarTexto(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo.length >= 1 && limpo.length <= TEXTO_MAXIMO ? limpo : null;
}

const CHAVE_DE_ENVIO = /^[a-zA-Z0-9_-]{16,80}$/;

/** A "chave do envio" é criada no navegador, uma por mensagem: repetir o pedido com a mesma chave nunca envia duas vezes. */
export function ehChaveDeEnvio(valor: unknown): valor is string {
  return typeof valor === 'string' && CHAVE_DE_ENVIO.test(valor);
}

/** "5585999990000@s.whatsapp.net" → "5585999990000" (só dígitos, como a Evolution espera). `null` se não for um número de pessoa. */
export function numeroParaEnvio(destinatario: unknown): string | null {
  if (typeof destinatario !== 'string') return null;
  const encontrado = /^([1-9][0-9]{7,14})@s\.whatsapp\.net$/.exec(destinatario.trim());
  return encontrado ? encontrado[1]! : null;
}
