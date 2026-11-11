-- Impressão digital do esquema: um resumo (md5) por categoria de objeto.
-- Rode este mesmo SQL no banco remoto (SQL Editor do Supabase) e no banco de teste:
-- se os md5 baterem, o que está no Git é exatamente o que está no banco.
with
colunas as (
  select 'colunas' as categoria,
         table_schema || '.' || table_name || '.' || column_name || ':' || udt_name || ':' || is_nullable
           || ':' || coalesce(column_default, '') || ':' || coalesce(generation_expression, '') as item
  from information_schema.columns
  where table_schema in ('public', 'private')
),
restricoes as (
  select 'restricoes', conrelid::regclass::text || ':' || contype::text || ':' || pg_get_constraintdef(oid)
  from pg_constraint
  where connamespace in ('public'::regnamespace, 'private'::regnamespace) and conrelid <> 0 and contype <> 'n'
),
indices as (
  -- o Postgres escreve "extensions.gin_trgm_ops" ou só "gin_trgm_ops" conforme o search_path; é o mesmo índice
  select 'indices', schemaname || ':' || replace(indexdef, 'extensions.', '')
  from pg_indexes
  where schemaname in ('public', 'private')
),
politicas as (
  select 'politicas', schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',')
           || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
  from pg_policies
  where schemaname in ('public', 'private')
),
rls as (
  select 'rls_ligado', n.nspname || '.' || c.relname || ':' || c.relrowsecurity::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind = 'r'
),
funcoes as (
  select 'funcoes', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           || ':' || pg_get_function_result(p.oid) || ':' || p.prosecdef::text || ':' || p.provolatile::text
           || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || md5(p.prosrc)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
),
gatilhos as (
  select 'gatilhos', event_object_schema || '.' || event_object_table || ':' || trigger_name || ':' || action_timing
           || ':' || event_manipulation || ':' || action_statement
  from information_schema.triggers
  where trigger_schema in ('public', 'private')
),
permissoes_tabela as (
  select 'permissoes_tabela', table_schema || '.' || table_name || ':' || grantee || ':' || privilege_type
  from information_schema.role_table_grants
  where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
),
permissoes_coluna as (
  select 'permissoes_coluna', cp.table_schema || '.' || cp.table_name || '.' || cp.column_name || ':' || cp.grantee || ':' || cp.privilege_type
  from information_schema.column_privileges cp
  where cp.table_schema in ('public', 'private') and cp.grantee in ('anon', 'authenticated', 'PUBLIC')
    -- só interessa a permissão dada coluna a coluna (quando a tabela inteira não foi liberada)
    and not exists (
      select 1 from information_schema.role_table_grants tg
      where tg.table_schema = cp.table_schema and tg.table_name = cp.table_name
        and tg.grantee = cp.grantee and tg.privilege_type = cp.privilege_type
    )
),
permissoes_funcao as (
  select 'permissoes_funcao', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):'
           || papel.nome || ':' || has_function_privilege(papel.nome, p.oid, 'execute')::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated'), ('service_role')) as papel(nome)
  where n.nspname in ('public', 'private')
),
deposito as (
  -- o depósito de arquivos (Supabase Storage): os depósitos que existem, as regras de acesso e a trava de linhas
  select 'deposito', 'deposito:' || b.id || ':' || coalesce(b.public, false)::text || ':' || coalesce(b.file_size_limit::text, '')
           || ':' || coalesce(array_to_string(b.allowed_mime_types, ','), '')
  from storage.buckets b
  union all
  select 'deposito', 'politica:' || schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',')
           || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
  from pg_policies
  where schemaname = 'storage'
  union all
  select 'deposito', 'rls_ligado:storage.objects:' || c.relrowsecurity::text
  from pg_class c
  where c.oid = 'storage.objects'::regclass
),
tudo as (
  select * from colunas union all select * from restricoes union all select * from indices
  union all select * from politicas union all select * from rls union all select * from funcoes
  union all select * from gatilhos union all select * from permissoes_tabela
  union all select * from permissoes_coluna union all select * from permissoes_funcao
  union all select * from deposito
)
select categoria, count(*)::int as itens, md5(string_agg(item, E'\n' order by item collate "C")) as md5
from tudo
group by categoria
order by categoria;
