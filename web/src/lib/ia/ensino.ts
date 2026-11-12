/**
 * Ensinar a IA sem sair da conversa ("corrigir resposta em 1 clique").
 *
 * Na Inbox, o dono da conta pega uma resposta (da IA ou de uma pessoa) e guarda no Treinamento:
 * como pergunta frequente ("quando perguntarem isto, responda assim") ou como regra de ouro.
 * Vale para a base de treinamento que o chip daquela conversa usa.
 *
 * Aqui ficam só as regras puras: o que a janela sugere, o que cabe e como falar do resultado.
 * Quem grava é o banco (teach_my_ai_from_message), que confere tudo de novo.
 */
import { LIMITES_DO_TREINAMENTO, aparar, explicarErroDoTreinamento, letras } from './treinamento';

/** faq = pergunta frequente; rule = regra de ouro. São os nomes que o banco usa. */
export type DestinoDoEnsino = 'faq' | 'rule';

export const LIMITES_DO_ENSINO = {
  pergunta: LIMITES_DO_TREINAMENTO.pergunta,
  resposta: LIMITES_DO_TREINAMENTO.resposta,
  regra: LIMITES_DO_TREINAMENTO.regraEnsinada,
} as const;

export const ehDestinoDoEnsino = (valor: unknown): valor is DestinoDoEnsino => valor === 'faq' || valor === 'rule';

const milhar = (valor: number) => valor.toLocaleString('pt-BR');

/** O mínimo que a sugestão precisa saber de cada mensagem da conversa. */
export interface MensagemParaEnsino {
  id: string;
  /** `true` = veio do contato. */
  recebida: boolean;
  texto: string;
  /** Quem enviou, quando saiu do nosso lado ("IA", "Você", o nome de alguém da equipe...). */
  autor: string | null;
}

export interface SugestaoDeEnsino {
  pergunta: string;
  resposta: string;
  /** A resposta escolhida é da IA (a janela fala em "corrigir"); senão, é de uma pessoa ("ensinar"). */
  daIa: boolean;
}

const ehDaIa = (mensagem: MensagemParaEnsino) => !mensagem.recebida && mensagem.autor === 'IA';

/**
 * Em quais mensagens da conversa aparece o botão de ensinar.
 *
 *   - Só nas que saíram do nosso lado, com texto e que foram mesmo enviadas (uma que falhou ou ficou
 *     sem confirmação já tem os seus próprios botões).
 *   - A IA responde em vários balões seguidos: o botão vai só no último balão de cada resposta dela,
 *     porque a correção vale para a resposta inteira.
 */
export function mensagensQueEnsinam(mensagens: readonly (MensagemParaEnsino & { situacao: string | null })[]): Set<string> {
  const serve = (mensagem: MensagemParaEnsino & { situacao: string | null }) =>
    !mensagem.recebida && mensagem.situacao === 'enviada' && aparar(mensagem.texto) !== '';
  const escolhidas = new Set<string>();
  mensagens.forEach((mensagem, indice) => {
    if (!serve(mensagem)) return;
    const proxima = mensagens[indice + 1];
    if (ehDaIa(mensagem) && proxima && ehDaIa(proxima) && serve(proxima)) return;
    escolhidas.add(mensagem.id);
  });
  return escolhidas;
}

/**
 * O que a janela já traz preenchido quando a pessoa clica numa resposta.
 *
 *   Resposta: a IA costuma responder em vários balões seguidos. Clicar em qualquer um deles traz a
 *             resposta inteira (os balões juntos, um por linha). De uma pessoa, vem só o balão clicado.
 *   Pergunta: a última mensagem com texto que o contato escreveu antes dessa resposta.
 *
 * É só uma sugestão: a pessoa ajusta os dois campos antes de guardar.
 */
export function sugerirEnsino(mensagens: readonly MensagemParaEnsino[], mensagemId: string): SugestaoDeEnsino | null {
  const indice = mensagens.findIndex((mensagem) => mensagem.id === mensagemId);
  const escolhida = mensagens[indice];
  if (!escolhida || escolhida.recebida) return null;

  const daIa = ehDaIa(escolhida);
  let primeiro = indice;
  let ultimo = indice;
  if (daIa) {
    while (primeiro > 0 && ehDaIa(mensagens[primeiro - 1]!)) primeiro -= 1;
    while (ultimo < mensagens.length - 1 && ehDaIa(mensagens[ultimo + 1]!)) ultimo += 1;
  }
  const resposta = mensagens
    .slice(primeiro, ultimo + 1)
    .map((mensagem) => aparar(mensagem.texto))
    .filter(Boolean)
    .join('\n');

  let pergunta = '';
  for (let posicao = primeiro - 1; posicao >= 0; posicao -= 1) {
    const anterior = mensagens[posicao]!;
    if (anterior.recebida && aparar(anterior.texto)) {
      pergunta = aparar(anterior.texto);
      break;
    }
  }

  return { pergunta, resposta, daIa };
}

export interface EnsinoConferido {
  destino: DestinoDoEnsino;
  /** Só para pergunta frequente; numa regra, vai vazio. */
  pergunta: string;
  resposta: string;
}

export type ConferenciaDoEnsino = { ok: true; ensino: EnsinoConferido } | { ok: false; erro: string; campo: 'destino' | 'pergunta' | 'resposta' };

/** Confere o que veio da janela (nunca confie no navegador). Os limites são os mesmos do banco. */
export function conferirEnsino(entrada: unknown): ConferenciaDoEnsino {
  const dados = entrada && typeof entrada === 'object' ? (entrada as Record<string, unknown>) : {};
  if (!ehDestinoDoEnsino(dados.destino)) return { ok: false, erro: 'Escolha onde guardar: nas perguntas frequentes ou nas regras de ouro.', campo: 'destino' };
  const pergunta = typeof dados.pergunta === 'string' ? aparar(dados.pergunta) : '';
  const resposta = typeof dados.resposta === 'string' ? aparar(dados.resposta) : '';

  if (dados.destino === 'rule') {
    if (!resposta) return { ok: false, erro: 'Escreva a regra que a IA deve seguir.', campo: 'resposta' };
    if (letras(resposta) > LIMITES_DO_ENSINO.regra) {
      return {
        ok: false,
        erro: `A regra é comprida demais: tem ${milhar(letras(resposta))} caracteres e cabem ${milhar(LIMITES_DO_ENSINO.regra)}. Escreva só a regra, em uma ou duas frases.`,
        campo: 'resposta',
      };
    }
    return { ok: true, ensino: { destino: 'rule', pergunta: '', resposta } };
  }

  if (!pergunta) return { ok: false, erro: 'Escreva o que o cliente pergunta.', campo: 'pergunta' };
  if (letras(pergunta) > LIMITES_DO_ENSINO.pergunta) {
    return { ok: false, erro: `A pergunta é comprida demais: tem ${milhar(letras(pergunta))} caracteres e cabem ${milhar(LIMITES_DO_ENSINO.pergunta)}.`, campo: 'pergunta' };
  }
  if (!resposta) return { ok: false, erro: 'Escreva como a IA deve responder.', campo: 'resposta' };
  if (letras(resposta) > LIMITES_DO_ENSINO.resposta) {
    return { ok: false, erro: `A resposta é comprida demais: tem ${milhar(letras(resposta))} caracteres e cabem ${milhar(LIMITES_DO_ENSINO.resposta)}.`, campo: 'resposta' };
  }
  return { ok: true, ensino: { destino: 'faq', pergunta, resposta } };
}

/** added = entrou; replaced = a pergunta já existia e a resposta foi trocada; unchanged = a regra já estava lá. */
export type DesfechoDoEnsino = 'added' | 'replaced' | 'unchanged';

export interface ResultadoDoEnsino {
  destino: DestinoDoEnsino;
  desfecho: DesfechoDoEnsino;
  /** O nome da base de treinamento que aprendeu. */
  base: string;
}

/** Lê o que o banco devolve em teach_my_ai_from_message. `null` = resposta que não dá para entender. */
export function lerResultadoDoEnsino(resposta: unknown): ResultadoDoEnsino | null {
  const dados = resposta && typeof resposta === 'object' && !Array.isArray(resposta) ? (resposta as Record<string, unknown>) : null;
  if (!dados || !ehDestinoDoEnsino(dados.target)) return null;
  if (dados.result !== 'added' && dados.result !== 'replaced' && dados.result !== 'unchanged') return null;
  const base = typeof dados.agent_label === 'string' && dados.agent_label.trim() ? dados.agent_label.trim() : 'Sem nome';
  return { destino: dados.target, desfecho: dados.result, base };
}

/** A frase que aparece na conversa depois de guardar. */
export function descreverEnsino(resultado: ResultadoDoEnsino): string {
  const base = `base “${resultado.base}”`;
  if (resultado.destino === 'rule') {
    return resultado.desfecho === 'unchanged'
      ? `Essa regra já estava nas regras de ouro da ${base}. Nada mudou.`
      : `Regra guardada nas regras de ouro da ${base}. A IA já segue na próxima resposta.`;
  }
  return resultado.desfecho === 'replaced'
    ? `Essa pergunta já existia na ${base}: a resposta foi trocada. A IA já usa na próxima resposta.`
    : `Guardado nas perguntas frequentes da ${base}. A IA já usa na próxima resposta.`;
}

/** Traduz a recusa do banco. `null` = erro que ninguém previu (quem chama registra e mostra a mensagem geral). */
export function explicarRecusaDoEnsino(erro: { code?: string; message?: string }): string | null {
  if (erro.code === '42501') return 'Só o dono da conta altera o treinamento.';
  if (erro.message === 'Invalid question') return 'Escreva o que o cliente pergunta (até 500 caracteres).';
  if (erro.message === 'Invalid answer') return 'Confira o texto da resposta: está vazio ou comprido demais.';
  return explicarErroDoTreinamento(erro.message);
}
