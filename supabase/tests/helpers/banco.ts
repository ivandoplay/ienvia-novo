/**
 * Banco de teste em memória (PGlite = Postgres de verdade rodando dentro do Node).
 *
 * Imita o mínimo do ambiente Supabase que as migrações esperam:
 * papéis (anon, authenticated, service_role), o schema `auth` com `auth.users`
 * e `auth.uid()`, e os privilégios padrão que o Supabase concede no schema public.
 *
 * Não substitui um teste no Supabase real, mas pega a grande maioria dos erros
 * de SQL, de RLS e de permissão antes de qualquer coisa chegar ao banco remoto.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const aqui = path.dirname(fileURLToPath(import.meta.url));
export const PASTA_MIGRACOES = path.resolve(aqui, '..', '..', 'migrations');

const AMBIENTE_SUPABASE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text
  );
  create or replace function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
  $$;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    )
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
  grant select on auth.users to service_role;

  -- Privilégios padrão iguais aos de um projeto Supabase novo: tudo que nasce em
  -- public já vem liberado para os três papéis. Por isso as migrações precisam
  -- revogar explicitamente — e os testes conseguem flagrar quando esquecem.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export async function listarMigracoes(): Promise<string[]> {
  const arquivos = await fs.readdir(PASTA_MIGRACOES);
  return arquivos.filter((nome) => nome.endsWith('.sql')).sort();
}

export interface BancoDeTeste {
  db: PGlite;
  /** Executa `fn` como um usuário logado (papel authenticated + auth.uid()). Sempre desfaz no final. */
  comoUsuario<T>(usuarioId: string, fn: () => Promise<T>): Promise<T>;
  /** Executa `fn` como o servidor (service_role, ignora RLS). Sempre desfaz no final. */
  comoServico<T>(fn: () => Promise<T>): Promise<T>;
  /** Executa `fn` como visitante sem login (papel anon). Sempre desfaz no final. */
  comoAnonimo<T>(fn: () => Promise<T>): Promise<T>;
  /** Garante que `fn` falha (permissão negada, RLS, constraint...). Devolve a mensagem do erro. */
  esperarErro(fn: () => Promise<unknown>): Promise<string>;
  fechar(): Promise<void>;
}

export async function criarBanco(opcoes: { ate?: string } = {}): Promise<BancoDeTeste> {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(AMBIENTE_SUPABASE);

  for (const arquivo of await listarMigracoes()) {
    if (opcoes.ate && arquivo > opcoes.ate) break;
    const sql = await fs.readFile(path.join(PASTA_MIGRACOES, arquivo), 'utf8');
    try {
      await db.exec(sql);
    } catch (erro) {
      await db.exec('rollback').catch(() => undefined);
      throw new Error(`Migração ${arquivo} falhou: ${(erro as Error).message}`);
    }
  }

  async function emTransacao<T>(preparar: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
    await db.exec('begin');
    try {
      await preparar();
      return await fn();
    } finally {
      await db.exec('rollback');
    }
  }

  return {
    db,
    comoUsuario: (usuarioId, fn) =>
      emTransacao(async () => {
        await db.exec('set local role authenticated');
        await db.query("select set_config('request.jwt.claim.sub', $1, true)", [usuarioId]);
        await db.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
      }, fn),
    comoServico: (fn) =>
      emTransacao(async () => {
        await db.exec('set local role service_role');
        await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
      }, fn),
    comoAnonimo: (fn) =>
      emTransacao(async () => {
        await db.exec('set local role anon');
        await db.query("select set_config('request.jwt.claim.role', 'anon', true)");
      }, fn),
    async esperarErro(fn) {
      await db.exec('savepoint esperar_erro');
      try {
        await fn();
      } catch (erro) {
        await db.exec('rollback to savepoint esperar_erro');
        await db.exec('release savepoint esperar_erro');
        return (erro as Error).message;
      }
      await db.exec('release savepoint esperar_erro');
      throw new Error('Era esperado um erro, mas a operação foi aceita.');
    },
    fechar: () => db.close(),
  };
}
