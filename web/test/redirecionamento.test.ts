import { describe, expect, test } from 'vitest';
import { DESTINO_PADRAO, destinoSeguro } from '@/lib/redirecionamento';

describe('destinoSeguro (para onde ir depois do login)', () => {
  test('aceita caminhos internos do painel', () => {
    expect(destinoSeguro('/inbox')).toBe('/inbox');
    expect(destinoSeguro('/inbox/conversa/1?aba=ficha')).toBe('/inbox/conversa/1?aba=ficha');
    expect(destinoSeguro('  /campanhas ')).toBe('/campanhas');
  });

  test.each([
    ['endereço completo de outro site', 'https://malvado.example.com/roubo'],
    ['endereço sem protocolo', '//malvado.example.com'],
    ['barra invertida (alguns navegadores tratam como //)', '/\\malvado.example.com'],
    ['protocolo escondido no caminho', '/ir?para=http://malvado.example.com'],
    ['javascript', 'javascript:alert(1)'],
    ['caminho relativo', 'inbox'],
    ['quebra de linha', '/inbox\nSet-Cookie: x=1'],
    ['vazio', ''],
    ['a própria tela de login', '/login'],
    ['login com parâmetros', '/login?voltar=/inbox'],
    ['a raiz', '/'],
    ['rota de API', '/api/qualquer'],
  ])('recusa %s', (_descricao, valor) => {
    expect(destinoSeguro(valor)).toBe(DESTINO_PADRAO);
  });

  test('recusa o que não é texto', () => {
    expect(destinoSeguro(undefined)).toBe(DESTINO_PADRAO);
    expect(destinoSeguro(null)).toBe(DESTINO_PADRAO);
    expect(destinoSeguro(['/inbox'])).toBe(DESTINO_PADRAO);
    expect(destinoSeguro(42)).toBe(DESTINO_PADRAO);
  });

  test('recusa caminhos exageradamente longos', () => {
    expect(destinoSeguro(`/${'a'.repeat(300)}`)).toBe(DESTINO_PADRAO);
  });
});
