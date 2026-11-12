begin;

-- Fase 2 (Atendente de IA), primeira parte:
--   o Motor de IA (provedores Gemini, OpenRouter e NVIDIA: ordem de uso, modelos, chaves e
--   comportamento) e o Treinamento (bases de treinamento, perguntas frequentes e arquivos de conhecimento).
-- A IA ainda não responde ninguém com esta migração: o atendimento automático vem na seguinte.

-- 1) Motor de IA: uma linha por empresa. Aqui NÃO fica segredo nenhum (as chaves ficam no item 2).
--    Três provedores: Google Gemini, OpenRouter e NVIDIA. A empresa escolhe a ordem de uso:
--    o principal, a primeira reserva e a segunda reserva (as reservas são opcionais e não se repetem).
create table public.workspace_ai_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  provider text not null default 'gemini' check (provider in ('gemini','openrouter','nvidia')),
  fallback_provider text not null default 'none'
    check (fallback_provider in ('gemini','openrouter','nvidia','none')),
  second_fallback_provider text not null default 'none'
    check (second_fallback_provider in ('gemini','openrouter','nvidia','none')),
  gemini_model text not null default 'gemini-3.5-flash-lite'
    check (gemini_model ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$'),
  openrouter_model text not null default 'deepseek/deepseek-chat'
    check (openrouter_model ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$'),
  nvidia_model text not null default 'nvidia/nemotron-3.5-super-vl-120b-a12b'
    check (nvidia_model ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$'),
  temperature numeric(3,2) not null default 0.35 check (temperature between 0 and 1),
  max_history_messages integer not null default 20 check (max_history_messages between 4 and 60),
  debounce_seconds integer not null default 6 check (debounce_seconds between 1 and 60),
  simulate_typing boolean not null default true,
  split_long_messages boolean not null default true,
  pause_on_human_reply boolean not null default true,
  human_pause_minutes integer not null default 60 check (human_pause_minutes between 5 and 1440),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  -- A ordem não repete provedor, e só existe segunda reserva quando existe a primeira.
  constraint workspace_ai_settings_order_ck check (
    fallback_provider <> provider
    and second_fallback_provider <> provider
    and (second_fallback_provider = 'none'
      or (fallback_provider <> 'none' and second_fallback_provider <> fallback_provider))
  )
);
alter table public.workspace_ai_settings enable row level security;
revoke all on public.workspace_ai_settings from anon, authenticated;
grant all on public.workspace_ai_settings to service_role;
create trigger workspace_ai_settings_touch_updated_at before update on public.workspace_ai_settings
  for each row execute function private.touch_updated_at();

-- 2) As chaves dos provedores de IA de cada empresa. O painel cifra a chave ANTES de mandar para o
--    banco (com um segredo que só o servidor do painel conhece); aqui fica só o texto cifrado e os
--    últimos caracteres, para a tela mostrar qual chave está cadastrada.
create table private.workspace_ai_secrets (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('gemini','openrouter','nvidia')),
  ciphertext text not null
    check (ciphertext ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22}[.][A-Za-z0-9_-]+$'
      and char_length(ciphertext) between 50 and 1600),
  key_hint text not null check (key_hint ~ '^[A-Za-z0-9._-]{1,8}$'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (workspace_id, provider)
);
alter table private.workspace_ai_secrets enable row level security;
revoke all on table private.workspace_ai_secrets from public, anon, authenticated;
grant all on table private.workspace_ai_secrets to service_role;

-- 3) Bases de treinamento. Cada empresa pode ter mais de uma (por exemplo, uma por chip);
--    exatamente uma é a padrão, usada por todo chip que não tem base própria.
create table public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 60),
  is_default boolean not null default false,
  business_name text not null default '' check (char_length(business_name) <= 120),
  niche text not null default '' check (char_length(niche) <= 120),
  assistant_name text not null default '' check (char_length(assistant_name) <= 60),
  tone text not null default 'consultivo'
    check (tone in ('consultivo','acolhedor','descontraido','profissional','formal')),
  solo_identity boolean not null default false,
  company_summary text not null default '' check (char_length(company_summary) <= 4000),
  commercial_terms text not null default '' check (char_length(commercial_terms) <= 4000),
  golden_rules text not null default '' check (char_length(golden_rules) <= 8000),
  extra_instructions text not null default '' check (char_length(extra_instructions) <= 4000),
  lock_until_manual_resume boolean not null default false,
  prompt_shield_enabled boolean not null default true,
  robot_question_policy text not null default 'handoff' check (robot_question_policy in ('handoff','disclose')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  unique (workspace_id, id)
);
create unique index ai_agents_single_default_uq on public.ai_agents(workspace_id) where is_default;
create unique index ai_agents_label_uq on public.ai_agents(workspace_id, lower(label));
alter table public.ai_agents enable row level security;
revoke all on public.ai_agents from anon, authenticated;
grant all on public.ai_agents to service_role;
create trigger ai_agents_touch_updated_at before update on public.ai_agents
  for each row execute function private.touch_updated_at();

create table public.ai_agent_faqs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  agent_id uuid not null,
  position integer not null default 0 check (position >= 0),
  question text not null check (char_length(question) between 1 and 500),
  answer text not null check (char_length(answer) between 1 and 2000),
  source text not null default 'manual' check (source in ('manual','correction','template')),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, agent_id) references public.ai_agents(workspace_id, id) on delete cascade
);
create index ai_agent_faqs_agent_idx on public.ai_agent_faqs(workspace_id, agent_id, position, id);
alter table public.ai_agent_faqs enable row level security;
revoke all on public.ai_agent_faqs from anon, authenticated;
grant all on public.ai_agent_faqs to service_role;

-- Arquivos de conhecimento: só texto (o painel confere o formato antes de mandar).
create table public.ai_agent_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  agent_id uuid not null,
  title text not null check (char_length(title) between 1 and 160),
  content text not null check (char_length(content) between 1 and 30000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  foreign key (workspace_id, agent_id) references public.ai_agents(workspace_id, id) on delete cascade
);
create index ai_agent_documents_agent_idx on public.ai_agent_documents(workspace_id, agent_id, created_at, id);
alter table public.ai_agent_documents enable row level security;
revoke all on public.ai_agent_documents from anon, authenticated;
grant all on public.ai_agent_documents to service_role;

-- 4) Qual base cada chip usa. Vazio = a base padrão da empresa.
alter table public.instances
  add column ai_agent_id uuid,
  add constraint instances_ai_agent_fk foreign key (workspace_id, ai_agent_id)
    references public.ai_agents(workspace_id, id) on delete set null (ai_agent_id);
create index instances_ai_agent_idx on public.instances(workspace_id, ai_agent_id) where ai_agent_id is not null;

-- Tira espaços, tabulações e quebras de linha das pontas de um texto digitado pela pessoa.
create or replace function private.trim_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(p_text, ' ' || chr(9) || chr(10) || chr(13))
$$;
revoke all on function private.trim_text(text) from public, anon, authenticated;

-- 5) Motor de IA: ler e gravar.

-- As configurações da empresa; quando ela ainda não gravou nada, os mesmos padrões da tabela.
create or replace function private.ai_settings_json(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object(
        'provider', s.provider, 'fallback_provider', s.fallback_provider,
        'second_fallback_provider', s.second_fallback_provider,
        'gemini_model', s.gemini_model, 'openrouter_model', s.openrouter_model, 'nvidia_model', s.nvidia_model,
        'temperature', s.temperature, 'max_history_messages', s.max_history_messages,
        'debounce_seconds', s.debounce_seconds, 'simulate_typing', s.simulate_typing,
        'split_long_messages', s.split_long_messages, 'pause_on_human_reply', s.pause_on_human_reply,
        'human_pause_minutes', s.human_pause_minutes, 'updated_at', s.updated_at)
     from public.workspace_ai_settings s where s.workspace_id = p_workspace_id),
    jsonb_build_object(
        'provider', 'gemini', 'fallback_provider', 'none',
        'second_fallback_provider', 'none',
        'gemini_model', 'gemini-3.5-flash-lite', 'openrouter_model', 'deepseek/deepseek-chat',
        'nvidia_model', 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        'temperature', 0.35, 'max_history_messages', 20,
        'debounce_seconds', 6, 'simulate_typing', true,
        'split_long_messages', true, 'pause_on_human_reply', true,
        'human_pause_minutes', 60, 'updated_at', null))
$$;
revoke all on function private.ai_settings_json(uuid) from public, anon, authenticated;

-- Qualquer pessoa ativa da empresa lê as configurações. Das chaves, só se sabe se existem;
-- os últimos caracteres aparecem apenas para o dono.
create or replace function public.read_my_ai_settings(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner boolean;
  v_keys jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_owner := private.is_workspace_owner(p_workspace_id);

  select coalesce(jsonb_object_agg(s.provider, jsonb_build_object(
      'configured', true,
      'hint', case when v_owner then s.key_hint end,
      'updated_at', s.updated_at)), '{}'::jsonb)
  into v_keys
  from private.workspace_ai_secrets s
  where s.workspace_id = p_workspace_id;

  return private.ai_settings_json(p_workspace_id) || jsonb_build_object('keys', v_keys, 'can_edit', v_owner);
end;
$$;

-- Só o dono grava. Pode mandar só o que mudou; nome de campo desconhecido é recusado.
create or replace function public.save_my_ai_settings(p_workspace_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_allowed constant text[] := array['provider','fallback_provider','second_fallback_provider',
    'gemini_model','openrouter_model','nvidia_model',
    'temperature','max_history_messages','debounce_seconds','simulate_typing','split_long_messages',
    'pause_on_human_reply','human_pause_minutes'];
  v_key text;
  v_new jsonb;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Invalid settings' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_settings) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Unknown setting: %', left(v_key, 60) using errcode = '22023';
    end if;
  end loop;

  v_new := (private.ai_settings_json(p_workspace_id) - 'updated_at') || p_settings;

  if jsonb_typeof(v_new -> 'provider') <> 'string'
    or (v_new ->> 'provider') not in ('gemini','openrouter','nvidia') then
    raise exception 'Invalid provider' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'fallback_provider') <> 'string'
    or (v_new ->> 'fallback_provider') not in ('gemini','openrouter','nvidia','none') then
    raise exception 'Invalid fallback_provider' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'second_fallback_provider') <> 'string'
    or (v_new ->> 'second_fallback_provider') not in ('gemini','openrouter','nvidia','none') then
    raise exception 'Invalid second_fallback_provider' using errcode = '22023';
  end if;
  -- A ordem não repete provedor, e só existe segunda reserva quando existe a primeira.
  if (v_new ->> 'fallback_provider') = (v_new ->> 'provider')
    or (v_new ->> 'second_fallback_provider') = (v_new ->> 'provider')
    or ((v_new ->> 'second_fallback_provider') <> 'none'
      and ((v_new ->> 'fallback_provider') = 'none'
        or (v_new ->> 'second_fallback_provider') = (v_new ->> 'fallback_provider'))) then
    raise exception 'Invalid provider order' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'gemini_model') <> 'string'
    or (v_new ->> 'gemini_model') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$' then
    raise exception 'Invalid gemini_model' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'openrouter_model') <> 'string'
    or (v_new ->> 'openrouter_model') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$' then
    raise exception 'Invalid openrouter_model' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'nvidia_model') <> 'string'
    or (v_new ->> 'nvidia_model') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$' then
    raise exception 'Invalid nvidia_model' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'temperature') <> 'number' or (v_new ->> 'temperature')::numeric not between 0 and 1 then
    raise exception 'Invalid temperature' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'max_history_messages') <> 'number' or (v_new ->> 'max_history_messages') !~ '^[0-9]{1,3}$'
    or (v_new ->> 'max_history_messages')::integer not between 4 and 60 then
    raise exception 'Invalid max_history_messages' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'debounce_seconds') <> 'number' or (v_new ->> 'debounce_seconds') !~ '^[0-9]{1,3}$'
    or (v_new ->> 'debounce_seconds')::integer not between 1 and 60 then
    raise exception 'Invalid debounce_seconds' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'human_pause_minutes') <> 'number' or (v_new ->> 'human_pause_minutes') !~ '^[0-9]{1,4}$'
    or (v_new ->> 'human_pause_minutes')::integer not between 5 and 1440 then
    raise exception 'Invalid human_pause_minutes' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'simulate_typing') <> 'boolean' then
    raise exception 'Invalid simulate_typing' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'split_long_messages') <> 'boolean' then
    raise exception 'Invalid split_long_messages' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'pause_on_human_reply') <> 'boolean' then
    raise exception 'Invalid pause_on_human_reply' using errcode = '22023';
  end if;

  insert into public.workspace_ai_settings as s (workspace_id, provider, fallback_provider,
    second_fallback_provider, gemini_model, openrouter_model, nvidia_model, temperature,
    max_history_messages, debounce_seconds, simulate_typing,
    split_long_messages, pause_on_human_reply, human_pause_minutes, updated_by)
  values (p_workspace_id, v_new ->> 'provider', v_new ->> 'fallback_provider',
    v_new ->> 'second_fallback_provider', v_new ->> 'gemini_model', v_new ->> 'openrouter_model',
    v_new ->> 'nvidia_model', round((v_new ->> 'temperature')::numeric, 2),
    (v_new ->> 'max_history_messages')::integer, (v_new ->> 'debounce_seconds')::integer,
    (v_new ->> 'simulate_typing')::boolean, (v_new ->> 'split_long_messages')::boolean,
    (v_new ->> 'pause_on_human_reply')::boolean, (v_new ->> 'human_pause_minutes')::integer, v_actor)
  on conflict (workspace_id) do update set
    provider = excluded.provider, fallback_provider = excluded.fallback_provider,
    second_fallback_provider = excluded.second_fallback_provider, gemini_model = excluded.gemini_model,
    openrouter_model = excluded.openrouter_model, nvidia_model = excluded.nvidia_model,
    temperature = excluded.temperature,
    max_history_messages = excluded.max_history_messages, debounce_seconds = excluded.debounce_seconds,
    simulate_typing = excluded.simulate_typing, split_long_messages = excluded.split_long_messages,
    pause_on_human_reply = excluded.pause_on_human_reply, human_pause_minutes = excluded.human_pause_minutes,
    updated_by = excluded.updated_by;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_settings_updated','workspace',p_workspace_id::text,
    jsonb_build_object('changed', p_settings));

  return public.read_my_ai_settings(p_workspace_id);
end;
$$;

-- Guardar a chave de um provedor (só o dono). O que chega aqui já vem cifrado pelo painel.
create or replace function public.save_my_ai_key(
  p_workspace_id uuid,
  p_provider text,
  p_ciphertext text,
  p_key_hint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('gemini','openrouter','nvidia') then
    raise exception 'Invalid provider' using errcode = '22023';
  end if;
  -- Barra, de propósito, qualquer coisa que não tenha a forma de um texto cifrado pelo painel:
  -- uma chave em texto puro nunca é gravada.
  if p_ciphertext is null
    or p_ciphertext !~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22}[.][A-Za-z0-9_-]+$'
    or char_length(p_ciphertext) not between 50 and 1600 then
    raise exception 'Invalid ciphertext' using errcode = '22023';
  end if;
  if p_key_hint is null or p_key_hint !~ '^[A-Za-z0-9._-]{1,8}$' then
    raise exception 'Invalid key hint' using errcode = '22023';
  end if;

  insert into private.workspace_ai_secrets(workspace_id, provider, ciphertext, key_hint, updated_by)
  values (p_workspace_id, p_provider, p_ciphertext, p_key_hint, v_actor)
  on conflict (workspace_id, provider) do update set
    ciphertext = excluded.ciphertext, key_hint = excluded.key_hint,
    updated_at = now(), updated_by = excluded.updated_by;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_key_saved','workspace',p_workspace_id::text,
    jsonb_build_object('provider', p_provider, 'key_hint', p_key_hint));

  return public.read_my_ai_settings(p_workspace_id);
end;
$$;

create or replace function public.delete_my_ai_key(p_workspace_id uuid, p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('gemini','openrouter','nvidia') then
    raise exception 'Invalid provider' using errcode = '22023';
  end if;

  delete from private.workspace_ai_secrets s
  where s.workspace_id = p_workspace_id and s.provider = p_provider;
  if found then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,v_actor,'owner','ai_key_deleted','workspace',p_workspace_id::text,
      jsonb_build_object('provider', p_provider));
  end if;

  return public.read_my_ai_settings(p_workspace_id);
end;
$$;

-- O texto cifrado da chave, para o painel decifrar no servidor e testar a conexão (só o dono).
-- Sem o segredo do servidor do painel, este texto não serve para nada.
create or replace function public.read_my_ai_key_ciphertext(p_workspace_id uuid, p_provider text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  return (select s.ciphertext from private.workspace_ai_secrets s
          where s.workspace_id = p_workspace_id and s.provider = p_provider);
end;
$$;

-- 6) Treinamento: ler e gravar.

-- Uma base inteira em JSON: os campos, as perguntas frequentes e os arquivos
-- (o conteúdo dos arquivos só vem quando pedido).
create or replace function private.ai_agent_json(p_workspace_id uuid, p_agent_id uuid, p_include_content boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'label', a.label, 'is_default', a.is_default,
    'business_name', a.business_name, 'niche', a.niche, 'assistant_name', a.assistant_name,
    'tone', a.tone, 'solo_identity', a.solo_identity,
    'company_summary', a.company_summary, 'commercial_terms', a.commercial_terms,
    'golden_rules', a.golden_rules, 'extra_instructions', a.extra_instructions,
    'lock_until_manual_resume', a.lock_until_manual_resume,
    'prompt_shield_enabled', a.prompt_shield_enabled,
    'robot_question_policy', a.robot_question_policy,
    'updated_at', a.updated_at,
    'faqs', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'question', f.question, 'answer', f.answer, 'source', f.source)
                       order by f.position, f.id)
      from public.ai_agent_faqs f
      where f.workspace_id = a.workspace_id and f.agent_id = a.id), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'char_count', char_length(d.content),
                         'created_at', d.created_at)
                       || case when p_include_content then jsonb_build_object('content', d.content) else '{}'::jsonb end
                       order by d.created_at, d.id)
      from public.ai_agent_documents d
      where d.workspace_id = a.workspace_id and d.agent_id = a.id), '[]'::jsonb))
  from public.ai_agents a
  where a.workspace_id = p_workspace_id and a.id = p_agent_id
$$;
revoke all on function private.ai_agent_json(uuid, uuid, boolean) from public, anon, authenticated;

-- A lista das bases da empresa (a padrão primeiro), com o tamanho de cada uma e os chips que a usam.
create or replace function public.read_my_ai_agents(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'can_edit', private.is_workspace_owner(p_workspace_id),
    'agents', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', a.id, 'label', a.label, 'is_default', a.is_default,
          'business_name', a.business_name, 'updated_at', a.updated_at,
          'faq_count', (select count(*) from public.ai_agent_faqs f
                        where f.workspace_id = a.workspace_id and f.agent_id = a.id),
          'document_count', (select count(*) from public.ai_agent_documents d
                             where d.workspace_id = a.workspace_id and d.agent_id = a.id),
          'instances', coalesce((
            select jsonb_agg(jsonb_build_object('id', i.id, 'display_name', i.display_name) order by i.created_at, i.id)
            from public.instances i
            where i.workspace_id = a.workspace_id and i.status <> 'revoked'
              and (i.ai_agent_id = a.id or (i.ai_agent_id is null and a.is_default))), '[]'::jsonb))
        order by a.is_default desc, a.created_at, a.id)
      from public.ai_agents a
      where a.workspace_id = p_workspace_id), '[]'::jsonb));
end;
$$;

create or replace function public.read_my_ai_agent(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_include_content boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_agent jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_agent := private.ai_agent_json(p_workspace_id, p_agent_id, coalesce(p_include_content, false));
  if v_agent is null then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  return v_agent || jsonb_build_object('can_edit', private.is_workspace_owner(p_workspace_id));
end;
$$;

-- Criar (p_agent_id vazio) ou alterar uma base (só o dono). Pode mandar só o que mudou.
-- Quando a lista de perguntas frequentes vem junto, ela substitui a lista inteira.
create or replace function public.save_my_ai_agent(p_workspace_id uuid, p_agent_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_text_limits constant jsonb := jsonb_build_object('label', 60, 'business_name', 120, 'niche', 120,
    'assistant_name', 60, 'company_summary', 4000, 'commercial_terms', 4000, 'golden_rules', 8000,
    'extra_instructions', 4000);
  v_flags constant text[] := array['solo_identity','lock_until_manual_resume','prompt_shield_enabled'];
  v_key text;
  v_value jsonb;
  v_data jsonb := '{}'::jsonb;
  v_agent public.ai_agents%rowtype;
  v_created boolean := false;
  v_count integer;
  v_faqs jsonb;
  v_faq jsonb;
  v_position integer := 0;
  v_question text;
  v_answer text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Invalid agent data' using errcode = '22023';
  end if;

  -- Confere campo a campo e guarda os textos já sem espaços nas pontas.
  for v_key, v_value in select * from jsonb_each(p_data) loop
    if v_text_limits ? v_key then
      if jsonb_typeof(v_value) <> 'string'
        or char_length(private.trim_text(v_value #>> '{}')) > (v_text_limits ->> v_key)::integer then
        raise exception 'Invalid %', v_key using errcode = '22023';
      end if;
      v_data := v_data || jsonb_build_object(v_key, private.trim_text(v_value #>> '{}'));
    elsif v_key = any (v_flags) then
      if jsonb_typeof(v_value) <> 'boolean' then raise exception 'Invalid %', v_key using errcode = '22023'; end if;
      v_data := v_data || jsonb_build_object(v_key, v_value);
    elsif v_key = 'tone' then
      if jsonb_typeof(v_value) <> 'string'
        or (v_value #>> '{}') not in ('consultivo','acolhedor','descontraido','profissional','formal') then
        raise exception 'Invalid tone' using errcode = '22023';
      end if;
      v_data := v_data || jsonb_build_object(v_key, v_value);
    elsif v_key = 'robot_question_policy' then
      if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') not in ('handoff','disclose') then
        raise exception 'Invalid robot_question_policy' using errcode = '22023';
      end if;
      v_data := v_data || jsonb_build_object(v_key, v_value);
    elsif v_key = 'faqs' then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 100 then
        raise exception 'Invalid faqs' using errcode = '22023';
      end if;
      v_faqs := v_value;
    else
      raise exception 'Unknown agent field: %', left(v_key, 60) using errcode = '22023';
    end if;
  end loop;
  if v_data ? 'label' and v_data ->> 'label' = '' then
    raise exception 'Invalid label' using errcode = '22023';
  end if;

  -- Trava a empresa: duas gravações ao mesmo tempo não criam duas bases padrão nem passam do limite.
  perform 1 from public.workspaces w where w.id = p_workspace_id and w.status = 'active' for update;
  if not found then raise exception 'Workspace not active' using errcode = '42501'; end if;

  if v_data ? 'label' then
    perform 1 from public.ai_agents o
    where o.workspace_id = p_workspace_id and lower(o.label) = lower(v_data ->> 'label')
      and (p_agent_id is null or o.id <> p_agent_id);
    if found then raise exception 'agent_label_taken' using errcode = 'P0001'; end if;
  end if;

  if p_agent_id is null then
    select count(*) into v_count from public.ai_agents a where a.workspace_id = p_workspace_id;
    if v_count >= 10 then raise exception 'agent_limit_reached' using errcode = 'P0001'; end if;
    if not (v_data ? 'label') then
      if v_count > 0 then raise exception 'Invalid label' using errcode = '22023'; end if;
      v_data := v_data || jsonb_build_object('label', 'Principal');
    end if;
    -- A primeira base da empresa já nasce como a padrão.
    insert into public.ai_agents(workspace_id, label, is_default, updated_by)
    values (p_workspace_id, v_data ->> 'label', v_count = 0, v_actor)
    returning * into v_agent;
    v_created := true;
  else
    select a.* into v_agent from public.ai_agents a
    where a.workspace_id = p_workspace_id and a.id = p_agent_id
    for update;
    if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  end if;

  update public.ai_agents a set
    label = coalesce(v_data ->> 'label', a.label),
    business_name = coalesce(v_data ->> 'business_name', a.business_name),
    niche = coalesce(v_data ->> 'niche', a.niche),
    assistant_name = coalesce(v_data ->> 'assistant_name', a.assistant_name),
    tone = coalesce(v_data ->> 'tone', a.tone),
    solo_identity = coalesce((v_data ->> 'solo_identity')::boolean, a.solo_identity),
    company_summary = coalesce(v_data ->> 'company_summary', a.company_summary),
    commercial_terms = coalesce(v_data ->> 'commercial_terms', a.commercial_terms),
    golden_rules = coalesce(v_data ->> 'golden_rules', a.golden_rules),
    extra_instructions = coalesce(v_data ->> 'extra_instructions', a.extra_instructions),
    lock_until_manual_resume = coalesce((v_data ->> 'lock_until_manual_resume')::boolean, a.lock_until_manual_resume),
    prompt_shield_enabled = coalesce((v_data ->> 'prompt_shield_enabled')::boolean, a.prompt_shield_enabled),
    robot_question_policy = coalesce(v_data ->> 'robot_question_policy', a.robot_question_policy),
    updated_by = v_actor,
    updated_at = now()
  where a.workspace_id = p_workspace_id and a.id = v_agent.id;

  if v_faqs is not null then
    delete from public.ai_agent_faqs f where f.workspace_id = p_workspace_id and f.agent_id = v_agent.id;
    for v_faq in select * from jsonb_array_elements(v_faqs) loop
      if jsonb_typeof(v_faq) <> 'object' or jsonb_typeof(v_faq -> 'question') is distinct from 'string'
        or jsonb_typeof(v_faq -> 'answer') is distinct from 'string' then
        raise exception 'Invalid faqs' using errcode = '22023';
      end if;
      v_question := private.trim_text(v_faq ->> 'question');
      v_answer := private.trim_text(v_faq ->> 'answer');
      if char_length(v_question) not between 1 and 500 or char_length(v_answer) not between 1 and 2000 then
        raise exception 'Invalid faqs' using errcode = '22023';
      end if;
      insert into public.ai_agent_faqs(workspace_id, agent_id, position, question, answer, source)
      values (p_workspace_id, v_agent.id, v_position, v_question, v_answer,
        case when v_faq ->> 'source' in ('correction','template') then v_faq ->> 'source' else 'manual' end);
      v_position := v_position + 1;
    end loop;
  end if;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner',case when v_created then 'ai_agent_created' else 'ai_agent_updated' end,
    'ai_agent',v_agent.id::text,
    jsonb_build_object('fields', (select coalesce(jsonb_agg(t.k order by t.k), '[]'::jsonb) from jsonb_object_keys(p_data) as t(k)),
      'faq_count', case when v_faqs is not null then jsonb_array_length(v_faqs) end));

  return private.ai_agent_json(p_workspace_id, v_agent.id, false) || jsonb_build_object('can_edit', true);
end;
$$;

-- Escolher a base padrão (só o dono).
create or replace function public.set_my_default_ai_agent(p_workspace_id uuid, p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  perform 1 from public.workspaces w where w.id = p_workspace_id and w.status = 'active' for update;
  if not found then raise exception 'Workspace not active' using errcode = '42501'; end if;
  perform 1 from public.ai_agents a where a.workspace_id = p_workspace_id and a.id = p_agent_id;
  if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;

  -- Primeiro tira a marca da antiga, depois marca a nova: nunca existem duas padrão ao mesmo tempo.
  update public.ai_agents a set is_default = false
  where a.workspace_id = p_workspace_id and a.is_default and a.id <> p_agent_id;
  update public.ai_agents a set is_default = true
  where a.workspace_id = p_workspace_id and a.id = p_agent_id and not a.is_default;

  if found then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,v_actor,'owner','ai_agent_default_changed','ai_agent',p_agent_id::text,'{}'::jsonb);
  end if;
  return public.read_my_ai_agents(p_workspace_id);
end;
$$;

-- Apagar uma base (só o dono). A base padrão não pode ser apagada: escolha outra como padrão antes.
-- Os chips que usavam a base apagada voltam a usar a padrão.
create or replace function public.delete_my_ai_agent(p_workspace_id uuid, p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_agent public.ai_agents%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  perform 1 from public.workspaces w where w.id = p_workspace_id and w.status = 'active' for update;
  if not found then raise exception 'Workspace not active' using errcode = '42501'; end if;
  select a.* into v_agent from public.ai_agents a
  where a.workspace_id = p_workspace_id and a.id = p_agent_id
  for update;
  if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  if v_agent.is_default then raise exception 'default_agent_required' using errcode = 'P0001'; end if;

  delete from public.ai_agents a where a.workspace_id = p_workspace_id and a.id = p_agent_id;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_agent_deleted','ai_agent',p_agent_id::text,
    jsonb_build_object('label', v_agent.label));
  return public.read_my_ai_agents(p_workspace_id);
end;
$$;

-- Anexar um arquivo de conhecimento a uma base (só o dono).
-- Limites: 30 mil caracteres por arquivo, 10 arquivos e 120 mil caracteres por base
-- (tudo o que está aqui é lido pela IA a cada resposta).
create or replace function public.add_my_ai_agent_document(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_title text,
  p_content text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_title text := private.trim_text(coalesce(p_title, ''));
  v_content text := private.trim_text(coalesce(p_content, ''));
  v_count integer;
  v_chars bigint;
  v_id uuid;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if char_length(v_title) not between 1 and 160 then
    raise exception 'Invalid title' using errcode = '22023';
  end if;
  if char_length(v_content) < 1 then raise exception 'document_empty' using errcode = 'P0001'; end if;
  if char_length(v_content) > 30000 then raise exception 'document_too_large' using errcode = 'P0001'; end if;

  -- Trava a base: dois envios ao mesmo tempo não passam dos limites.
  perform 1 from public.ai_agents a where a.workspace_id = p_workspace_id and a.id = p_agent_id for update;
  if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;

  select count(*), coalesce(sum(char_length(d.content)), 0) into v_count, v_chars
  from public.ai_agent_documents d
  where d.workspace_id = p_workspace_id and d.agent_id = p_agent_id;
  if v_count >= 10 then raise exception 'document_limit_reached' using errcode = 'P0001'; end if;
  if v_chars + char_length(v_content) > 120000 then
    raise exception 'document_space_exceeded' using errcode = 'P0001';
  end if;

  insert into public.ai_agent_documents(workspace_id, agent_id, title, content, created_by)
  values (p_workspace_id, p_agent_id, v_title, v_content, v_actor)
  returning id into v_id;
  update public.ai_agents a set updated_at = now(), updated_by = v_actor
  where a.workspace_id = p_workspace_id and a.id = p_agent_id;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_document_added','ai_agent',p_agent_id::text,
    jsonb_build_object('document_id', v_id, 'title', v_title, 'char_count', char_length(v_content)));

  return private.ai_agent_json(p_workspace_id, p_agent_id, false) || jsonb_build_object('can_edit', true);
end;
$$;

create or replace function public.delete_my_ai_agent_document(p_workspace_id uuid, p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_agent_id uuid;
  v_title text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;

  delete from public.ai_agent_documents d
  where d.workspace_id = p_workspace_id and d.id = p_document_id
  returning d.agent_id, d.title into v_agent_id, v_title;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  update public.ai_agents a set updated_at = now(), updated_by = v_actor
  where a.workspace_id = p_workspace_id and a.id = v_agent_id;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_document_deleted','ai_agent',v_agent_id::text,
    jsonb_build_object('document_id', p_document_id, 'title', v_title));

  return private.ai_agent_json(p_workspace_id, v_agent_id, false) || jsonb_build_object('can_edit', true);
end;
$$;

-- Escolher qual base um chip usa (só o dono). Sem base escolhida (p_agent_id vazio), o chip usa a padrão.
create or replace function public.set_my_instance_ai_agent(p_workspace_id uuid, p_instance_id uuid, p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_previous uuid;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_agent_id is not null then
    perform 1 from public.ai_agents a where a.workspace_id = p_workspace_id and a.id = p_agent_id;
    if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  end if;

  select i.ai_agent_id into v_previous from public.instances i
  where i.workspace_id = p_workspace_id and i.id = p_instance_id and i.status <> 'revoked'
  for update;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  if v_previous is distinct from p_agent_id then
    update public.instances i set ai_agent_id = p_agent_id
    where i.workspace_id = p_workspace_id and i.id = p_instance_id;

    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,v_actor,'owner','instance_ai_agent_changed','instance',p_instance_id::text,
      jsonb_build_object('ai_agent_id', p_agent_id, 'previous_ai_agent_id', v_previous));
  end if;
  return public.read_my_ai_agents(p_workspace_id);
end;
$$;

-- 7) Quem pode chamar o quê: só quem está logado. Visitante e o público em geral, nada.
revoke all on function public.read_my_ai_settings(uuid) from public, anon;
revoke all on function public.save_my_ai_settings(uuid, jsonb) from public, anon;
revoke all on function public.save_my_ai_key(uuid, text, text, text) from public, anon;
revoke all on function public.delete_my_ai_key(uuid, text) from public, anon;
revoke all on function public.read_my_ai_key_ciphertext(uuid, text) from public, anon;
revoke all on function public.read_my_ai_agents(uuid) from public, anon;
revoke all on function public.read_my_ai_agent(uuid, uuid, boolean) from public, anon;
revoke all on function public.save_my_ai_agent(uuid, uuid, jsonb) from public, anon;
revoke all on function public.set_my_default_ai_agent(uuid, uuid) from public, anon;
revoke all on function public.delete_my_ai_agent(uuid, uuid) from public, anon;
revoke all on function public.add_my_ai_agent_document(uuid, uuid, text, text) from public, anon;
revoke all on function public.delete_my_ai_agent_document(uuid, uuid) from public, anon;
revoke all on function public.set_my_instance_ai_agent(uuid, uuid, uuid) from public, anon;
grant execute on function public.read_my_ai_settings(uuid) to authenticated;
grant execute on function public.save_my_ai_settings(uuid, jsonb) to authenticated;
grant execute on function public.save_my_ai_key(uuid, text, text, text) to authenticated;
grant execute on function public.delete_my_ai_key(uuid, text) to authenticated;
grant execute on function public.read_my_ai_key_ciphertext(uuid, text) to authenticated;
grant execute on function public.read_my_ai_agents(uuid) to authenticated;
grant execute on function public.read_my_ai_agent(uuid, uuid, boolean) to authenticated;
grant execute on function public.save_my_ai_agent(uuid, uuid, jsonb) to authenticated;
grant execute on function public.set_my_default_ai_agent(uuid, uuid) to authenticated;
grant execute on function public.delete_my_ai_agent(uuid, uuid) to authenticated;
grant execute on function public.add_my_ai_agent_document(uuid, uuid, text, text) to authenticated;
grant execute on function public.delete_my_ai_agent_document(uuid, uuid) to authenticated;
grant execute on function public.set_my_instance_ai_agent(uuid, uuid, uuid) to authenticated;

commit;
