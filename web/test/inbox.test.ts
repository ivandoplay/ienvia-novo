import { describe, expect, test } from 'vitest';
import { ETAPAS_DO_FUNIL, somarEtapas } from '@/lib/dados/visao-geral';
import {
  CONVERSAS_POR_PAGINA,
  MENSAGENS_POR_VEZ,
  autorDoEnvio,
  descreverEtapa,
  diaDaConversa,
  ehChaveDeEnvio,
  enderecoDaInbox,
  horaDaMensagem,
  iniciaisDoContato,
  lerBusca,
  lerLimite,
  lerLimiteDeMensagens,
  lerVisao,
  nomeDoContato,
  numeroParaEnvio,
  proximoLimite,
  proximoLimiteDeMensagens,
  quandoNaLista,
  situacaoDoEnvio,
  validarTexto,
  variacoesDeTelefone,
  visaoNoBanco,
} from '@/lib/inbox/regras';

// 11/11/2026, 15:30 em Fortaleza (UTC-3).
const AGORA = new Date('2026-11-11T18:30:00.000Z');

describe('filtros da lista', () => {
  test('filtro desconhecido ou ausente vira "ativas"', () => {
    expect(lerVisao('nao-lidas')).toBe('nao-lidas');
    expect(lerVisao('qualquer')).toBe('ativas');
    expect(lerVisao(undefined)).toBe('ativas');
  });

  test('cada filtro tem o nome que o banco entende', () => {
    expect(['ativas', 'nao-lidas', 'esperando', 'resolvidas'].map((visao) => visaoNoBanco(lerVisao(visao)))).toEqual([
      'open',
      'unread',
      'waiting',
      'resolved',
    ]);
  });

  test('limite da lista: padrão, mínimo, máximo e "ver mais"', () => {
    expect(lerLimite(undefined)).toBe(CONVERSAS_POR_PAGINA);
    expect(lerLimite('5')).toBe(5);
    expect(lerLimite('0')).toBe(1);
    expect(lerLimite('9999')).toBe(200);
    expect(lerLimite('-3')).toBe(CONVERSAS_POR_PAGINA);
    expect(lerLimite('40; drop table')).toBe(CONVERSAS_POR_PAGINA);
    expect(proximoLimite(40)).toBe(80);
    expect(proximoLimite(180)).toBe(200);
    expect(proximoLimite(200)).toBeNull();
  });

  test('limite de mensagens: padrão, máximo e "ver anteriores"', () => {
    expect(lerLimiteDeMensagens(undefined)).toBe(MENSAGENS_POR_VEZ);
    expect(lerLimiteDeMensagens('400')).toBe(400);
    expect(lerLimiteDeMensagens('5000')).toBe(1000);
    expect(proximoLimiteDeMensagens(200)).toBe(400);
    expect(proximoLimiteDeMensagens(1000)).toBeNull();
  });

  test('busca é limpa e cortada no tamanho máximo', () => {
    expect(lerBusca('  maria   silva ')).toBe('maria silva');
    expect(lerBusca('   ')).toBeNull();
    expect(lerBusca(undefined)).toBeNull();
    expect(lerBusca('x'.repeat(200))).toHaveLength(80);
  });
});

describe('busca por telefone', () => {
  test.each([
    ['(85) 98888-7777', ['85988887777', '8588887777']],
    ['85 8888-7777', ['8588887777', '85988887777']],
    ['+55 85 98888-7777', ['5585988887777', '558588887777']],
    ['558588887777', ['558588887777', '5585988887777']],
    ['98888-7777', ['988887777', '88887777']],
    ['8888-7777', ['88887777']],
    ['085 98888-7777', ['85988887777', '8588887777']],
    ['7777', ['7777']],
  ])('"%s" procura por %j', (digitado, esperado) => {
    expect(variacoesDeTelefone(digitado)).toEqual(esperado);
  });

  test.each(['maria', 'pedido 12345', '777', '', 'rua 10'])('"%s" não é tratado como telefone', (digitado) => {
    expect(variacoesDeTelefone(digitado)).toEqual([]);
  });
});

describe('endereço da Inbox', () => {
  const CONVERSA = 'f0000000-0000-4000-8000-000000000001';
  const CHIP = 'd0000000-0000-4000-8000-000000000001';

  test('sem nada fora do padrão, é só /inbox', () => {
    expect(enderecoDaInbox({})).toBe('/inbox');
    expect(enderecoDaInbox({ visao: 'ativas', chipId: null, busca: null, limite: CONVERSAS_POR_PAGINA, conversaId: null })).toBe('/inbox');
  });

  test('guarda filtro, chip, busca, limite e conversa aberta', () => {
    expect(enderecoDaInbox({ visao: 'nao-lidas', chipId: CHIP, busca: 'maria & cia', limite: 80, conversaId: CONVERSA })).toBe(
      `/inbox?ver=nao-lidas&chip=${CHIP}&busca=maria+%26+cia&limite=80&c=${CONVERSA}`,
    );
  });

  test('a quantidade de mensagens só entra com uma conversa aberta e fora do padrão', () => {
    expect(enderecoDaInbox({ conversaId: CONVERSA, mensagens: 400 })).toBe(`/inbox?c=${CONVERSA}&m=400`);
    expect(enderecoDaInbox({ conversaId: CONVERSA, mensagens: MENSAGENS_POR_VEZ })).toBe(`/inbox?c=${CONVERSA}`);
    expect(enderecoDaInbox({ conversaId: null, mensagens: 400 })).toBe('/inbox');
  });
});

describe('contato', () => {
  test('nome para mostrar: o nome; sem nome, o telefone; sem os dois, um texto neutro', () => {
    expect(nomeDoContato('Maria Silva', '+5585999990000')).toBe('Maria Silva');
    expect(nomeDoContato('  ', '+5585999990000')).toBe('+55 (85) 99999-0000');
    expect(nomeDoContato('', null)).toBe('Contato sem nome');
  });

  test.each([
    ['Maria Silva', 'MS'],
    ['maria', 'MA'],
    ['🌸 Ana Paula 🌸', 'AP'],
    ['João das Neves Filho', 'JD'],
    ['Érica', 'ÉR'],
    ['🙂', '#'],
    ['', '#'],
    [null, '#'],
    ['~ 85 Pizzas', '8P'],
  ])('iniciais de %j são %s', (nome, esperado) => {
    expect(iniciaisDoContato(nome)).toBe(esperado);
  });
});

describe('horas e dias (sempre no fuso da operação)', () => {
  test('relógio da mensagem', () => {
    expect(horaDaMensagem('2026-11-11T18:05:00.000Z')).toBe('15:05');
    expect(horaDaMensagem('2026-11-12T02:59:00.000Z')).toBe('23:59');
    expect(horaDaMensagem('isto não é data')).toBe('');
  });

  test('lista: hora se for de hoje, "ontem", depois a data', () => {
    expect(quandoNaLista('2026-11-11T12:00:00.000Z', AGORA)).toBe('09:00');
    // 00:30 de hoje em Fortaleza (ainda é dia 11 lá, embora seja 03:30 UTC).
    expect(quandoNaLista('2026-11-11T03:30:00.000Z', AGORA)).toBe('00:30');
    // 23:30 de ontem em Fortaleza.
    expect(quandoNaLista('2026-11-11T02:30:00.000Z', AGORA)).toBe('ontem');
    expect(quandoNaLista('2026-11-09T15:00:00.000Z', AGORA)).toBe('09/11');
    expect(quandoNaLista('2025-12-31T15:00:00.000Z', AGORA)).toBe('31/12/2025');
    expect(quandoNaLista(null, AGORA)).toBe('');
  });

  test('separador de dias da conversa', () => {
    expect(diaDaConversa('2026-11-11T12:00:00.000Z', AGORA)).toBe('Hoje');
    expect(diaDaConversa('2026-11-11T02:30:00.000Z', AGORA)).toBe('Ontem');
    expect(diaDaConversa('2026-11-09T15:00:00.000Z', AGORA)).toBe('9 de novembro de 2026');
  });
});

describe('situação de uma mensagem enviada', () => {
  const haPouco = new Date(AGORA.getTime() - 5_000).toISOString();
  const haDoisMinutos = new Date(AGORA.getTime() - 120_000).toISOString();

  test.each([
    ['sent', haPouco, 'enviada'],
    ['delivered', haPouco, 'enviada'],
    ['read', haPouco, 'enviada'],
    ['failed', haPouco, 'falhou'],
    ['awaiting_human_confirmation', haPouco, 'sem_confirmacao'],
    ['sending', haPouco, 'enviando'],
    // "Enviando" há mais de um minuto: a resposta se perdeu; a pessoa confere e decide.
    ['sending', haDoisMinutos, 'sem_confirmacao'],
    ['sending', 'data inválida', 'sem_confirmacao'],
  ])('%s (criada em %s) aparece como %s', (status, criadaEm, esperado) => {
    expect(situacaoDoEnvio(status, criadaEm, AGORA)).toBe(esperado);
  });

  test('quem escreveu a resposta', () => {
    expect(autorDoEnvio({ autor: 'human', doPainel: true, minha: true })).toBe('Você');
    expect(autorDoEnvio({ autor: 'human', doPainel: true, minha: false })).toBe('Equipe');
    expect(autorDoEnvio({ autor: 'human', doPainel: false, minha: false })).toBe('Pelo celular');
    expect(autorDoEnvio({ autor: 'ai', doPainel: false, minha: false })).toBe('IA');
    expect(autorDoEnvio({ autor: 'system', doPainel: false, minha: false })).toBe('Sistema');
  });
});

describe('o que pode ser enviado', () => {
  test('texto: sem espaços nas pontas, de 1 a 4.096 letras', () => {
    expect(validarTexto('  Olá!\nTudo bem?  ')).toBe('Olá!\nTudo bem?');
    expect(validarTexto('   ')).toBeNull();
    expect(validarTexto('x'.repeat(4096))).toHaveLength(4096);
    expect(validarTexto('x'.repeat(4097))).toBeNull();
    expect(validarTexto(42)).toBeNull();
  });

  test('chave do envio', () => {
    expect(ehChaveDeEnvio('6f1c2a44-9d0e-4b7a-8c11-2f3e4d5c6b7a')).toBe(true);
    expect(ehChaveDeEnvio('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(ehChaveDeEnvio('curta')).toBe(false);
    expect(ehChaveDeEnvio('com espaço no meio 123456')).toBe(false);
    expect(ehChaveDeEnvio(undefined)).toBe(false);
  });

  test('número para a Evolution: só dígitos', () => {
    expect(numeroParaEnvio('5585999990000@s.whatsapp.net')).toBe('5585999990000');
    expect(numeroParaEnvio('558599990000@s.whatsapp.net')).toBe('558599990000');
    expect(numeroParaEnvio('120363000000000000@g.us')).toBeNull();
    expect(numeroParaEnvio('123456789012345@lid')).toBeNull();
    expect(numeroParaEnvio('5585999990000')).toBeNull();
    expect(numeroParaEnvio(null)).toBeNull();
  });
});

describe('etapas', () => {
  test('toda etapa do banco tem um nome em português', () => {
    const nomes = ['new', 'ai', 'waiting_human', 'human', 'waiting_customer', 'resolved', 'archived'].map((etapa) => descreverEtapa(etapa).texto);
    expect(nomes).toEqual(['Nova', 'Com a IA', 'Esperando você', 'Com você', 'Aguardando o cliente', 'Resolvida', 'Arquivada']);
    expect(descreverEtapa('etapa-do-futuro').texto).toBe('Em andamento');
  });

  test('"Esperando você" da Visão geral soma novas, passadas pela IA e em atendimento', () => {
    const indice = (etapa: string) => ETAPAS_DO_FUNIL.findIndex((item) => item.etapa === etapa);
    const funil: Array<number | null> = [4, 7, 3, 2, 1, 5];
    expect(somarEtapas(funil, ['new', 'waiting_human', 'human'])).toBe(9);
    // Se uma das contagens falhou, o total não é inventado.
    funil[indice('human')] = null;
    expect(somarEtapas(funil, ['new', 'waiting_human', 'human'])).toBeNull();
    expect(somarEtapas(funil, ['new'])).toBe(4);
  });
});
