/** Ensinar a IA pela conversa ("corrigir resposta em 1 clique"): o que a janela sugere, o que cabe e o que ela diz depois. */
import { describe, expect, test } from 'vitest';
import {
  LIMITES_DO_ENSINO,
  conferirEnsino,
  descreverEnsino,
  ehDestinoDoEnsino,
  explicarRecusaDoEnsino,
  lerResultadoDoEnsino,
  mensagensQueEnsinam,
  sugerirEnsino,
} from '@/lib/ia/ensino';

type Mensagem = { id: string; recebida: boolean; texto: string; autor: string | null; situacao: string | null };

const cliente = (id: string, texto: string): Mensagem => ({ id, recebida: true, texto, autor: null, situacao: null });
const ia = (id: string, texto: string, situacao = 'enviada'): Mensagem => ({ id, recebida: false, texto, autor: 'IA', situacao });
const pessoa = (id: string, texto: string, situacao = 'enviada', autor = 'Você'): Mensagem => ({ id, recebida: false, texto, autor, situacao });

/** Uma conversa parecida com as de verdade: o cliente escreve em dois balões, a IA responde em dois, depois uma pessoa assume. */
const CONVERSA: Mensagem[] = [
  cliente('c1', 'Oi, boa tarde!'),
  cliente('c2', 'Vocês entregam no centro?'),
  ia('i1', 'Oi! Boa tarde! 😊'),
  ia('i2', 'Entregamos sim, a taxa é R$ 7,00.'),
  cliente('c3', 'E aceitam cartão na entrega?'),
  pessoa('p1', 'Aceitamos crédito e débito.'),
  pessoa('p2', 'Posso anotar o seu pedido?'),
];

describe('onde aparece o botão de ensinar', () => {
  test('na resposta da IA, só no último balão; na de uma pessoa, em cada balão', () => {
    expect([...mensagensQueEnsinam(CONVERSA)]).toEqual(['i2', 'p1', 'p2']);
  });

  test('mensagem do cliente, sem texto, que falhou ou que ficou sem confirmação não tem o botão', () => {
    const conversa: Mensagem[] = [
      cliente('c1', 'Tem estoque?'),
      pessoa('p1', '', 'enviada'),
      pessoa('p2', '   \n', 'enviada'),
      pessoa('p3', 'Tenho sim.', 'falhou'),
      pessoa('p4', 'Tenho sim.', 'sem_confirmacao'),
      pessoa('p5', 'Tenho sim.', 'enviando'),
      pessoa('p6', 'Tenho sim!', 'enviada'),
    ];
    expect([...mensagensQueEnsinam(conversa)]).toEqual(['p6']);
  });

  test('se o último balão da IA não foi enviado, o botão fica no último que foi', () => {
    const conversa: Mensagem[] = [cliente('c1', 'Abre domingo?'), ia('i1', 'Abrimos!'), ia('i2', 'Das 9h às 13h.', 'sem_confirmacao')];
    expect([...mensagensQueEnsinam(conversa)]).toEqual(['i1']);
  });

  test('duas respostas da IA separadas por uma mensagem do cliente têm um botão cada', () => {
    const conversa: Mensagem[] = [cliente('c1', 'Oi'), ia('i1', 'Olá!'), cliente('c2', 'Tem pix?'), ia('i2', 'Temos.'), ia('i3', 'A chave é o CNPJ.')];
    expect([...mensagensQueEnsinam(conversa)]).toEqual(['i1', 'i3']);
  });

  test('conversa vazia não quebra', () => {
    expect(mensagensQueEnsinam([]).size).toBe(0);
  });
});

describe('o que a janela já traz preenchido', () => {
  test('resposta da IA: vem a resposta inteira (os balões juntos) e a última pergunta do cliente antes dela', () => {
    const esperado = { pergunta: 'Vocês entregam no centro?', resposta: 'Oi! Boa tarde! 😊\nEntregamos sim, a taxa é R$ 7,00.', daIa: true };
    // Tanto faz em qual balão da resposta a pessoa clicou.
    expect(sugerirEnsino(CONVERSA, 'i2')).toEqual(esperado);
    expect(sugerirEnsino(CONVERSA, 'i1')).toEqual(esperado);
  });

  test('resposta de uma pessoa: vem só o balão clicado, com a última pergunta do cliente antes dele', () => {
    expect(sugerirEnsino(CONVERSA, 'p1')).toEqual({ pergunta: 'E aceitam cartão na entrega?', resposta: 'Aceitamos crédito e débito.', daIa: false });
    expect(sugerirEnsino(CONVERSA, 'p2')).toEqual({ pergunta: 'E aceitam cartão na entrega?', resposta: 'Posso anotar o seu pedido?', daIa: false });
  });

  test('pula o que não tem texto (foto, áudio) ao procurar a pergunta e ao juntar a resposta', () => {
    const conversa: Mensagem[] = [cliente('c1', '  Qual o preço da pizza grande?  '), cliente('c2', ''), ia('i1', ''), ia('i2', ' Custa R$ 59,90. '), ia('i3', 'Quer pedir?')];
    expect(sugerirEnsino(conversa, 'i3')).toEqual({ pergunta: 'Qual o preço da pizza grande?', resposta: 'Custa R$ 59,90.\nQuer pedir?', daIa: true });
  });

  test('sem pergunta antes (a conversa começou do nosso lado), a pergunta vem vazia para a pessoa escrever', () => {
    expect(sugerirEnsino([pessoa('p1', 'Olá! Chegou a coleção nova.')], 'p1')).toEqual({ pergunta: '', resposta: 'Olá! Chegou a coleção nova.', daIa: false });
  });

  test('mensagem do cliente ou que não está na conversa não abre a janela', () => {
    expect(sugerirEnsino(CONVERSA, 'c2')).toBeNull();
    expect(sugerirEnsino(CONVERSA, 'nao-existe')).toBeNull();
    expect(sugerirEnsino([], 'i1')).toBeNull();
  });
});

describe('conferir antes de guardar', () => {
  test('pergunta frequente: guarda os dois textos sem os espaços das pontas', () => {
    expect(conferirEnsino({ destino: 'faq', pergunta: '  Entregam?\n', resposta: '\tSim, na cidade toda. ' })).toEqual({
      ok: true,
      ensino: { destino: 'faq', pergunta: 'Entregam?', resposta: 'Sim, na cidade toda.' },
    });
  });

  test('pergunta frequente: os dois campos são obrigatórios e têm limite (o mesmo do banco)', () => {
    expect(conferirEnsino({ destino: 'faq', pergunta: '  ', resposta: 'Sim.' })).toMatchObject({ ok: false, campo: 'pergunta' });
    expect(conferirEnsino({ destino: 'faq', pergunta: 'Entregam?', resposta: '' })).toMatchObject({ ok: false, campo: 'resposta' });
    expect(conferirEnsino({ destino: 'faq', pergunta: 'p'.repeat(LIMITES_DO_ENSINO.pergunta + 1), resposta: 'Sim.' })).toMatchObject({ ok: false, campo: 'pergunta' });
    expect(conferirEnsino({ destino: 'faq', pergunta: 'Entregam?', resposta: 'r'.repeat(LIMITES_DO_ENSINO.resposta + 1) })).toMatchObject({ ok: false, campo: 'resposta' });
    // No limite exato, passa. Emoji conta como um caractere, como no banco.
    expect(conferirEnsino({ destino: 'faq', pergunta: '😀'.repeat(LIMITES_DO_ENSINO.pergunta), resposta: 'r'.repeat(LIMITES_DO_ENSINO.resposta) })).toMatchObject({ ok: true });
    expect(LIMITES_DO_ENSINO).toEqual({ pergunta: 500, resposta: 2000, regra: 1000 });
  });

  test('regra de ouro: só a regra importa (a pergunta é descartada) e ela cabe em 1.000 caracteres', () => {
    expect(conferirEnsino({ destino: 'rule', pergunta: 'qualquer coisa', resposta: ' Nunca prometa prazo. ' })).toEqual({
      ok: true,
      ensino: { destino: 'rule', pergunta: '', resposta: 'Nunca prometa prazo.' },
    });
    expect(conferirEnsino({ destino: 'rule', pergunta: '', resposta: ' \n ' })).toMatchObject({ ok: false, campo: 'resposta' });
    const comprida = conferirEnsino({ destino: 'rule', pergunta: '', resposta: 'r'.repeat(1001) });
    expect(comprida).toMatchObject({ ok: false, campo: 'resposta' });
    expect(comprida.ok ? '' : comprida.erro).toContain('1.001');
    expect(conferirEnsino({ destino: 'rule', pergunta: '', resposta: 'r'.repeat(1000) })).toMatchObject({ ok: true });
  });

  test('destino desconhecido e formulário estranho são recusados', () => {
    for (const entrada of [null, undefined, 'texto', 7, [], {}, { destino: 'documento', pergunta: 'a', resposta: 'b' }, { destino: null, pergunta: 'a', resposta: 'b' }]) {
      expect(conferirEnsino(entrada), JSON.stringify(entrada)).toMatchObject({ ok: false, campo: 'destino' });
    }
    // Campos que não são texto contam como vazios.
    expect(conferirEnsino({ destino: 'faq', pergunta: 7, resposta: 'Sim.' })).toMatchObject({ ok: false, campo: 'pergunta' });
    expect(conferirEnsino({ destino: 'faq', pergunta: 'Entregam?', resposta: { texto: 'Sim.' } })).toMatchObject({ ok: false, campo: 'resposta' });
    expect(ehDestinoDoEnsino('faq')).toBe(true);
    expect(ehDestinoDoEnsino('rule')).toBe(true);
    expect(ehDestinoDoEnsino('FAQ')).toBe(false);
  });
});

describe('o que o banco respondeu', () => {
  test('lê o resultado e conta o que aconteceu, com o nome da base', () => {
    const entrou = lerResultadoDoEnsino({ agent_id: 'a1', agent_label: 'Principal', target: 'faq', result: 'added', revision: 2 });
    expect(entrou).toEqual({ destino: 'faq', desfecho: 'added', base: 'Principal' });
    expect(descreverEnsino(entrou!)).toBe('Guardado nas perguntas frequentes da base “Principal”. A IA já usa na próxima resposta.');

    const trocou = lerResultadoDoEnsino({ agent_label: 'Suporte', target: 'faq', result: 'replaced' });
    expect(descreverEnsino(trocou!)).toBe('Essa pergunta já existia na base “Suporte”: a resposta foi trocada. A IA já usa na próxima resposta.');

    const regra = lerResultadoDoEnsino({ agent_label: 'Principal', target: 'rule', result: 'added' });
    expect(descreverEnsino(regra!)).toBe('Regra guardada nas regras de ouro da base “Principal”. A IA já segue na próxima resposta.');

    const repetida = lerResultadoDoEnsino({ agent_label: 'Principal', target: 'rule', result: 'unchanged' });
    expect(descreverEnsino(repetida!)).toBe('Essa regra já estava nas regras de ouro da base “Principal”. Nada mudou.');
  });

  test('base sem nome não quebra a frase; resposta que não dá para entender vira nulo', () => {
    expect(lerResultadoDoEnsino({ target: 'faq', result: 'added' })).toEqual({ destino: 'faq', desfecho: 'added', base: 'Sem nome' });
    expect(lerResultadoDoEnsino({ agent_label: '   ', target: 'faq', result: 'added' })?.base).toBe('Sem nome');
    for (const estranho of [null, undefined, 'ok', 7, [], {}, { target: 'faq' }, { target: 'faq', result: 'talvez' }, { target: 'documento', result: 'added' }]) {
      expect(lerResultadoDoEnsino(estranho), JSON.stringify(estranho)).toBeNull();
    }
  });

  test('cada recusa do banco tem a sua frase; o que ninguém previu não é adivinhado', () => {
    expect(explicarRecusaDoEnsino({ code: '42501', message: 'Workspace owner required' })).toBe('Só o dono da conta altera o treinamento.');
    const nomes = ['faq_limit_reached', 'rules_limit_reached', 'ai_training_missing', 'Message not found', 'Invalid question', 'Invalid answer'];
    const frases = nomes.map((message) => explicarRecusaDoEnsino({ code: 'P0001', message }));
    for (const frase of frases) expect(frase).toBeTruthy();
    expect(new Set(frases).size).toBe(nomes.length);
    expect(explicarRecusaDoEnsino({ code: 'XX000', message: 'deu ruim' })).toBeNull();
    expect(explicarRecusaDoEnsino({})).toBeNull();
  });
});
