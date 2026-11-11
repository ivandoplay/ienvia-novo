import { beforeAll, describe, expect, test } from 'vitest';
import type { BancoDeTeste } from './helpers/banco';
import {
  ATENDENTE_A,
  DONA_A,
  DONO_B,
  INTRUSO,
  LOJA_A,
  LOJA_B,
  MASTER,
  SUSPENSO_A,
  TABELAS_DA_EMPRESA,
  bancoComCenario,
} from './helpers/cenario';

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await bancoComCenario();
});

/** Quais empresas aparecem para quem está perguntando, em cada tabela. */
async function empresasVisiveis(tabela: string): Promise<string[]> {
  const resultado = await banco.db.query<{ workspace_id: string }>(
    `select distinct workspace_id::text as workspace_id from public.${tabela} order by 1`,
  );
  return resultado.rows.map((linha) => linha.workspace_id);
}

describe('uma empresa nunca enxerga os dados da outra', () => {
  for (const tabela of TABELAS_DA_EMPRESA) {
    test(`${tabela}: a dona da Loja A só vê a Loja A`, async () => {
      expect(await banco.comoUsuario(DONA_A, () => empresasVisiveis(tabela))).toEqual([LOJA_A]);
    });

    test(`${tabela}: o dono da Loja B só vê a Loja B`, async () => {
      expect(await banco.comoUsuario(DONO_B, () => empresasVisiveis(tabela))).toEqual([LOJA_B]);
    });

    test(`${tabela}: a atendente da Loja A vê a Loja A`, async () => {
      expect(await banco.comoUsuario(ATENDENTE_A, () => empresasVisiveis(tabela))).toEqual([LOJA_A]);
    });

    test(`${tabela}: quem não participa de nenhuma empresa não vê nada`, async () => {
      expect(await banco.comoUsuario(INTRUSO, () => empresasVisiveis(tabela))).toEqual([]);
    });

    test(`${tabela}: funcionário suspenso perde o acesso na hora`, async () => {
      expect(await banco.comoUsuario(SUSPENSO_A, () => empresasVisiveis(tabela))).toEqual([]);
    });

    test(`${tabela}: o administrador da plataforma não lê conversas e dados dos clientes`, async () => {
      expect(await banco.comoUsuario(MASTER, () => empresasVisiveis(tabela))).toEqual([]);
    });

    test(`${tabela}: visitante sem login é barrado`, async () => {
      const erro = await banco.comoAnonimo(() => banco.esperarErro(() => empresasVisiveis(tabela)));
      expect(erro).toMatch(/permission denied/);
    });
  }

  test('a lista de empresas só mostra aquelas de que a pessoa participa', async () => {
    const nomes = async () => (await banco.db.query<{ name: string }>('select name from public.workspaces order by 1')).rows.map((l) => l.name);
    expect(await banco.comoUsuario(DONA_A, nomes)).toEqual(['Loja A']);
    expect(await banco.comoUsuario(DONO_B, nomes)).toEqual(['Loja B']);
    expect(await banco.comoUsuario(INTRUSO, nomes)).toEqual([]);
  });

  test('a dona vê a equipe da própria empresa; a atendente vê só a si mesma', async () => {
    const equipe = async () =>
      (await banco.db.query<{ user_id: string }>('select user_id::text as user_id from public.workspace_memberships order by 1')).rows.map((l) => l.user_id);
    expect(await banco.comoUsuario(DONA_A, equipe)).toEqual([DONA_A, ATENDENTE_A, SUSPENSO_A].sort());
    expect(await banco.comoUsuario(ATENDENTE_A, equipe)).toEqual([ATENDENTE_A]);
    expect(await banco.comoUsuario(DONO_B, equipe)).toEqual([DONO_B]);
  });

  test('as contagens da Visão geral respeitam a empresa', async () => {
    const contar = async () => {
      const r = await banco.db.query<{ conversas: number; mensagens: number; rodando: number }>(`
        select
          (select count(*)::int from public.conversations where stage = 'waiting_human') as conversas,
          (select count(*)::int from public.messages where direction = 'inbound') as mensagens,
          (select count(*)::int from public.campaigns where status = 'running') as rodando
      `);
      return r.rows[0];
    };
    expect(await banco.comoUsuario(DONA_A, contar)).toEqual({ conversas: 1, mensagens: 1, rodando: 1 });
    expect(await banco.comoUsuario(DONO_B, contar)).toEqual({ conversas: 0, mensagens: 1, rodando: 0 });
  });
});
