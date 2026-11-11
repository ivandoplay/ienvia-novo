import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { criarBanco, type BancoDeTeste } from './helpers/banco';

const aqui = path.dirname(fileURLToPath(import.meta.url));

interface Retrato {
  categorias: Record<string, { itens: number; md5: string }>;
}

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await criarBanco();
});

afterAll(async () => {
  await banco.fechar();
});

describe('esquema do banco', () => {
  test('as migrações do Git montam exatamente o mesmo banco que está no Supabase real', async () => {
    const sql = await fs.readFile(path.join(aqui, 'impressao-digital.sql'), 'utf8');
    const remoto = JSON.parse(await fs.readFile(path.join(aqui, 'impressao-digital.remoto.json'), 'utf8')) as Retrato;

    const resultado = await banco.db.query<{ categoria: string; itens: number; md5: string }>(sql);
    const local = Object.fromEntries(resultado.rows.map((linha) => [linha.categoria, { itens: linha.itens, md5: linha.md5 }]));

    // Se falhar: ou alguém editou uma migração já aplicada, ou o banco real mudou por fora do Git.
    expect(local).toEqual(remoto.categorias);
  });

  test('toda tabela tem a trava de linhas (RLS) ligada', async () => {
    const semTrava = await banco.db.query<{ tabela: string }>(`
      select n.nspname || '.' || c.relname as tabela
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      order by 1
    `);
    expect(semTrava.rows.map((linha) => linha.tabela)).toEqual([]);
  });

  test('visitante sem login não tem permissão em nenhuma tabela nem função', async () => {
    const tabelas = await banco.db.query<{ item: string }>(`
      select table_schema || '.' || table_name || ':' || privilege_type as item
      from information_schema.role_table_grants
      where table_schema in ('public', 'private') and grantee in ('anon', 'PUBLIC')
      order by 1
    `);
    expect(tabelas.rows.map((linha) => linha.item)).toEqual([]);

    // Funções de gatilho ficam de fora: o Postgres não deixa ninguém chamá-las diretamente.
    const funcoes = await banco.db.query<{ item: string }>(`
      select n.nspname || '.' || p.proname as item
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and p.prorettype <> 'trigger'::regtype
        and has_function_privilege('anon', p.oid, 'execute')
      order by 1
    `);
    expect(funcoes.rows.map((linha) => linha.item)).toEqual([]);
  });

  test('as tabelas internas (schema private) não são acessíveis a usuários logados', async () => {
    const liberadas = await banco.db.query<{ item: string }>(`
      select table_name || ':' || privilege_type as item
      from information_schema.role_table_grants
      where table_schema = 'private' and grantee = 'authenticated'
      order by 1
    `);
    expect(liberadas.rows.map((linha) => linha.item)).toEqual([]);
  });

  test('funções com poder elevado têm o caminho de busca travado', async () => {
    // Uma função "security definer" sem search_path fixo pode ser enganada por objetos de mesmo nome.
    const frouxas = await banco.db.query<{ funcao: string }>(`
      select n.nspname || '.' || p.proname as funcao
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as c(valor) where c.valor like 'search_path=%')
      order by 1
    `);
    expect(frouxas.rows.map((linha) => linha.funcao)).toEqual([]);
  });
});
