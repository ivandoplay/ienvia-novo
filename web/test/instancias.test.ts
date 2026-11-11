import { describe, expect, test } from 'vitest';
import {
  FUNCOES_DO_CHIP,
  descreverEstado,
  ehFuncaoDoChip,
  ehIdentificador,
  formatarCodigoDePareamento,
  formatarTelefone,
  gerarNomeNaEvolution,
  normalizarNumeroParaPareamento,
  rotuloDaFuncao,
  telefoneDoJid,
  validarApelido,
} from '@/lib/instancias/regras';

describe('função do chip', () => {
  test('são três: atendimento, campanhas ou os dois', () => {
    expect(FUNCOES_DO_CHIP.map((funcao) => funcao.valor)).toEqual(['attendance', 'campaigns', 'both']);
    expect(ehFuncaoDoChip('both')).toBe(true);
    expect(ehFuncaoDoChip('tudo')).toBe(false);
    expect(ehFuncaoDoChip(null)).toBe(false);
  });

  test('cada função tem um nome em português; valor desconhecido cai em "Atendimento"', () => {
    expect(rotuloDaFuncao('campaigns')).toBe('Campanhas');
    expect(rotuloDaFuncao('both')).toBe('Atendimento e campanhas');
    expect(rotuloDaFuncao('qualquer-coisa')).toBe('Atendimento');
  });
});

describe('estado do chip', () => {
  test.each([
    ['connected', 'Conectado', 'ok'],
    ['connecting', 'Aguardando conexão', 'atencao'],
    ['disconnected', 'Desconectado', 'neutro'],
    ['error', 'Com erro', 'erro'],
    ['paused', 'Pausado', 'atencao'],
    ['estado-novo-que-nao-conhecemos', 'Desconectado', 'neutro'],
  ])('%s aparece como "%s"', (estado, texto, tom) => {
    expect(descreverEstado(estado)).toEqual({ texto, tom });
  });
});

describe('apelido', () => {
  test('tira espaços sobrando e recusa vazio ou longo demais', () => {
    expect(validarApelido('  Loja   do Centro ')).toBe('Loja do Centro');
    expect(validarApelido('   ')).toBeNull();
    expect(validarApelido('x'.repeat(60))).toHaveLength(60);
    expect(validarApelido('x'.repeat(61))).toBeNull();
  });
});

describe('nome do chip na Evolution', () => {
  test('começa com "ienvia-" e com o começo do código da empresa, e é aceito pelo banco', () => {
    const nome = gerarNomeNaEvolution('9CEDADF2-ebf7-4ba9-8e5c-27a20c97ede6', 'A1b2C3d4e5f6-extra');
    expect(nome).toBe('ienvia-9cedadf2-a1b2c3d4e5f6');
    // Mesma regra da função create_my_evolution_instance.
    expect(nome).toMatch(/^[a-zA-Z0-9_-]{3,100}$/);
  });
});

describe('telefone', () => {
  test('tira o número do identificador do WhatsApp', () => {
    expect(telefoneDoJid('5585999990000@s.whatsapp.net')).toBe('+5585999990000');
    expect(telefoneDoJid('5585999990000:12@s.whatsapp.net')).toBe('+5585999990000');
  });

  test('grupo, lista de transmissão e vazio não viram telefone', () => {
    expect(telefoneDoJid('120363000000000000@g.us')).toBeNull();
    expect(telefoneDoJid('status@broadcast')).toBeNull();
    expect(telefoneDoJid(null)).toBeNull();
    expect(telefoneDoJid('')).toBeNull();
  });

  test('mostra número brasileiro com DDD; os de fora ficam como vieram', () => {
    expect(formatarTelefone('+5585999990000')).toBe('+55 (85) 99999-0000');
    expect(formatarTelefone('+558633334444')).toBe('+55 (86) 3333-4444');
    expect(formatarTelefone('+14155550100')).toBe('+14155550100');
    expect(formatarTelefone(null)).toBe('');
  });
});

describe('conectar por código', () => {
  test('aceita o número do jeito que a pessoa digita e põe o código do Brasil quando falta', () => {
    expect(normalizarNumeroParaPareamento('(85) 99999-0000')).toBe('5585999990000');
    expect(normalizarNumeroParaPareamento('085 99999 0000')).toBe('5585999990000');
    expect(normalizarNumeroParaPareamento('86 3333-4444')).toBe('558633334444');
    expect(normalizarNumeroParaPareamento('+55 85 99999-0000')).toBe('5585999990000');
    expect(normalizarNumeroParaPareamento('14155550100')).toBe('5514155550100');
    expect(normalizarNumeroParaPareamento('+1 415 555 0100 22')).toBe('1415555010022');
  });

  test('recusa o que não é um número de telefone', () => {
    expect(normalizarNumeroParaPareamento('')).toBeNull();
    expect(normalizarNumeroParaPareamento('99999-0000')).toBeNull();
    expect(normalizarNumeroParaPareamento('meu número')).toBeNull();
    expect(normalizarNumeroParaPareamento('1'.repeat(16))).toBeNull();
  });

  test('mostra o código em dois blocos de quatro, como no WhatsApp', () => {
    expect(formatarCodigoDePareamento('abcd1234')).toBe('ABCD-1234');
    expect(formatarCodigoDePareamento('ABCD-1234')).toBe('ABCD-1234');
    expect(formatarCodigoDePareamento('XYZ')).toBe('XYZ');
  });
});

describe('identificador', () => {
  test('só aceita o formato de identificador do banco', () => {
    expect(ehIdentificador('9cedadf2-ebf7-4ba9-8e5c-27a20c97ede6')).toBe(true);
    expect(ehIdentificador("1' or '1'='1")).toBe(false);
    expect(ehIdentificador(undefined)).toBe(false);
  });
});
