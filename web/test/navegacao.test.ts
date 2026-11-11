import { describe, expect, test } from 'vitest';
import { FASES } from '@/lib/fases';
import {
  ATALHOS_CELULAR,
  buscarItemPorRota,
  listarItensDoMenu,
  menuParaUsuario,
  rotaEstaAtiva,
} from '@/lib/navegacao';

const itens = listarItensDoMenu();
const rotas = itens.map((item) => item.rota);

describe('menu do painel', () => {
  test('tem as 13 abas do sistema, sem rota repetida', () => {
    expect(rotas).toHaveLength(13);
    expect(new Set(rotas).size).toBe(rotas.length);
  });

  test('toda rota é um endereço simples de um nível (ex.: /inbox)', () => {
    for (const rota of rotas) expect(rota).toMatch(/^\/[a-z][a-z-]*$/);
  });

  test('nenhuma aba usa um endereço reservado', () => {
    for (const reservada of ['/login', '/api', '/_next']) expect(rotas).not.toContain(reservada);
  });

  test('toda aba tem nome, descrição e uma fase que existe no plano', () => {
    for (const item of itens) {
      expect(item.rotulo.trim()).not.toBe('');
      expect(item.descricao.trim().length).toBeGreaterThan(20);
      expect(FASES[item.fase], `fase da aba ${item.rota}`).toBeTypeOf('string');
    }
  });

  test('a Visão geral é a única aba da fase 0 (a que já funciona)', () => {
    expect(itens.filter((item) => item.fase === 0).map((item) => item.rota)).toEqual(['/visao-geral']);
  });
});

describe('menuParaUsuario', () => {
  const rotasDe = (ehMaster: boolean) =>
    menuParaUsuario(ehMaster).flatMap((grupo) => [...grupo.itens, ...grupo.secoes.flatMap((secao) => secao.itens)].map((item) => item.rota));

  test('cliente comum não vê "Clientes SaaS"', () => {
    expect(rotasDe(false)).not.toContain('/contas');
    expect(rotasDe(false)).toHaveLength(12);
  });

  test('administrador da plataforma vê tudo', () => {
    expect(rotasDe(true)).toEqual(rotas);
  });

  test('não deixa grupo nem seção vazios', () => {
    for (const grupo of menuParaUsuario(false)) {
      expect(grupo.itens.length + grupo.secoes.length).toBeGreaterThan(0);
      for (const secao of grupo.secoes) expect(secao.itens.length).toBeGreaterThan(0);
    }
  });
});

describe('buscarItemPorRota', () => {
  test('acha a aba pelo endereço', () => {
    expect(buscarItemPorRota('/inbox')?.rotulo).toBe('Inbox');
  });

  test('endereço desconhecido não devolve nada', () => {
    expect(buscarItemPorRota('/nao-existe')).toBeUndefined();
    expect(buscarItemPorRota('/login')).toBeUndefined();
  });

  test('"Histórico" não é mais uma aba: virou filtro da Inbox', () => {
    expect(buscarItemPorRota('/historico')).toBeUndefined();
  });
});

describe('rotaEstaAtiva', () => {
  test('a própria página e as subpáginas contam', () => {
    expect(rotaEstaAtiva('/inbox', '/inbox')).toBe(true);
    expect(rotaEstaAtiva('/inbox', '/inbox/conversa/123')).toBe(true);
  });

  test('um endereço que só começa parecido não conta', () => {
    expect(rotaEstaAtiva('/conta', '/contas')).toBe(false);
    expect(rotaEstaAtiva('/inbox', '/visao-geral')).toBe(false);
  });
});

describe('atalhos do celular', () => {
  test('são 4 (o quinto botão é o "Mais") e apontam para abas que existem', () => {
    expect(ATALHOS_CELULAR).toHaveLength(4);
    for (const atalho of ATALHOS_CELULAR) {
      expect(rotas).toContain(atalho.rota);
      expect(atalho.rotasDoGrupo).toContain(atalho.rota);
      for (const rota of atalho.rotasDoGrupo) expect(rotas).toContain(rota);
    }
  });

  test('uma aba acende no máximo um atalho', () => {
    const todas = ATALHOS_CELULAR.flatMap((atalho) => atalho.rotasDoGrupo);
    expect(new Set(todas).size).toBe(todas.length);
  });
});
