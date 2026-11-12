/**
 * A IA nas telas do painel: o resumo da empresa (topo, Visão geral e Instâncias) e a faixa que aparece
 * em cada conversa da Inbox, dizendo o que a IA está fazendo ali e quais botões cabem.
 * Código puro (sem banco nem rede): as telas, as ações do servidor e os testes usam o mesmo.
 */
import { lerRecado, type RecadoDaIa } from '@/lib/atendente/regras';
import { plural } from '@/lib/formato';
import { FUSO_PADRAO, inicioDoDia } from '@/lib/tempo';

type Json = Record<string, unknown>;
const objeto = (valor: unknown): Json => (valor && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Json) : {});
const texto = (valor: unknown): string | null => (typeof valor === 'string' && valor ? valor : null);
const numero = (valor: unknown): number => (typeof valor === 'number' && Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : 0);

/** O que falta para a IA poder ser ligada num chip. */
export type FaltaParaAIa = 'chave' | 'treinamento';

/** Como está a IA da empresa. */
export interface ResumoDaIa {
  /** Alguém apertou "Pausar tudo": a IA não responde em chip nenhum. */
  pausada: boolean;
  /** Qualquer pessoa da empresa pausa; só o dono retoma. */
  podeRetomar: boolean;
  /** Só o dono liga e desliga a IA em cada chip. */
  podeLigarNosChips: boolean;
  falta: FaltaParaAIa | null;
  /** Chips com a IA ligada (conectados ou não). */
  chipsComIa: number;
  /** Chips com a IA ligada e conectados: são os que respondem de verdade. */
  chipsRespondendo: number;
}

/** Lê o que o banco devolve em read_my_ai_overview. Tolera campos faltando (sempre para o lado mais seguro). */
export function lerResumoDaIa(resposta: unknown): ResumoDaIa {
  const dados = objeto(resposta);
  return {
    pausada: dados.paused === true,
    podeRetomar: dados.can_resume === true,
    podeLigarNosChips: dados.can_switch_chips === true,
    falta: dados.missing === 'ai_key_missing' ? 'chave' : dados.missing === 'ai_training_missing' ? 'treinamento' : null,
    chipsComIa: numero(dados.chips_enabled),
    chipsRespondendo: numero(dados.chips_answering),
  };
}

export interface SituacaoDaIa {
  /** "Pausada", "Ligada" ou "Desligada". */
  rotulo: string;
  detalhe: string;
  /** A IA está respondendo em pelo menos um chip agora. */
  respondendo: boolean;
}

/** A situação da IA da empresa em poucas palavras (cartão da Visão geral). */
export function situacaoDaIa(resumo: ResumoDaIa): SituacaoDaIa {
  if (resumo.pausada) return { rotulo: 'Pausada', detalhe: 'em todos os chips', respondendo: false };
  if (resumo.chipsComIa === 0) return { rotulo: 'Desligada', detalhe: 'atendimento automático', respondendo: false };
  if (resumo.chipsRespondendo === 0) return { rotulo: 'Ligada', detalhe: 'nenhum chip conectado', respondendo: false };
  return {
    rotulo: 'Ligada',
    detalhe:
      resumo.chipsRespondendo === resumo.chipsComIa
        ? `em ${plural(resumo.chipsRespondendo, 'chip', 'chips')}`
        : `em ${resumo.chipsRespondendo} de ${plural(resumo.chipsComIa, 'chip', 'chips')}`,
    respondendo: true,
  };
}

/** O que dizer a quem tenta ligar a IA num chip sem o mínimo para ela responder. */
export function explicarFalta(falta: FaltaParaAIa): string {
  return falta === 'chave'
    ? 'Antes de ligar a IA, cadastre a chave do provedor principal na aba Motor de IA.'
    : 'Antes de ligar a IA, preencha a aba Treinamento: é de lá que a IA tira o que responder.';
}

/** Traduz a recusa do banco ao ligar ou desligar a IA num chip. `null` = erro que não era esperado. */
export function explicarRecusaDoChip(mensagem: string | undefined): string | null {
  const recebida = mensagem ?? '';
  if (/ai_key_missing/.test(recebida)) return explicarFalta('chave');
  if (/ai_training_missing/.test(recebida)) return explicarFalta('treinamento');
  if (/instance_unavailable/.test(recebida)) return 'A IA ainda não responde por chips do motor local. Por enquanto, só pelos chips da nuvem (Evolution).';
  if (/Instance not found/.test(recebida)) return 'Este chip não existe mais. Atualize a página.';
  if (/Workspace owner required/.test(recebida)) return 'Só o dono da conta liga e desliga a IA nos chips.';
  return null;
}

/** Por que a IA parou numa conversa (coluna conversations.ai_pause_reason). */
export type MotivoDaPausa = 'handoff' | 'silent_handoff' | 'uncertain_send' | 'error' | 'safety' | 'human_reply' | 'claimed' | 'closed' | 'opt_out';
const MOTIVOS: readonly string[] = ['handoff', 'silent_handoff', 'uncertain_send', 'error', 'safety', 'human_reply', 'claimed', 'closed', 'opt_out'];

/** Como a IA está numa conversa (o que read_my_conversation devolve em conversation.ai). */
export interface IaDaConversa {
  ligadaNoChip: boolean;
  pausadaNaEmpresa: boolean;
  /** A IA só volta nesta conversa quando alguém devolver. */
  travada: boolean;
  /** Até quando a IA fica parada nesta conversa (depois volta sozinha). Só vem quando ainda não passou. */
  pausadaAte: string | null;
  motivo: MotivoDaPausa | null;
  /** O recado que a IA deixou ao passar a conversa, e quando. */
  recado: RecadoDaIa | null;
  recadoEm: string | null;
  /** A IA está esperando o cliente terminar de escrever, ou escrevendo a resposta. */
  trabalhando: boolean;
}

export const IA_FORA_DA_CONVERSA: IaDaConversa = {
  ligadaNoChip: false,
  pausadaNaEmpresa: false,
  travada: false,
  pausadaAte: null,
  motivo: null,
  recado: null,
  recadoEm: null,
  trabalhando: false,
};

export function lerIaDaConversa(valor: unknown): IaDaConversa {
  const dados = objeto(valor);
  const motivo = texto(dados.pause_reason);
  return {
    ligadaNoChip: dados.chip_enabled === true,
    pausadaNaEmpresa: dados.workspace_paused === true,
    travada: dados.locked === true,
    pausadaAte: texto(dados.paused_until),
    motivo: motivo && MOTIVOS.includes(motivo) ? (motivo as MotivoDaPausa) : null,
    recado: lerRecado(texto(dados.handoff_note)),
    recadoEm: texto(dados.handoff_at),
    trabalhando: dados.working === true,
  };
}

/** "às 14:35" (hoje), "amanhã às 09:10" ou "em 14/11 às 09:10". */
export function quandoVolta(iso: string, agora: Date, fuso: string = FUSO_PADRAO): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  const partes = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(data);
  const valor = (tipo: string) => partes.find((parte) => parte.type === tipo)?.value ?? '';
  const hora = `${valor('hour')}:${valor('minute')}`;
  const dias = Math.round((inicioDoDia(data, fuso).getTime() - inicioDoDia(agora, fuso).getTime()) / 86_400_000);
  if (dias <= 0) return `às ${hora}`;
  if (dias === 1) return `amanhã às ${hora}`;
  return `em ${valor('day')}/${valor('month')} às ${hora}`;
}

/** A faixa da IA no alto de uma conversa aberta. */
export interface FaixaDaIa {
  /** ia = a IA está cuidando; atencao = ela precisa de uma pessoa; neutro = só uma informação. */
  tom: 'ia' | 'atencao' | 'neutro';
  titulo: string;
  /** Uma frase a mais, quando ajuda (até quando fica parada, o que acontece ao devolver). */
  detalhe: string | null;
  /** O recado da IA para quem vai assumir. */
  recado: RecadoDaIa | null;
  /** Mostrar "Assumir" (a IA para de responder nesta conversa até alguém devolver). */
  podeAssumir: boolean;
  /** Mostrar "Devolver para a IA". */
  podeDevolver: boolean;
}

const TITULO_DO_REPASSE: Partial<Record<MotivoDaPausa, string>> = {
  handoff: 'A IA passou esta conversa para você',
  silent_handoff: 'A IA não respondeu esta conversa e chamou você',
  uncertain_send: 'Não deu para confirmar se a resposta da IA chegou',
  error: 'A IA não conseguiu responder',
  safety: 'A IA parou por segurança',
};

/**
 * O que mostrar sobre a IA numa conversa aberta. `null` = nada (a IA não tem nada a ver com esta conversa:
 * desligada no chip e sem recado nenhum).
 */
export function descreverIaNaConversa(ia: IaDaConversa, etapa: string, agora: Date, fuso: string = FUSO_PADRAO): FaixaDaIa | null {
  const encerrada = etapa === 'resolved' || etapa === 'archived';
  const volta = ia.pausadaAte ? quandoVolta(ia.pausadaAte, agora, fuso) : '';

  if (encerrada) {
    if (ia.motivo === 'closed') {
      return { tom: 'neutro', titulo: 'A IA se despediu e encerrou esta conversa', detalhe: 'O contato recusou. Se ele escrever de novo, nasce uma conversa nova.', recado: ia.recado, podeAssumir: false, podeDevolver: false };
    }
    if (ia.motivo === 'opt_out') {
      return {
        tom: 'neutro',
        titulo: 'O contato pediu para parar, e a IA encerrou esta conversa',
        detalhe: 'Ficou registrado que ele não quer receber mensagens comerciais.',
        recado: ia.recado,
        podeAssumir: false,
        podeDevolver: false,
      };
    }
    return null;
  }

  const repasse = ia.motivo ? TITULO_DO_REPASSE[ia.motivo] : undefined;
  const parada = ia.travada || ia.pausadaAte !== null;

  // A IA deixou a conversa com uma pessoa. Vale enquanto ninguém respondeu (a conversa segue esperando) ou
  // enquanto a IA está parada ali; e aparece mesmo que depois a IA tenha sido desligada no chip.
  if (repasse && (etapa === 'waiting_human' || parada)) {
    const quandoRetoma = !ia.ligadaNoChip
      ? null
      : ia.pausadaNaEmpresa
        ? 'A IA está pausada em todos os chips.'
        : ia.travada
          ? 'A IA só volta a responder aqui quando você devolver a conversa.'
          : ia.pausadaAte
            ? `A IA volta a responder aqui ${volta}, ou antes, se você devolver a conversa.`
            : 'A IA volta a responder aqui na próxima mensagem do contato.';
    return {
      tom: 'atencao',
      titulo: repasse,
      detalhe: quandoRetoma,
      recado: ia.recado,
      // Sem pausa nenhuma não há o que devolver; aí o que cabe é assumir, para a IA não voltar.
      podeAssumir: ia.ligadaNoChip && !parada,
      podeDevolver: ia.ligadaNoChip && parada,
    };
  }

  if (!ia.ligadaNoChip) return null;

  if (ia.pausadaNaEmpresa) {
    return { tom: 'neutro', titulo: 'A IA está pausada em todos os chips', detalhe: 'Enquanto a pausa durar, as mensagens desta conversa ficam para a equipe.', recado: null, podeAssumir: false, podeDevolver: false };
  }

  if (ia.travada) {
    return {
      tom: 'neutro',
      titulo: ia.motivo === 'claimed' ? 'Esta conversa foi assumida por uma pessoa' : 'A IA não responde nesta conversa',
      detalhe: 'Ela só volta quando alguém devolver a conversa.',
      recado: null,
      podeAssumir: false,
      podeDevolver: true,
    };
  }
  if (ia.pausadaAte) {
    return {
      tom: 'neutro',
      titulo: ia.motivo === 'human_reply' ? 'Uma pessoa respondeu, e a IA parou nesta conversa' : 'A IA está parada nesta conversa',
      detalhe: `Ela volta a responder aqui ${volta}, ou antes, se você devolver a conversa.`,
      recado: null,
      podeAssumir: true,
      podeDevolver: true,
    };
  }

  if (etapa !== 'ai') {
    // A última palavra ali foi de uma pessoa (ou ninguém respondeu ainda): a IA entra na próxima mensagem do contato.
    return {
      tom: 'neutro',
      titulo: 'A IA responde esta conversa a partir da próxima mensagem do contato',
      detalhe: 'Para ela não responder aqui, use Assumir.',
      recado: null,
      podeAssumir: true,
      podeDevolver: false,
    };
  }
  return {
    tom: 'ia',
    titulo: ia.trabalhando ? 'A IA está respondendo agora' : 'A IA responde esta conversa',
    detalhe: ia.trabalhando ? null : 'Se você responder, ela para aqui por um tempo. Para tirar a conversa dela de vez, use Assumir.',
    recado: null,
    podeAssumir: true,
    podeDevolver: false,
  };
}
