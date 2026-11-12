/**
 * O cofre das chaves de IA: o que vai para o banco não revela a chave, só abre com o segredo do
 * servidor e só no lugar para onde foi cifrado.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { cifrar, contextoDaChaveDeIa, decifrar, finalDaChave, lerChaveDoCofre } from '@/lib/ia/cofre';
import { SEGREDO_DO_COFRE_DE_TESTE, cifrarComoOPainel } from '../e2e/apoio/ia-no-banco-falso.mjs';

const SEGREDO = randomBytes(32);
const CONTEXTO = contextoDaChaveDeIa('11111111-1111-4111-8111-111111111111', 'gemini');
const CHAVE_DO_CLIENTE = 'AIzaSyD-exemplo_de_chave_0123456789abcdEFG';
/** O formato que o banco aceita (o mesmo da migração). */
const FORMATO_ACEITO_PELO_BANCO = /^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22}[.][A-Za-z0-9_-]+$/;

describe('cofre das chaves de IA', () => {
  test('cifrar e decifrar devolve a chave original', () => {
    const cifra = cifrar(CHAVE_DO_CLIENTE, CONTEXTO, SEGREDO);
    expect(decifrar(cifra, CONTEXTO, SEGREDO)).toBe(CHAVE_DO_CLIENTE);
    expect(decifrar(cifrar('chave com acento: ção ✓', CONTEXTO, SEGREDO), CONTEXTO, SEGREDO)).toBe('chave com acento: ção ✓');
  });

  test('o texto cifrado tem o formato que o banco aceita e não contém a chave', () => {
    const cifra = cifrar(CHAVE_DO_CLIENTE, CONTEXTO, SEGREDO);
    expect(cifra).toMatch(FORMATO_ACEITO_PELO_BANCO);
    expect(cifra.length).toBeGreaterThanOrEqual(50);
    expect(cifra.length).toBeLessThanOrEqual(1600);
    expect(cifra).not.toContain(CHAVE_DO_CLIENTE);
    expect(cifra).not.toContain(CHAVE_DO_CLIENTE.slice(-8));
    // Até uma chave bem curta e uma bem comprida cabem no formato.
    expect(cifrar('k'.repeat(16), CONTEXTO, SEGREDO)).toMatch(FORMATO_ACEITO_PELO_BANCO);
    expect(cifrar('k'.repeat(400), CONTEXTO, SEGREDO).length).toBeLessThanOrEqual(1600);
  });

  test('cifrar a mesma chave duas vezes dá textos diferentes (não dá para comparar chaves pelo banco)', () => {
    expect(cifrar(CHAVE_DO_CLIENTE, CONTEXTO, SEGREDO)).not.toBe(cifrar(CHAVE_DO_CLIENTE, CONTEXTO, SEGREDO));
  });

  test('não abre com outro segredo, em outra empresa, em outro provedor, nem depois de alterado', () => {
    const cifra = cifrar(CHAVE_DO_CLIENTE, CONTEXTO, SEGREDO);
    expect(decifrar(cifra, CONTEXTO, randomBytes(32))).toBeNull();
    expect(decifrar(cifra, contextoDaChaveDeIa('22222222-2222-4222-8222-222222222222', 'gemini'), SEGREDO)).toBeNull();
    expect(decifrar(cifra, contextoDaChaveDeIa('11111111-1111-4111-8111-111111111111', 'openrouter'), SEGREDO)).toBeNull();

    const partes = cifra.split('.');
    const trocarUltima = (texto: string) => `${texto.slice(0, -1)}${texto.endsWith('A') ? 'B' : 'A'}`;
    expect(decifrar([partes[0], partes[1], partes[2], trocarUltima(partes[3]!)].join('.'), CONTEXTO, SEGREDO)).toBeNull();
    expect(decifrar([partes[0], trocarUltima(partes[1]!), partes[2], partes[3]].join('.'), CONTEXTO, SEGREDO)).toBeNull();
  });

  test('texto que não é do cofre devolve vazio, sem erro', () => {
    for (const valor of ['', 'AIzaSyChaveEmTextoPuro', 'v1.a.b.c', 'v2.aaaa.bbbb.cccc', 'v1...', 'so.tres.partes']) {
      expect(decifrar(valor, CONTEXTO, SEGREDO), valor).toBeNull();
    }
    expect(decifrar(null as unknown as string, CONTEXTO, SEGREDO)).toBeNull();
  });

  test('o segredo do cofre vale em hexadecimal ou em base64; qualquer outra coisa é como se não existisse', () => {
    expect(lerChaveDoCofre({ IENVIA_CHAVE_DOS_SEGREDOS: SEGREDO.toString('hex') })?.equals(SEGREDO)).toBe(true);
    expect(lerChaveDoCofre({ IENVIA_CHAVE_DOS_SEGREDOS: ` ${SEGREDO.toString('base64')} ` })?.equals(SEGREDO)).toBe(true);
    expect(lerChaveDoCofre({ IENVIA_CHAVE_DOS_SEGREDOS: SEGREDO.toString('base64url') })?.equals(SEGREDO)).toBe(true);
    for (const valor of [undefined, '', '   ', 'curta', 'a'.repeat(63), 'z'.repeat(64), randomBytes(16).toString('base64'), randomBytes(48).toString('base64')]) {
      expect(lerChaveDoCofre({ IENVIA_CHAVE_DOS_SEGREDOS: valor }), String(valor)).toBeNull();
    }
  });

  test('o final da chave mostrado na tela tem no máximo 4 caracteres simples', () => {
    expect(finalDaChave('AIzaSyD-exemplo_x9Zk')).toBe('x9Zk');
    expect(finalDaChave('  sk-or-v1-abcdef  ')).toBe('cdef');
    expect(finalDaChave('fim com ç@é!')).toBe('----');
    expect(finalDaChave('ab')).toBe('ab');
    expect(finalDaChave('chave=/+a')).toBe('a');
    expect(finalDaChave('')).toBe('----');
  });
});

describe('o cenário de exemplo dos testes de navegador', () => {
  test('o painel abre a chave que o banco de mentira já traz cadastrada', () => {
    const empresa = 'a0000000-0000-4000-8000-000000000004';
    const segredo = lerChaveDoCofre({ IENVIA_CHAVE_DOS_SEGREDOS: SEGREDO_DO_COFRE_DE_TESTE });
    expect(segredo).not.toBeNull();
    const cifra = cifrarComoOPainel(CHAVE_DO_CLIENTE, empresa, 'gemini', SEGREDO_DO_COFRE_DE_TESTE);
    expect(cifra).toMatch(FORMATO_ACEITO_PELO_BANCO);
    expect(decifrar(cifra, contextoDaChaveDeIa(empresa, 'gemini'), segredo!)).toBe(CHAVE_DO_CLIENTE);
    // Cifrada para um provedor, não abre como se fosse do outro.
    expect(decifrar(cifra, contextoDaChaveDeIa(empresa, 'openrouter'), segredo!)).toBeNull();
  });
});
