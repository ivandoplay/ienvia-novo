-- Fase 4: Motor local (Baileys rodando no computador ou celular Android/Termux do cliente),
-- pareamento seguro por código temporário, fila durável de comandos (com invariante anti-reenvio),
-- recepção e envio de texto/mídia, suporte ao Atendente de IA e agendamentos por chip local.

begin;

-- 1) Aparelhos locais pareados a cada empresa.
--    Nunca guardam chave mestra do banco: autenticam-se por token opaco (só o resumo SHA-256 fica no schema private).
create table public.local_executors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_user_id uuid references auth.users(id) on delete set null,
  display_name text not null check (char_length(display_name) between 1 and 80),
  platform text not null default 'unknown'
    check (platform in ('win32','linux','android-termux','darwin','unknown')),
  motor_version text
    check (motor_version is null or motor_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  status text not null default 'pending_pair'
    check (status in ('pending_pair','active','offline','revoked')),
  last_seen_at timestamptz,
  paired_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint local_executors_workspace_id_uq unique (workspace_id, id)
);

create index local_executors_workspace_idx
  on public.local_executors(workspace_id, status, created_at desc);

create trigger local_executors_touch
  before update on public.local_executors
  for each row execute function private.touch_updated_at();

alter table public.local_executors enable row level security;
alter table public.local_executors force row level security;

revoke all on table public.local_executors from public, anon, authenticated;
grant select on table public.local_executors to authenticated;

create policy local_executors_member_select on public.local_executors
  for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- 2) Segredos dos aparelhos locais: isolados em schema private (inacessível a anon/authenticated).
create table private.local_executor_tokens (
  executor_id uuid primary key references public.local_executors(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  pairing_code_sha256 text unique
    check (pairing_code_sha256 is null or pairing_code_sha256 ~ '^[a-f0-9]{64}$'),
  pairing_expires_at timestamptz,
  token_sha256 text unique
    check (token_sha256 is null or token_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger local_executor_tokens_touch
  before update on private.local_executor_tokens
  for each row execute function private.touch_updated_at();

revoke all on table private.local_executor_tokens from public, anon, authenticated;

-- 3) Vincular chips Baileys ao aparelho local + estado temporário de pareamento WhatsApp (QR / 8 dígitos).
alter table public.instances
  add column local_executor_id uuid,
  add column pairing_qr text,
  add column pairing_code text,
  add column pairing_updated_at timestamptz;

alter table public.instances
  add constraint instances_local_executor_fk
  foreign key (workspace_id, local_executor_id)
  references public.local_executors(workspace_id, id)
  on delete set null;

create index instances_local_executor_idx
  on public.instances(workspace_id, local_executor_id)
  where local_executor_id is not null and status <> 'revoked';

-- 4) Fila durável de comandos para o motor local.
--    Para envios (send_text / send_media), cada mensagem tem no máximo 1 comando e nunca é re-entregue após
--    expirar a concessão (lease): vira 'uncertain' e a mensagem fica 'awaiting_human_confirmation'.
create table public.local_motor_commands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  executor_id uuid not null,
  instance_id uuid not null,
  command_type text not null
    check (command_type in ('connect_qr','connect_code','disconnect','clear_session','send_text','send_media')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','leased','succeeded','failed','uncertain','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_until timestamptz,
  message_id uuid references public.messages(id) on delete set null,
  provider_message_id text,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint local_motor_commands_executor_fk
    foreign key (workspace_id, executor_id) references public.local_executors(workspace_id, id) on delete cascade,
  constraint local_motor_commands_instance_fk
    foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete cascade
);

create unique index local_motor_commands_message_uq
  on public.local_motor_commands(workspace_id, message_id)
  where message_id is not null;

create index local_motor_commands_queue_idx
  on public.local_motor_commands(executor_id, status, created_at)
  where status in ('pending','leased');

create trigger local_motor_commands_touch
  before update on public.local_motor_commands
  for each row execute function private.touch_updated_at();

alter table public.local_motor_commands enable row level security;
alter table public.local_motor_commands force row level security;

revoke all on table public.local_motor_commands from public, anon, authenticated;
grant select on table public.local_motor_commands to authenticated;

create policy local_motor_commands_owner_select on public.local_motor_commands
  for select to authenticated
  using (private.is_workspace_owner(workspace_id));

-- 5) Helpers privados de validação e autenticação de aparelho local.
create or replace function private.auth_local_executor(p_token_sha256 text)
returns table(executor_id uuid, workspace_id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.workspace_id, e.display_name
  from private.local_executor_tokens t
  join public.local_executors e on e.id = t.executor_id and e.workspace_id = t.workspace_id
  where p_token_sha256 is not null
    and p_token_sha256 ~ '^[a-f0-9]{64}$'
    and t.token_sha256 = p_token_sha256
    and e.revoked_at is null
    and e.status in ('active','offline')
$$;
revoke all on function private.auth_local_executor(text) from public, anon, authenticated;

-- 6) RPCs do dono no painel: criar código de pareamento, renomear, revogar, criar chip local e mandar ação.
create or replace function public.create_my_local_executor_pairing(
  p_workspace_id uuid,
  p_display_name text,
  p_code_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
  v_executor public.local_executors%rowtype;
  v_expires_at timestamptz := clock_timestamp() + interval '15 minutes';
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;
  if p_code_sha256 is null or p_code_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid pairing code digest' using errcode = '22023';
  end if;

  -- Apaga códigos pendentes vencidos deste mesmo workspace para manter a lista limpa.
  delete from private.local_executor_tokens t
  using public.local_executors e
  where t.executor_id = e.id and e.workspace_id = p_workspace_id
    and e.status = 'pending_pair' and t.pairing_expires_at < clock_timestamp() - interval '1 hour';

  insert into public.local_executors(workspace_id, owner_user_id, display_name, status)
  values (p_workspace_id, v_actor, v_name, 'pending_pair')
  returning * into v_executor;

  insert into private.local_executor_tokens(executor_id, workspace_id, pairing_code_sha256, pairing_expires_at)
  values (v_executor.id, p_workspace_id, p_code_sha256, v_expires_at);

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, 'owner', 'local_executor_pairing_created', 'local_executor', v_executor.id::text,
    jsonb_build_object('display_name', v_name, 'expires_at', v_expires_at));

  return jsonb_build_object(
    'id', v_executor.id,
    'display_name', v_executor.display_name,
    'status', v_executor.status,
    'expires_at', v_expires_at
  );
end;
$$;

create or replace function public.rename_my_local_executor(
  p_workspace_id uuid,
  p_executor_id uuid,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
  v_executor public.local_executors%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;

  update public.local_executors
  set display_name = v_name
  where workspace_id = p_workspace_id and id = p_executor_id and status <> 'revoked'
  returning * into v_executor;
  if not found then raise exception 'Executor not found' using errcode = 'P0002'; end if;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, 'owner', 'local_executor_renamed', 'local_executor', v_executor.id::text,
    jsonb_build_object('display_name', v_name));

  return jsonb_build_object('id', v_executor.id, 'display_name', v_executor.display_name);
end;
$$;

create or replace function public.revoke_my_local_executor(
  p_workspace_id uuid,
  p_executor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_executor public.local_executors%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;

  update public.local_executors
  set status = 'revoked', revoked_at = clock_timestamp()
  where workspace_id = p_workspace_id and id = p_executor_id and status <> 'revoked'
  returning * into v_executor;
  if not found then raise exception 'Executor not found' using errcode = 'P0002'; end if;

  delete from private.local_executor_tokens
  where workspace_id = p_workspace_id and executor_id = p_executor_id;

  -- Cancela comandos em aberto e marca como desconectados os chips ligados a este aparelho.
  update public.local_motor_commands
  set status = 'cancelled', error_detail = 'executor_revoked'
  where workspace_id = p_workspace_id and executor_id = p_executor_id and status in ('pending','leased');

  update public.instances
  set status = 'disconnected',
      pairing_qr = null,
      pairing_code = null,
      pairing_updated_at = null
  where workspace_id = p_workspace_id and local_executor_id = p_executor_id and status <> 'revoked';

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, 'owner', 'local_executor_revoked', 'local_executor', v_executor.id::text,
    jsonb_build_object('display_name', v_executor.display_name));

  return jsonb_build_object('id', v_executor.id, 'status', v_executor.status);
end;
$$;

create or replace function public.create_my_local_instance(
  p_workspace_id uuid,
  p_display_name text,
  p_purpose text,
  p_executor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
  v_limit integer;
  v_used integer;
  v_executor public.local_executors%rowtype;
  v_instance public.instances%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;
  if p_purpose is null or p_purpose not in ('attendance','campaigns','both') then
    raise exception 'Invalid purpose' using errcode = '22023';
  end if;
  if p_executor_id is null then
    raise exception 'Executor required' using errcode = '22023';
  end if;

  select e.* into v_executor
  from public.local_executors e
  where e.workspace_id = p_workspace_id and e.id = p_executor_id and e.status in ('active','offline','pending_pair');
  if not found then
    raise exception 'Executor not found' using errcode = 'P0002';
  end if;

  select w.max_instances into v_limit
  from public.workspaces w
  where w.id = p_workspace_id
  for update;
  if not found then raise exception 'Workspace not found' using errcode = 'P0002'; end if;

  select count(*)::integer into v_used
  from public.instances i
  where i.workspace_id = p_workspace_id and i.status <> 'revoked';

  if v_used >= coalesce(v_limit, 1) then
    raise exception 'instance_limit_reached' using errcode = 'P0001';
  end if;

  insert into public.instances(
    workspace_id, channel, engine, display_name, purpose, status, is_enabled, local_executor_id
  )
  values (
    p_workspace_id, 'whatsapp', 'baileys', v_name, p_purpose, 'disconnected', false, p_executor_id
  )
  returning * into v_instance;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, 'owner', 'instance_created', 'instance', v_instance.id::text,
    jsonb_build_object('engine', 'baileys', 'purpose', p_purpose, 'executor_id', p_executor_id));

  return jsonb_build_object(
    'id', v_instance.id,
    'display_name', v_instance.display_name,
    'purpose', v_instance.purpose,
    'status', v_instance.status,
    'engine', v_instance.engine,
    'local_executor_id', v_instance.local_executor_id,
    'is_enabled', v_instance.is_enabled
  );
end;
$$;

create or replace function public.request_my_local_instance_action(
  p_workspace_id uuid,
  p_instance_id uuid,
  p_command_type text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_instance public.instances%rowtype;
  v_executor public.local_executors%rowtype;
  v_command public.local_motor_commands%rowtype;
  v_payload jsonb := case when jsonb_typeof(p_payload) = 'object' then p_payload else '{}'::jsonb end;
  v_phone text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_command_type is null or p_command_type not in ('connect_qr','connect_code','disconnect','clear_session') then
    raise exception 'Invalid command type' using errcode = '22023';
  end if;

  select i.* into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = p_instance_id
    and i.channel = 'whatsapp' and i.engine = 'baileys' and i.status <> 'revoked'
  for update;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  if v_instance.local_executor_id is null then
    raise exception 'instance_unavailable' using errcode = 'P0001';
  end if;

  select e.* into v_executor
  from public.local_executors e
  where e.workspace_id = p_workspace_id and e.id = v_instance.local_executor_id and e.status <> 'revoked';
  if not found then
    raise exception 'executor_revoked' using errcode = 'P0001';
  end if;

  if p_command_type = 'connect_code' then
    v_phone := regexp_replace(coalesce(v_payload ->> 'phone', ''), '\D', '', 'g');
    if v_phone !~ '^[1-9][0-9]{9,14}$' then
      raise exception 'Invalid pairing phone' using errcode = '22023';
    end if;
    v_payload := jsonb_build_object('phone', v_phone);
  else
    v_payload := '{}'::jsonb;
  end if;

  -- Cancela comandos de ciclo de conexão anteriores que ainda não terminaram.
  update public.local_motor_commands
  set status = 'cancelled', error_detail = 'superseded'
  where workspace_id = p_workspace_id and instance_id = p_instance_id
    and command_type in ('connect_qr','connect_code','disconnect','clear_session')
    and status in ('pending','leased');

  if p_command_type in ('connect_qr','connect_code') then
    update public.instances
    set status = 'connecting',
        pairing_qr = null,
        pairing_code = null,
        pairing_updated_at = clock_timestamp()
    where workspace_id = p_workspace_id and id = p_instance_id;
  elsif p_command_type in ('disconnect','clear_session') then
    update public.instances
    set pairing_qr = null,
        pairing_code = null,
        pairing_updated_at = null
    where workspace_id = p_workspace_id and id = p_instance_id;
  end if;

  insert into public.local_motor_commands(
    workspace_id, executor_id, instance_id, command_type, payload, status
  )
  values (
    p_workspace_id, v_instance.local_executor_id, p_instance_id, p_command_type, v_payload, 'pending'
  )
  returning * into v_command;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, 'owner', 'local_instance_' || p_command_type, 'instance', p_instance_id::text,
    jsonb_build_object('command_id', v_command.id, 'executor_id', v_instance.local_executor_id));

  return jsonb_build_object(
    'command_id', v_command.id,
    'status', v_command.status,
    'command_type', v_command.command_type
  );
end;
$$;

-- Atualiza remove_my_instance para cancelar comandos pendentes também nos chips locais.
create or replace function public.remove_my_instance(
  p_workspace_id uuid,
  p_instance_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_instance public.instances%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;

  update public.instances
  set status = 'revoked',
      is_enabled = false,
      pairing_qr = null,
      pairing_code = null,
      pairing_updated_at = null
  where workspace_id = p_workspace_id and id = p_instance_id and status <> 'revoked'
  returning * into v_instance;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  delete from private.evolution_webhook_auth
  where workspace_id = p_workspace_id and instance_id = p_instance_id;

  update public.local_motor_commands
  set status = 'cancelled', error_detail = 'instance_removed'
  where workspace_id = p_workspace_id and instance_id = p_instance_id and status in ('pending','leased');

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','instance_removed','instance',v_instance.id::text,
    jsonb_build_object('engine',v_instance.engine,'provider_instance_name',v_instance.provider_instance_name));

  return jsonb_build_object('id',v_instance.id,'provider_instance_name',v_instance.provider_instance_name);
end;
$$;

-- Também permitir vincular/alterar aparelho local em update_my_instance_settings via sobrecarga opcional ou novo RPC.
create or replace function public.assign_my_local_instance_executor(
  p_workspace_id uuid,
  p_instance_id uuid,
  p_executor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_instance public.instances%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;

  perform 1 from public.local_executors e
  where e.workspace_id = p_workspace_id and e.id = p_executor_id and e.status in ('active','offline','pending_pair');
  if not found then raise exception 'Executor not found' using errcode = 'P0002'; end if;

  update public.instances
  set local_executor_id = p_executor_id,
      status = case when status = 'connected' then 'disconnected' else status end,
      pairing_qr = null,
      pairing_code = null
  where workspace_id = p_workspace_id and id = p_instance_id
    and channel = 'whatsapp' and engine = 'baileys' and status <> 'revoked'
  returning * into v_instance;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  update public.local_motor_commands
  set status = 'cancelled', error_detail = 'executor_reassigned'
  where workspace_id = p_workspace_id and instance_id = p_instance_id and status in ('pending','leased');

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, 'owner', 'local_instance_executor_assigned', 'instance', p_instance_id::text,
    jsonb_build_object('executor_id', p_executor_id));

  return jsonb_build_object('id', v_instance.id, 'local_executor_id', v_instance.local_executor_id);
end;
$$;

revoke all on function public.create_my_local_executor_pairing(uuid,text,text) from public, anon;
revoke all on function public.rename_my_local_executor(uuid,uuid,text) from public, anon;
revoke all on function public.revoke_my_local_executor(uuid,uuid) from public, anon;
revoke all on function public.create_my_local_instance(uuid,text,text,uuid) from public, anon;
revoke all on function public.request_my_local_instance_action(uuid,uuid,text,jsonb) from public, anon;
revoke all on function public.assign_my_local_instance_executor(uuid,uuid,uuid) from public, anon;

grant execute on function public.create_my_local_executor_pairing(uuid,text,text) to authenticated;
grant execute on function public.rename_my_local_executor(uuid,uuid,text) to authenticated;
grant execute on function public.revoke_my_local_executor(uuid,uuid) to authenticated;
grant execute on function public.create_my_local_instance(uuid,text,text,uuid) to authenticated;
grant execute on function public.request_my_local_instance_action(uuid,uuid,text,jsonb) to authenticated;
grant execute on function public.assign_my_local_instance_executor(uuid,uuid,uuid) to authenticated;

-- 7) RPCs de serviço chamados exclusivamente pelas rotas /api/motor/* (service_role).
create or replace function public.pair_local_executor_by_code(
  p_code_sha256 text,
  p_token_sha256 text,
  p_platform text,
  p_version text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tok private.local_executor_tokens%rowtype;
  v_exec public.local_executors%rowtype;
  v_plat text := case when p_platform in ('win32','linux','android-termux','darwin','unknown') then p_platform else 'unknown' end;
  v_ver text := case when p_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$' then p_version end;
  v_meta jsonb := case when jsonb_typeof(p_metadata) = 'object' then p_metadata else '{}'::jsonb end;
begin
  if p_code_sha256 is null or p_code_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('result', 'invalid_code');
  end if;
  if p_token_sha256 is null or p_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid token digest' using errcode = '22023';
  end if;

  select t.* into v_tok
  from private.local_executor_tokens t
  join public.local_executors e on e.id = t.executor_id
  where t.pairing_code_sha256 = p_code_sha256
    and e.status = 'pending_pair'
    and t.pairing_expires_at > clock_timestamp()
  for update;

  if not found then
    return jsonb_build_object('result', 'invalid_or_expired');
  end if;

  update private.local_executor_tokens
  set pairing_code_sha256 = null,
      pairing_expires_at = null,
      token_sha256 = p_token_sha256
  where executor_id = v_tok.executor_id;

  update public.local_executors
  set status = 'active',
      platform = v_plat,
      motor_version = v_ver,
      paired_at = clock_timestamp(),
      last_seen_at = clock_timestamp(),
      metadata = v_meta
  where id = v_tok.executor_id
  returning * into v_exec;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (v_exec.workspace_id, null, 'service', 'local_executor_paired', 'local_executor', v_exec.id::text,
    jsonb_build_object('platform', v_plat, 'motor_version', v_ver));

  return jsonb_build_object(
    'result', 'paired',
    'executor_id', v_exec.id,
    'workspace_id', v_exec.workspace_id,
    'display_name', v_exec.display_name,
    'platform', v_exec.platform,
    'motor_version', v_exec.motor_version
  );
end;
$$;

create or replace function public.authenticate_local_executor_heartbeat(
  p_token_sha256 text,
  p_platform text default null,
  p_version text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_exec public.local_executors%rowtype;
  v_instances jsonb;
begin
  select * into v_auth from private.auth_local_executor(p_token_sha256);
  if not found then
    return jsonb_build_object('result', 'unauthorized');
  end if;

  update public.local_executors
  set status = 'active',
      last_seen_at = clock_timestamp(),
      platform = case when p_platform in ('win32','linux','android-termux','darwin','unknown') then p_platform else platform end,
      motor_version = case when p_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$' then p_version else motor_version end,
      metadata = case when jsonb_typeof(p_metadata) = 'object' and p_metadata <> '{}'::jsonb then p_metadata else metadata end
  where id = v_auth.executor_id
  returning * into v_exec;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'display_name', i.display_name,
    'purpose', i.purpose,
    'status', i.status,
    'connected_phone', i.connected_phone
  ) order by i.created_at asc), '[]'::jsonb)
  into v_instances
  from public.instances i
  where i.workspace_id = v_auth.workspace_id
    and i.local_executor_id = v_auth.executor_id
    and i.engine = 'baileys'
    and i.status <> 'revoked';

  return jsonb_build_object(
    'result', 'ok',
    'executor_id', v_exec.id,
    'workspace_id', v_exec.workspace_id,
    'display_name', v_exec.display_name,
    'instances', v_instances
  );
end;
$$;

create or replace function public.claim_local_motor_commands(
  p_token_sha256 text,
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_expired record;
  v_cmd public.local_motor_commands%rowtype;
  v_inst public.instances%rowtype;
  v_msg public.messages%rowtype;
  v_att public.message_attachments%rowtype;
  v_items jsonb := '[]'::jsonb;
begin
  select * into v_auth from private.auth_local_executor(p_token_sha256);
  if not found then
    return jsonb_build_object('result', 'unauthorized', 'commands', '[]'::jsonb);
  end if;

  update public.local_executors
  set status = 'active', last_seen_at = clock_timestamp()
  where id = v_auth.executor_id;

  -- Trata concessões vencidas antes de entregar novos comandos:
  -- envios NUNCA são re-entregues após vencerem -> ficam incertos para decisão humana!
  for v_expired in
    select c.*
    from public.local_motor_commands c
    where c.executor_id = v_auth.executor_id
      and c.status = 'leased'
      and c.lease_until < clock_timestamp()
    for update skip locked
  loop
    if v_expired.command_type in ('send_text','send_media') then
      update public.local_motor_commands
      set status = 'uncertain', error_detail = 'lease_expired'
      where id = v_expired.id;
      if v_expired.message_id is not null then
        perform private.finish_outbound_message(v_expired.workspace_id, v_expired.message_id, 'uncertain', null, null, 'service');
      end if;
    elsif v_expired.attempts < 3 then
      update public.local_motor_commands
      set status = 'pending', lease_until = null
      where id = v_expired.id;
    else
      update public.local_motor_commands
      set status = 'failed', error_detail = 'lease_expired'
      where id = v_expired.id;
    end if;
  end loop;

  for v_cmd in
    select c.*
    from public.local_motor_commands c
    where c.executor_id = v_auth.executor_id
      and c.status = 'pending'
    order by
      case when c.command_type in ('disconnect','clear_session','connect_qr','connect_code') then 0 else 1 end,
      c.created_at asc
    limit v_limit
    for update skip locked
  loop
    update public.local_motor_commands
    set status = 'leased',
        attempts = attempts + 1,
        lease_until = clock_timestamp() + interval '45 seconds'
    where id = v_cmd.id
    returning * into v_cmd;

    select i.* into v_inst
    from public.instances i
    where i.workspace_id = v_cmd.workspace_id and i.id = v_cmd.instance_id;

    v_msg := null;
    v_att := null;
    if v_cmd.message_id is not null then
      select m.* into v_msg
      from public.messages m
      where m.workspace_id = v_cmd.workspace_id and m.id = v_cmd.message_id;
      select a.* into v_att
      from public.message_attachments a
      where a.workspace_id = v_cmd.workspace_id and a.message_id = v_cmd.message_id;
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', v_cmd.id,
      'workspace_id', v_cmd.workspace_id,
      'instance_id', v_cmd.instance_id,
      'instance_name', v_inst.display_name,
      'command_type', v_cmd.command_type,
      'payload', v_cmd.payload,
      'message_id', v_cmd.message_id,
      'attachment', case when v_att.id is not null then jsonb_build_object(
        'object_key', v_att.object_key,
        'kind', v_att.kind,
        'content_type', v_att.content_type,
        'file_name', v_att.file_name,
        'caption', v_msg.body_text
      ) end,
      'attempts', v_cmd.attempts,
      'created_at', v_cmd.created_at
    ));
  end loop;

  return jsonb_build_object('result', 'ok', 'executor_id', v_auth.executor_id, 'commands', v_items);
end;
$$;

create or replace function public.report_local_instance_state(
  p_token_sha256 text,
  p_instance_id uuid,
  p_status text,
  p_connected_phone text default null,
  p_pairing_qr text default null,
  p_pairing_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_before public.instances%rowtype;
  v_after public.instances%rowtype;
  v_status text := p_status;
  v_phone text := nullif(btrim(coalesce(p_connected_phone, '')), '');
  v_qr text := nullif(btrim(coalesce(p_pairing_qr, '')), '');
  v_code text := nullif(btrim(coalesce(p_pairing_code, '')), '');
begin
  select * into v_auth from private.auth_local_executor(p_token_sha256);
  if not found then
    return jsonb_build_object('result', 'unauthorized');
  end if;
  if v_status is null or v_status not in ('disconnected','connecting','connected','error') then
    raise exception 'Invalid instance status' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{5,19}$' then
    v_phone := null;
  end if;

  select i.* into v_before
  from public.instances i
  where i.workspace_id = v_auth.workspace_id
    and i.id = p_instance_id
    and i.local_executor_id = v_auth.executor_id
    and i.engine = 'baileys'
    and i.status <> 'revoked'
  for update;
  if not found then
    return jsonb_build_object('result', 'instance_not_found');
  end if;

  update public.instances
  set status = v_status,
      connected_phone = case
        when v_status = 'connected' then coalesce(v_phone, connected_phone)
        when v_status = 'disconnected' then null
        else connected_phone
      end,
      pairing_qr = case when v_status = 'connecting' then coalesce(v_qr, pairing_qr) else null end,
      pairing_code = case when v_status = 'connecting' then coalesce(v_code, pairing_code) else null end,
      pairing_updated_at = case when v_status = 'connecting' then clock_timestamp() else null end,
      last_seen_at = case when v_status = 'connected' then clock_timestamp() else last_seen_at end
  where id = v_before.id
  returning * into v_after;

  update public.local_executors
  set status = 'active', last_seen_at = clock_timestamp()
  where id = v_auth.executor_id;

  if v_before.status is distinct from v_after.status then
    insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
    values (v_after.workspace_id, null, 'service', 'instance_status_changed', 'instance', v_after.id::text,
      jsonb_build_object('from', v_before.status, 'to', v_after.status, 'source', 'local_motor', 'executor_id', v_auth.executor_id));
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'id', v_after.id,
    'status', v_after.status,
    'connected_phone', v_after.connected_phone
  );
end;
$$;

create or replace function public.complete_local_motor_command(
  p_token_sha256 text,
  p_command_id uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_cmd public.local_motor_commands%rowtype;
  v_new_status text;
  v_msg_outcome text;
  v_finish jsonb := null;
begin
  select * into v_auth from private.auth_local_executor(p_token_sha256);
  if not found then
    return jsonb_build_object('result', 'unauthorized');
  end if;
  if p_outcome is null or p_outcome not in ('sent','succeeded','failed','uncertain') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;

  select c.* into v_cmd
  from public.local_motor_commands c
  where c.workspace_id = v_auth.workspace_id
    and c.executor_id = v_auth.executor_id
    and c.id = p_command_id
  for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_cmd.status not in ('pending','leased') then
    return jsonb_build_object('result', 'already_finished', 'status', v_cmd.status);
  end if;

  v_new_status := case p_outcome
    when 'sent' then 'succeeded'
    when 'succeeded' then 'succeeded'
    when 'failed' then 'failed'
    else 'uncertain'
  end;

  update public.local_motor_commands
  set status = v_new_status,
      provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
      error_detail = nullif(left(btrim(coalesce(p_error_detail, '')), 500), '')
  where id = v_cmd.id;

  if v_cmd.message_id is not null then
    v_msg_outcome := case when p_outcome in ('sent','succeeded') then 'sent'
                          when p_outcome = 'failed' then 'failed'
                          else 'uncertain' end;
    v_finish := private.finish_outbound_message(
      v_cmd.workspace_id,
      v_cmd.message_id,
      v_msg_outcome,
      nullif(left(btrim(coalesce(p_provider_message_id, '')), 200), ''),
      null,
      'service'
    );
  end if;

  update public.local_executors
  set status = 'active', last_seen_at = clock_timestamp()
  where id = v_auth.executor_id;

  return jsonb_build_object('result', 'ok', 'status', v_new_status, 'message', v_finish);
end;
$$;

-- Ingestão de mensagem vinda do Motor Local (Baileys): mesma proteção anti-duplicação,
-- adoção de eco do próprio chip e disparo da vez do Atendente de IA!
create or replace function public.ingest_local_message(
  p_token_sha256 text,
  p_instance_id uuid,
  p_event_id text,
  p_sender_jid text,
  p_push_name text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_from_me boolean,
  p_media jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_workspace_id uuid;
  v_instance_id uuid;
  v_webhook_event_id uuid;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_candidate_id uuid;
  v_message_id uuid;
  v_phone text;
  v_display_name text;
  v_body text := nullif(btrim(coalesce(p_body_text, '')), '');
  v_created boolean := false;
  v_adopted boolean := false;
  v_adopted_actor text;
  v_kind text;
  v_mime text;
  v_size bigint;
  v_file_name text;
  v_duration integer;
  v_width integer;
  v_height integer;
  v_voice boolean := false;
  v_object_key text;
  v_media_status text;
  v_keep_until timestamptz;
  v_preview text;
  v_ai jsonb;
  v_media jsonb := case when jsonb_typeof(p_media) = 'object' then p_media end;
begin
  select * into v_auth from private.auth_local_executor(p_token_sha256);
  if not found then
    return jsonb_build_object('result', 'unauthorized');
  end if;

  select i.workspace_id, i.id into v_workspace_id, v_instance_id
  from public.instances i
  where i.workspace_id = v_auth.workspace_id
    and i.id = p_instance_id
    and i.local_executor_id = v_auth.executor_id
    and i.channel = 'whatsapp'
    and i.engine = 'baileys'
    and i.status <> 'revoked';
  if not found then
    return jsonb_build_object('result', 'unauthorized');
  end if;

  if p_event_id is null or char_length(p_event_id) not between 1 and 200 then
    raise exception 'Invalid event id' using errcode = '22023';
  end if;

  insert into public.webhook_events(workspace_id, instance_id, engine, provider_event_id, event_type, processing_status)
  values (v_workspace_id, v_instance_id, 'baileys', p_event_id, 'MESSAGES_UPSERT', 'received')
  on conflict (workspace_id, instance_id, engine, provider_event_id) do nothing
  returning id into v_webhook_event_id;
  if v_webhook_event_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  if v_media is not null then
    v_kind := v_media ->> 'kind';
    if v_kind is null or v_kind not in ('image','audio','video','document','sticker') then
      v_kind := 'document';
    end if;
    v_mime := lower(btrim(split_part(left(coalesce(v_media ->> 'mime', ''), 200), ';', 1)));
    if v_mime !~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' or char_length(v_mime) > 120 then
      v_mime := 'application/octet-stream';
    end if;
    v_file_name := nullif(left(btrim(coalesce(v_media ->> 'file_name', '')), 200), '');
    v_voice := coalesce(v_media ->> 'voice', '') = 'true';
    if (v_media ->> 'size') ~ '^[0-9]{1,15}$' then v_size := (v_media ->> 'size')::bigint; end if;
    if (v_media ->> 'duration') ~ '^[0-9]{1,5}$' then v_duration := least((v_media ->> 'duration')::integer, 86400); end if;
    if (v_media ->> 'width') ~ '^[0-9]{1,5}$' and (v_media ->> 'width')::integer between 1 and 20000 then
      v_width := (v_media ->> 'width')::integer;
    end if;
    if (v_media ->> 'height') ~ '^[0-9]{1,5}$' and (v_media ->> 'height')::integer between 1 and 20000 then
      v_height := (v_media ->> 'height')::integer;
    end if;
  end if;

  if p_from_me is null
    or p_sender_jid is null or p_sender_jid !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$'
    or p_occurred_at is null
    or coalesce(char_length(v_body), 0) > 8000
    or (v_media is null and v_body is null) then
    update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
    return jsonb_build_object('result', 'ignored');
  end if;

  v_preview := private.message_preview(v_body, v_kind, v_voice, v_file_name);

  if p_from_me then
    perform 1 from public.messages m
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id
      and m.source_engine = 'baileys' and m.provider_message_id = p_event_id;
    if found then
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      return jsonb_build_object('result', 'duplicate');
    end if;
  end if;

  v_phone := '+' || split_part(p_sender_jid, '@', 1);
  v_display_name := case when p_from_me then '' else coalesce(nullif(left(btrim(p_push_name), 160), ''), '') end;

  insert into public.contacts(workspace_id, instance_id, channel, external_user_id, display_name, phone_e164)
  values (v_workspace_id, v_instance_id, 'whatsapp', p_sender_jid, v_display_name, v_phone)
  on conflict (workspace_id, channel, instance_id, external_user_id)
    where external_user_id is not null and erased_at is null
  do update set
    display_name = case when public.contacts.display_name in ('','Contato') and excluded.display_name <> ''
                        then excluded.display_name else public.contacts.display_name end,
    phone_e164 = coalesce(public.contacts.phone_e164, excluded.phone_e164),
    updated_at = now()
  returning id into v_contact_id;

  perform 1 from public.contacts where workspace_id = v_workspace_id and id = v_contact_id for update;

  if p_from_me then
    select m.id, m.conversation_id into v_candidate_id, v_conversation_id
    from public.messages m
    join public.conversations c on c.workspace_id = m.workspace_id and c.id = m.conversation_id
    left join public.message_attachments a on a.workspace_id = m.workspace_id and a.message_id = m.id
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id and c.contact_id = v_contact_id
      and m.direction = 'outbound' and m.source_engine = 'baileys'
      and m.provider_message_id is null and m.idempotency_key is not null
      and m.status in ('sending','awaiting_human_confirmation','sent')
      and ((v_kind is null and a.id is null and m.body_text = v_body)
        or (v_kind is not null and a.kind = v_kind and m.body_text is not distinct from v_body))
      and m.created_at > now() - case when m.status = 'sent' then interval '15 minutes' else interval '2 hours' end
    order by (m.status = 'sent'), m.created_at desc, m.id
    limit 1;
  end if;

  if v_conversation_id is not null then
    perform 1 from public.conversations c
    where c.workspace_id = v_workspace_id and c.id = v_conversation_id
    for update;
  else
    select c.id into v_conversation_id
    from public.conversations c
    where c.workspace_id = v_workspace_id and c.contact_id = v_contact_id and c.instance_id = v_instance_id
      and c.stage not in ('resolved','archived')
    order by c.activity_at desc, c.id desc
    limit 1
    for update;
    if v_conversation_id is null then
      insert into public.conversations(workspace_id, contact_id, instance_id, stage, last_message_at, last_message_preview, unread_count)
      values (v_workspace_id, v_contact_id, v_instance_id, case when p_from_me then 'waiting_customer' else 'new' end,
        p_occurred_at, v_preview, 0)
      returning id into v_conversation_id;
      v_created := true;
    end if;
  end if;

  if p_from_me then
    perform 1 from public.messages m
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id
      and m.source_engine = 'baileys' and m.provider_message_id = p_event_id;
    if found then
      if v_created then
        delete from public.conversations where workspace_id = v_workspace_id and id = v_conversation_id;
      end if;
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      return jsonb_build_object('result', 'duplicate');
    end if;

    if v_candidate_id is not null then
      update public.messages m
      set status = 'sent', provider_message_id = p_event_id
      where m.workspace_id = v_workspace_id and m.id = v_candidate_id
        and m.provider_message_id is null and m.status in ('sending','awaiting_human_confirmation','sent')
      returning m.id, m.actor_type into v_message_id, v_adopted_actor;
      v_adopted := v_message_id is not null;
    end if;
  end if;

  if not v_adopted then
    v_message_id := gen_random_uuid();
    if v_kind is not null then
      v_object_key := v_workspace_id::text || '/' || v_conversation_id::text || '/' || v_message_id::text
        || '/' || private.safe_object_name(v_file_name, v_kind);
      v_media_status := case when coalesce(v_size, 0) > 26214400 then 'too_large' else 'pending' end;
      v_keep_until := private.media_keep_until(v_workspace_id);
    end if;

    insert into public.messages(id, workspace_id, conversation_id, instance_id, provider_message_id, direction,
      source_engine, actor_type, status, body_text, media_object_key, occurred_at)
    values (v_message_id, v_workspace_id, v_conversation_id, v_instance_id, p_event_id,
      case when p_from_me then 'outbound' else 'inbound' end, 'baileys',
      case when p_from_me then 'human' else 'contact' end,
      case when p_from_me then 'sent' else 'received' end,
      v_body, v_object_key, p_occurred_at);

    if v_kind is not null then
      insert into public.message_attachments(workspace_id, message_id, object_key, content_type, byte_size, kind,
        file_name, duration_seconds, width, height, is_voice, storage_status, retention_delete_after)
      values (v_workspace_id, v_message_id, v_object_key, v_mime, coalesce(v_size, 0), v_kind,
        v_file_name, v_duration, v_width, v_height, v_voice, v_media_status, v_keep_until);
    end if;
  end if;

  if p_from_me then
    if v_adopted and v_adopted_actor = 'ai' then
      perform private.touch_conversation_after_ai_reply(v_workspace_id, v_conversation_id, v_preview, p_occurred_at);
    else
      perform private.touch_conversation_after_outbound(v_workspace_id, v_conversation_id, v_preview, p_occurred_at);
      if v_adopted or not exists (
        select 1 from public.messages m
        where m.workspace_id = v_workspace_id and m.conversation_id = v_conversation_id
          and m.direction = 'outbound' and m.actor_type = 'ai' and m.status = 'sending'
          and m.provider_message_id is null and m.created_at > clock_timestamp() - interval '2 minutes') then
        perform private.note_human_reply(v_workspace_id, v_conversation_id, p_occurred_at);
      end if;
    end if;
  else
    update public.conversations
    set last_message_preview = case when last_message_at is null or p_occurred_at >= last_message_at
                                    then v_preview else last_message_preview end,
        last_message_at = greatest(coalesce(last_message_at, p_occurred_at), p_occurred_at),
        unread_count = unread_count + 1,
        stage = case when stage = 'waiting_customer' then 'human' else stage end
    where workspace_id = v_workspace_id and id = v_conversation_id;
    v_ai := private.schedule_ai_turn(v_workspace_id, v_conversation_id, v_instance_id, v_message_id, p_occurred_at);
  end if;

  update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
  update public.local_executors set status = 'active', last_seen_at = clock_timestamp() where id = v_auth.executor_id;

  return jsonb_build_object(
    'result', 'accepted',
    'workspace_id', v_workspace_id,
    'instance_id', v_instance_id,
    'contact_id', v_contact_id,
    'conversation_id', v_conversation_id,
    'message_id', v_message_id,
    'direction', case when p_from_me then 'outbound' else 'inbound' end,
    'adopted', v_adopted,
    'media', case when v_media_status is not null
                  then jsonb_build_object('object_key', v_object_key, 'status', v_media_status) end,
    'ai', v_ai
  );
end;
$$;

-- Validação para o endpoint /api/motor/midia: confirma que o arquivo pertence ao mesmo workspace do executor
-- e devolve as permissões seguras para upload de mídia recebida ou download de mídia a enviar.
create or replace function public.authorize_local_motor_media(
  p_token_sha256 text,
  p_message_id uuid,
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_msg public.messages%rowtype;
  v_att public.message_attachments%rowtype;
begin
  select * into v_auth from private.auth_local_executor(p_token_sha256);
  if not found then
    return jsonb_build_object('result', 'unauthorized');
  end if;
  if p_mode is null or p_mode not in ('inbound_upload','outbound_download') then
    raise exception 'Invalid media mode' using errcode = '22023';
  end if;

  select m.* into v_msg
  from public.messages m
  join public.instances i on i.workspace_id = m.workspace_id and i.id = m.instance_id
  where m.workspace_id = v_auth.workspace_id
    and m.id = p_message_id
    and i.local_executor_id = v_auth.executor_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select a.* into v_att
  from public.message_attachments a
  where a.workspace_id = v_auth.workspace_id and a.message_id = p_message_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'workspace_id', v_auth.workspace_id,
    'message_id', v_msg.id,
    'object_key', v_att.object_key,
    'content_type', v_att.content_type,
    'file_name', v_att.file_name,
    'kind', v_att.kind,
    'storage_status', v_att.storage_status
  );
end;
$$;

revoke all on function public.pair_local_executor_by_code(text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.authenticate_local_executor_heartbeat(text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.claim_local_motor_commands(text,integer) from public, anon, authenticated;
revoke all on function public.report_local_instance_state(text,uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.complete_local_motor_command(text,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.ingest_local_message(text,uuid,text,text,text,text,timestamptz,boolean,jsonb) from public, anon, authenticated;
revoke all on function public.authorize_local_motor_media(text,uuid,text) from public, anon, authenticated;

grant execute on function public.pair_local_executor_by_code(text,text,text,text,jsonb) to service_role;
grant execute on function public.authenticate_local_executor_heartbeat(text,text,text,jsonb) to service_role;
grant execute on function public.claim_local_motor_commands(text,integer) to service_role;
grant execute on function public.report_local_instance_state(text,uuid,text,text,text,text) to service_role;
grant execute on function public.complete_local_motor_command(text,uuid,text,text,text) to service_role;
grant execute on function public.ingest_local_message(text,uuid,text,text,text,text,timestamptz,boolean,jsonb) to service_role;
grant execute on function public.authorize_local_motor_media(text,uuid,text) to service_role;

-- 8) Estender Inbox (texto, mídia, conclusão), IA e Agendamentos para aceitar chips Baileys com aparelho vinculado.
--    Chips Evolution mantêm EXATAMENTE o mesmo JSON de retorno (preservando todos os contratos existentes).
create or replace function private.finish_outbound_message(
  p_workspace_id uuid,
  p_message_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_actor uuid,
  p_actor_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_message public.messages%rowtype;
  v_other public.messages%rowtype;
  v_attachment public.message_attachments%rowtype;
  v_previous_status text;
  v_new_status text;
  v_provider_id text := p_provider_message_id;
begin
  if p_outcome is null or p_outcome not in ('sent','failed','uncertain') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;
  if v_provider_id is not null and char_length(v_provider_id) not between 1 and 200 then
    raise exception 'Invalid provider message id' using errcode = '22023';
  end if;

  select m.conversation_id into v_conversation_id
  from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id and m.direction = 'outbound';
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_conversation_id
  for update;

  select m.* into v_message
  from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id and m.direction = 'outbound'
  for update;
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  v_previous_status := v_message.status;

  if p_outcome = 'sent' and v_provider_id is not null
    and v_previous_status in ('sending','awaiting_human_confirmation','sent')
    and v_message.provider_message_id is distinct from v_provider_id then
    select m.* into v_other
    from public.messages m
    where m.workspace_id = p_workspace_id and m.instance_id = v_message.instance_id
      and m.source_engine = v_message.source_engine and m.provider_message_id = v_provider_id and m.id <> v_message.id
    for update;
    if found then
      if v_other.direction <> 'outbound' then
        v_provider_id := null;
      elsif v_other.idempotency_key is null then
        delete from public.message_attachments d where d.workspace_id = p_workspace_id and d.message_id = v_other.id;
        delete from public.messages d where d.workspace_id = p_workspace_id and d.id = v_other.id;
      else
        update public.messages
        set provider_message_id = null,
            status = case when status = 'sent' then 'awaiting_human_confirmation' else status end
        where workspace_id = p_workspace_id and id = v_other.id;
      end if;
    end if;
  end if;

  if v_previous_status = 'sent' then
    if p_outcome = 'sent' and v_provider_id is not null and v_message.provider_message_id is distinct from v_provider_id then
      update public.messages set provider_message_id = v_provider_id
      where workspace_id = p_workspace_id and id = v_message.id;
    end if;
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', false);
  end if;
  if v_previous_status not in ('sending','awaiting_human_confirmation')
    or (v_previous_status = 'awaiting_human_confirmation' and p_outcome = 'uncertain') then
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', false);
  end if;

  v_new_status := case p_outcome when 'sent' then 'sent' when 'failed' then 'failed' else 'awaiting_human_confirmation' end;

  update public.messages
  set status = v_new_status,
      provider_message_id = case when p_outcome = 'sent' then coalesce(v_provider_id, provider_message_id)
                                 else provider_message_id end
  where workspace_id = p_workspace_id and id = v_message.id
  returning * into v_message;

  if v_new_status = 'sent' then
    select a.* into v_attachment
    from public.message_attachments a
    where a.workspace_id = p_workspace_id and a.message_id = v_message.id;
    if v_message.actor_type = 'ai' then
      perform private.touch_conversation_after_ai_reply(p_workspace_id, v_conversation_id,
        private.message_preview(v_message.body_text, v_attachment.kind, v_attachment.is_voice, v_attachment.file_name),
        v_message.occurred_at);
    else
      perform private.touch_conversation_after_outbound(p_workspace_id, v_conversation_id,
        private.message_preview(v_message.body_text, v_attachment.kind, v_attachment.is_voice, v_attachment.file_name),
        v_message.occurred_at);
    end if;
  else
    update public.conversations set updated_at = now()
    where workspace_id = p_workspace_id and id = v_conversation_id;
  end if;

  -- A conversa tinha ido para uma pessoa porque não deu para confirmar o envio da IA, e a pessoa conferiu no
  -- WhatsApp que a mensagem chegou: o motivo do repasse acabou.
  if v_message.actor_type = 'ai' and p_actor is not null
    and v_previous_status = 'awaiting_human_confirmation' and v_new_status = 'sent' then
    update public.conversations c
    set ai_paused_until = null, ai_pause_reason = null, ai_handoff_at = null, ai_handoff_note = null,
        stage = case when x.answered and c.stage = 'waiting_human' then 'ai' else c.stage end,
        unread_count = case when x.answered then 0 else c.unread_count end
    from (
      select not exists (
        select 1 from public.messages n
        where n.workspace_id = p_workspace_id and n.conversation_id = v_conversation_id
          and n.direction = 'inbound' and n.created_at > v_message.created_at) as answered
    ) x
    where c.workspace_id = p_workspace_id and c.id = v_conversation_id
      and c.ai_pause_reason = 'uncertain_send' and not c.automation_paused;
  end if;

  -- Uma pessoa respondeu pelo painel (tenha a mensagem saído ou não): a IA para nesta conversa.
  if v_message.actor_type = 'human' then
    perform private.note_human_reply(p_workspace_id, v_conversation_id, clock_timestamp());
  end if;

  if v_new_status <> 'sent' or v_previous_status = 'awaiting_human_confirmation' then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,p_actor,p_actor_kind,'message_send_' || p_outcome,'message',v_message.id::text,
      jsonb_build_object('from',v_previous_status,'to',v_new_status));
  end if;

  return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', true);
end;
$$;
revoke all on function private.finish_outbound_message(uuid, uuid, text, text, uuid, text) from public, anon, authenticated;

create or replace function public.start_my_text_message(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_body_text text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_body text := btrim(coalesce(p_body_text, ''));
  v_conversation public.conversations%rowtype;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_message public.messages%rowtype;
  v_command_id uuid;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 4096 then
    raise exception 'Invalid message text' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[a-zA-Z0-9_-]{16,80}$' then
    raise exception 'Invalid idempotency key' using errcode = '22023';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id
  for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;

  select m.* into v_message
  from public.messages m
  where m.workspace_id = p_workspace_id and m.idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', true,
      'body_text', v_message.body_text);
  end if;

  if v_conversation.stage in ('resolved','archived') then
    raise exception 'conversation_closed' using errcode = 'P0001';
  end if;

  select i.* into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_conversation.instance_id;
  if not found or v_instance.status = 'revoked'
    or not (
      (v_instance.engine = 'evolution' and v_instance.provider_instance_name is not null)
      or (v_instance.engine = 'baileys' and v_instance.local_executor_id is not null)
    ) then
    raise exception 'instance_unavailable' using errcode = 'P0001';
  end if;
  if v_instance.status <> 'connected' then
    raise exception 'instance_not_connected' using errcode = 'P0001';
  end if;

  select ct.* into v_contact
  from public.contacts ct
  where ct.workspace_id = p_workspace_id and ct.id = v_conversation.contact_id;
  if not found or v_contact.erased_at is not null or v_contact.external_user_id is null
    or v_contact.external_user_id !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$' then
    raise exception 'contact_unreachable' using errcode = 'P0001';
  end if;

  insert into public.messages(workspace_id,conversation_id,instance_id,idempotency_key,direction,
    source_engine,actor_type,status,body_text,occurred_at,sent_by)
  values (p_workspace_id,p_conversation_id,v_instance.id,p_idempotency_key,'outbound',
    v_instance.engine,'human','sending',v_body,now(),v_actor)
  returning * into v_message;

  if v_instance.engine = 'baileys' then
    insert into public.local_motor_commands(
      workspace_id, executor_id, instance_id, command_type, payload, message_id
    )
    values (
      p_workspace_id,
      v_instance.local_executor_id,
      v_instance.id,
      'send_text',
      jsonb_build_object('recipient', v_contact.external_user_id, 'body_text', v_body),
      v_message.id
    )
    returning id into v_command_id;

    return jsonb_build_object(
      'message_id', v_message.id,
      'status', v_message.status,
      'already_exists', false,
      'engine', 'baileys',
      'command_id', v_command_id,
      'recipient', v_contact.external_user_id,
      'body_text', v_body
    );
  end if;

  return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', false,
    'provider_instance_name', v_instance.provider_instance_name,
    'recipient', v_contact.external_user_id, 'body_text', v_body);
end;
$$;

create or replace function public.start_my_media_message(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_idempotency_key text,
  p_object_key text,
  p_kind text,
  p_file_name text,
  p_caption text,
  p_duration_seconds integer,
  p_width integer,
  p_height integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_caption text := nullif(btrim(coalesce(p_caption, '')), '');
  v_file_name text := nullif(left(btrim(coalesce(p_file_name, '')), 200), '');
  v_conversation public.conversations%rowtype;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_message public.messages%rowtype;
  v_attachment public.message_attachments%rowtype;
  v_metadata jsonb;
  v_size bigint;
  v_mime text;
  v_command_id uuid;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[a-zA-Z0-9_-]{16,80}$' then
    raise exception 'Invalid idempotency key' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('image','audio','video','document') then
    raise exception 'Invalid media kind' using errcode = '22023';
  end if;
  if coalesce(char_length(v_caption), 0) > 1024 or (p_kind = 'audio' and v_caption is not null) then
    raise exception 'Invalid caption' using errcode = '22023';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id
  for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;

  select m.* into v_message
  from public.messages m
  where m.workspace_id = p_workspace_id and m.idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', true);
  end if;

  if v_conversation.stage in ('resolved','archived') then
    raise exception 'conversation_closed' using errcode = 'P0001';
  end if;

  select i.* into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_conversation.instance_id;
  if not found or v_instance.status = 'revoked'
    or not (
      (v_instance.engine = 'evolution' and v_instance.provider_instance_name is not null)
      or (v_instance.engine = 'baileys' and v_instance.local_executor_id is not null)
    ) then
    raise exception 'instance_unavailable' using errcode = 'P0001';
  end if;
  if v_instance.status <> 'connected' then
    raise exception 'instance_not_connected' using errcode = 'P0001';
  end if;

  select ct.* into v_contact
  from public.contacts ct
  where ct.workspace_id = p_workspace_id and ct.id = v_conversation.contact_id;
  if not found or v_contact.erased_at is not null or v_contact.external_user_id is null
    or v_contact.external_user_id !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$' then
    raise exception 'contact_unreachable' using errcode = 'P0001';
  end if;

  if p_object_key is null
    or p_object_key !~ ('^' || p_workspace_id::text || '/' || p_conversation_id::text || '/envios/'
      || p_idempotency_key || '/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$') then
    raise exception 'Invalid media path' using errcode = '22023';
  end if;
  select o.metadata into v_metadata
  from storage.objects o
  where o.bucket_id = 'midias' and o.name = p_object_key;
  if not found then raise exception 'media_not_uploaded' using errcode = 'P0001'; end if;

  v_size := case when (v_metadata ->> 'size') ~ '^[0-9]{1,15}$' then (v_metadata ->> 'size')::bigint else 0 end;
  v_mime := lower(left(split_part(coalesce(v_metadata ->> 'mimetype', ''), ';', 1), 120));
  if v_mime !~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' then v_mime := 'application/octet-stream'; end if;
  if v_size < 1 then
    raise exception 'media_empty' using errcode = 'P0001';
  end if;
  if v_size > (case when p_kind = 'document' then 26214400 else 16777216 end) then
    raise exception 'media_too_large' using errcode = 'P0001';
  end if;
  if (p_kind = 'image' and v_mime not in ('image/jpeg','image/png','image/webp'))
    or (p_kind = 'video' and v_mime <> 'video/mp4')
    or (p_kind = 'audio' and v_mime !~ '^audio/') then
    raise exception 'media_type_mismatch' using errcode = 'P0001';
  end if;

  insert into public.messages(workspace_id,conversation_id,instance_id,idempotency_key,direction,
    source_engine,actor_type,status,body_text,media_object_key,occurred_at,sent_by)
  values (p_workspace_id,p_conversation_id,v_instance.id,p_idempotency_key,'outbound',
    v_instance.engine,'human','sending',v_caption,p_object_key,now(),v_actor)
  returning * into v_message;

  insert into public.message_attachments(workspace_id,message_id,object_key,content_type,byte_size,kind,
    file_name,duration_seconds,width,height,is_voice,storage_status,retention_delete_after)
  values (p_workspace_id,v_message.id,p_object_key,v_mime,v_size,p_kind,v_file_name,
    case when p_duration_seconds between 0 and 86400 then p_duration_seconds end,
    case when p_width between 1 and 20000 then p_width end,
    case when p_height between 1 and 20000 then p_height end,
    p_kind = 'audio','stored',private.media_keep_until(p_workspace_id))
  returning * into v_attachment;

  if v_instance.engine = 'baileys' then
    insert into public.local_motor_commands(
      workspace_id, executor_id, instance_id, command_type, payload, message_id
    )
    values (
      p_workspace_id,
      v_instance.local_executor_id,
      v_instance.id,
      'send_media',
      jsonb_build_object(
        'recipient', v_contact.external_user_id,
        'object_key', p_object_key,
        'kind', p_kind,
        'content_type', v_mime,
        'byte_size', v_size,
        'file_name', v_file_name,
        'caption', v_caption
      ),
      v_message.id
    )
    returning id into v_command_id;

    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', false,
      'engine', 'baileys', 'command_id', v_command_id,
      'recipient', v_contact.external_user_id, 'object_key', p_object_key, 'kind', p_kind,
      'content_type', v_mime, 'byte_size', v_size, 'file_name', v_file_name, 'caption', v_caption);
  end if;

  return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', false,
    'provider_instance_name', v_instance.provider_instance_name, 'recipient', v_contact.external_user_id,
    'object_key', p_object_key, 'kind', p_kind, 'content_type', v_mime, 'byte_size', v_size,
    'file_name', v_file_name, 'caption', v_caption);
end;
$$;

-- Atendente de IA para Evolution E Baileys com aparelho vinculado.
create or replace function private.ai_block_reason(p_workspace_id uuid, p_conversation_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_instance public.instances%rowtype;
  v_executor public.local_executors%rowtype;
  v_contact public.contacts%rowtype;
begin
  select c.* into v_conversation
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
  if not found then return 'conversation_missing'; end if;

  if exists (select 1 from public.workspace_ai_state s where s.workspace_id = p_workspace_id and s.paused) then
    return 'workspace_paused';
  end if;

  select i.* into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_conversation.instance_id;
  if not found or v_instance.status = 'revoked'
    or not (
      (v_instance.engine = 'evolution' and v_instance.provider_instance_name is not null)
      or (v_instance.engine = 'baileys' and v_instance.local_executor_id is not null)
    ) then
    return 'chip_unavailable';
  end if;
  if not v_instance.is_enabled then return 'chip_ai_off'; end if;
  if v_instance.status <> 'connected' then return 'chip_not_connected'; end if;

  if v_instance.engine = 'baileys' then
    select e.* into v_executor
    from public.local_executors e
    where e.workspace_id = p_workspace_id and e.id = v_instance.local_executor_id;
    if not found or v_executor.status <> 'active'
      or v_executor.last_seen_at is null
      or v_executor.last_seen_at < clock_timestamp() - interval '2 minutes' then
      return 'executor_offline';
    end if;
  end if;

  if v_conversation.stage in ('resolved','archived') then return 'conversation_closed'; end if;
  if v_conversation.automation_paused
    or (v_conversation.ai_paused_until is not null and v_conversation.ai_paused_until > clock_timestamp()) then
    return 'conversation_paused';
  end if;

  select ct.* into v_contact
  from public.contacts ct
  where ct.workspace_id = p_workspace_id and ct.id = v_conversation.contact_id;
  if not found or v_contact.erased_at is not null or v_contact.external_user_id is null
    or v_contact.external_user_id !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$' then
    return 'contact_unreachable';
  end if;
  if v_contact.ai_ignored or v_contact.is_blocked then
    return 'contact_ignored';
  end if;

  if exists (
    select 1 from public.instances o
    where o.workspace_id = p_workspace_id and o.status <> 'revoked' and o.connected_phone is not null
      and private.phone_core(o.connected_phone) = private.phone_core(v_contact.external_user_id)) then
    return 'own_chip';
  end if;

  return null;
end;
$$;
revoke all on function private.ai_block_reason(uuid, uuid) from public, anon, authenticated;

create or replace function public.set_my_instance_ai(p_workspace_id uuid, p_instance_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_instance public.instances%rowtype;
  v_missing text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'Invalid value' using errcode = '22023';
  end if;

  select i.* into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = p_instance_id and i.status <> 'revoked'
  for update;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  if v_instance.is_enabled = p_enabled then
    return jsonb_build_object('id', v_instance.id, 'is_enabled', v_instance.is_enabled, 'changed', false);
  end if;

  if p_enabled then
    if not (
      (v_instance.engine = 'evolution' and v_instance.provider_instance_name is not null)
      or (v_instance.engine = 'baileys' and v_instance.local_executor_id is not null)
    ) then
      raise exception 'instance_unavailable' using errcode = 'P0001';
    end if;
    v_missing := private.ai_missing_setup(p_workspace_id, p_instance_id);
    if v_missing is not null then
      raise exception '%', v_missing using errcode = 'P0001';
    end if;
  else
    perform 1 from public.conversations c
    where c.workspace_id = p_workspace_id
      and c.id in (select t.conversation_id from public.ai_turns t
                   where t.workspace_id = p_workspace_id and t.instance_id = p_instance_id and t.status = 'waiting')
    order by c.id
    for update;
    with cancelled as (
      update public.ai_turns
      set status = 'skipped', finished_at = clock_timestamp(), outcome_detail = 'chip_ai_off'
      where workspace_id = p_workspace_id and instance_id = p_instance_id and status = 'waiting'
      returning conversation_id
    )
    update public.conversations c set stage = 'waiting_human'
    from cancelled x
    where c.workspace_id = p_workspace_id and c.id = x.conversation_id and c.stage = 'ai';
  end if;

  update public.instances set is_enabled = p_enabled
  where workspace_id = p_workspace_id and id = p_instance_id
  returning * into v_instance;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner',case when p_enabled then 'instance_ai_enabled' else 'instance_ai_disabled' end,
    'instance',v_instance.id::text,jsonb_build_object('display_name',v_instance.display_name));

  return jsonb_build_object('id', v_instance.id, 'is_enabled', v_instance.is_enabled, 'changed', true);
end;
$$;

create or replace function public.start_ai_message(p_workspace_id uuid, p_turn_id uuid, p_part integer, p_body_text text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_turns%rowtype;
  v_body text := private.trim_text(coalesce(p_body_text, ''));
  v_key text;
  v_message public.messages%rowtype;
  v_reason text;
  v_next public.ai_turns%rowtype;
  v_instance public.instances%rowtype;
  v_recipient text;
  v_command_id uuid;
begin
  if p_part is null or p_part not between 1 and 5 then
    raise exception 'Invalid part' using errcode = '22023';
  end if;
  if char_length(v_body) not between 1 and 4096 then
    raise exception 'Invalid message text' using errcode = '22023';
  end if;

  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id;
  if not found then raise exception 'Turn not found' using errcode = 'P0002'; end if;
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id
  for update;
  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id for update;

  v_key := 'ia-' || replace(v_turn.id::text, '-', '') || '-' || p_part::text;
  select m.* into v_message from public.messages m
  where m.workspace_id = p_workspace_id and m.idempotency_key = v_key;
  if found then
    return jsonb_build_object('result','already_exists','message_id',v_message.id,'status',v_message.status);
  end if;

  if v_turn.status <> 'running' then
    return jsonb_build_object('result','aborted','reason','turn_' || v_turn.status);
  end if;

  v_reason := private.ai_block_reason(p_workspace_id, v_turn.conversation_id);
  if v_reason is null and exists (
    select 1 from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = v_turn.conversation_id
      and m.direction = 'outbound' and m.actor_type = 'human' and m.status = 'sending'
      and m.created_at > clock_timestamp() - interval '90 seconds') then
    v_reason := 'human_replying';
  end if;
  if v_reason is null and p_part = 1 then
    select w.* into v_next from public.ai_turns w
    where w.workspace_id = p_workspace_id and w.conversation_id = v_turn.conversation_id and w.status = 'waiting';
    if found then v_reason := 'superseded'; end if;
  end if;

  if v_reason is not null then
    update public.ai_turns
    set status = case when p_part = 1 then 'skipped' else 'answered' end,
        finished_at = clock_timestamp(),
        outcome_detail = left(case when p_part = 1 then v_reason
                                   else 'stopped_after_part_' || (p_part - 1)::text || ':' || v_reason end, 300)
    where workspace_id = p_workspace_id and id = v_turn.id;
    if p_part = 1 and v_reason <> 'superseded' then
      update public.conversations set stage = 'waiting_human'
      where workspace_id = p_workspace_id and id = v_turn.conversation_id and stage = 'ai' and unread_count > 0;
    end if;
    return jsonb_build_object('result','aborted','reason',v_reason,
      'next', case when v_reason = 'superseded' then jsonb_build_object('turn_id', v_next.id,
        'trigger_message_id', v_next.trigger_message_id,
        'wait_ms', greatest(ceil(extract(epoch from (v_next.due_at - clock_timestamp())) * 1000)::integer, 0)) end);
  end if;

  select i.* into v_instance from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_turn.instance_id;
  select ct.external_user_id into v_recipient
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id;

  insert into public.messages(workspace_id,conversation_id,instance_id,idempotency_key,direction,
    source_engine,actor_type,status,body_text,occurred_at)
  values (p_workspace_id,v_turn.conversation_id,v_turn.instance_id,v_key,'outbound',
    v_instance.engine,'ai','sending',v_body,clock_timestamp())
  returning * into v_message;

  if v_instance.engine = 'baileys' then
    insert into public.local_motor_commands(
      workspace_id, executor_id, instance_id, command_type, payload, message_id
    )
    values (
      p_workspace_id,
      v_instance.local_executor_id,
      v_instance.id,
      'send_text',
      jsonb_build_object('recipient', v_recipient, 'body_text', v_body),
      v_message.id
    )
    returning id into v_command_id;

    return jsonb_build_object(
      'result', 'queued_local',
      'message_id', v_message.id,
      'command_id', v_command_id,
      'recipient', v_recipient
    );
  end if;

  return jsonb_build_object('result','started','message_id',v_message.id,
    'provider_instance_name',v_instance.provider_instance_name,'recipient',v_recipient);
end;
$$;

-- Agendamento de mensagens também funciona nos chips do Motor local.
create or replace function public.schedule_my_message(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_body_text text,
  p_scheduled_for timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_body text := btrim(coalesce(p_body_text, ''));
  v_conv public.conversations%rowtype;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_row public.scheduled_messages%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 4096 then
    raise exception 'Invalid message text' using errcode = '22023';
  end if;
  if p_scheduled_for is null or p_scheduled_for < now() - interval '1 minute' or p_scheduled_for > now() + interval '366 days' then
    raise exception 'invalid_schedule_time' using errcode = '22023';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  select * into v_conv from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  if v_conv.stage = 'archived' then raise exception 'conversation_closed' using errcode = 'P0001'; end if;

  select * into v_instance from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_conv.instance_id;
  if not found or v_instance.status = 'revoked'
    or not (
      v_instance.engine = 'evolution'
      or (v_instance.engine = 'baileys' and v_instance.local_executor_id is not null)
    ) then
    raise exception 'instance_unavailable' using errcode = 'P0001';
  end if;

  select * into v_contact from public.contacts ct
  where ct.workspace_id = p_workspace_id and ct.id = v_conv.contact_id;
  if not found or v_contact.erased_at is not null or v_contact.external_user_id is null
    or v_contact.external_user_id !~ '^[1-9][0-9]{7,14}@s[.]whatsapp[.]net$' then
    raise exception 'contact_unreachable' using errcode = 'P0001';
  end if;

  insert into public.scheduled_messages(
    workspace_id, conversation_id, instance_id, created_by, body_text, scheduled_for, status
  )
  values (
    p_workspace_id, p_conversation_id, v_conv.instance_id, v_actor, v_body, p_scheduled_for, 'pending'
  )
  returning * into v_row;

  update public.conversations set updated_at = now()
  where workspace_id = p_workspace_id and id = p_conversation_id;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'scheduled_message_created', 'conversation', p_conversation_id::text,
    jsonb_build_object('scheduled_id', v_row.id, 'scheduled_for', v_row.scheduled_for));

  return jsonb_build_object(
    'id', v_row.id,
    'body_text', v_row.body_text,
    'scheduled_for', v_row.scheduled_for,
    'status', v_row.status
  );
end;
$$;

create or replace function public.claim_due_scheduled_messages(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_rec public.scheduled_messages%rowtype;
  v_conv public.conversations%rowtype;
  v_inst public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_msg_id uuid;
  v_command_id uuid;
  v_items jsonb := '[]'::jsonb;
begin
  for v_rec in
    select *
    from public.scheduled_messages s
    where s.status = 'pending' and s.scheduled_for <= clock_timestamp()
    order by s.scheduled_for asc, s.id asc
    limit v_limit
    for update skip locked
  loop
    update public.scheduled_messages set status = 'processing' where id = v_rec.id;

    select * into v_conv from public.conversations c
    where c.workspace_id = v_rec.workspace_id and c.id = v_rec.conversation_id for update;
    select * into v_inst from public.instances i
    where i.workspace_id = v_rec.workspace_id and i.id = v_rec.instance_id;
    select * into v_contact from public.contacts ct
    where ct.workspace_id = v_rec.workspace_id and ct.id = v_conv.contact_id;

    if not found or v_conv.id is null or v_conv.stage = 'archived' then
      update public.scheduled_messages set status = 'failed', error_detail = 'conversation_closed' where id = v_rec.id;
      continue;
    end if;
    if v_inst.id is null or v_inst.status <> 'connected'
      or not (
        (v_inst.engine = 'evolution' and v_inst.provider_instance_name is not null)
        or (v_inst.engine = 'baileys' and v_inst.local_executor_id is not null)
      ) then
      update public.scheduled_messages set status = 'failed', error_detail = 'instance_not_connected' where id = v_rec.id;
      continue;
    end if;
    if v_contact.erased_at is not null or v_contact.is_blocked or v_contact.external_user_id is null
      or v_contact.external_user_id !~ '^[1-9][0-9]{7,14}@s[.]whatsapp[.]net$' then
      update public.scheduled_messages set status = 'failed', error_detail = 'contact_unreachable' where id = v_rec.id;
      continue;
    end if;

    v_msg_id := gen_random_uuid();
    insert into public.messages(
      id, workspace_id, conversation_id, instance_id, direction, source_engine, actor_type,
      status, body_text, sent_by, idempotency_key, occurred_at
    )
    values (
      v_msg_id, v_rec.workspace_id, v_rec.conversation_id, v_rec.instance_id, 'outbound', v_inst.engine, 'human',
      'sending', v_rec.body_text, v_rec.created_by, 'sched:' || v_rec.id::text, clock_timestamp()
    )
    on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing;

    if not found then
      select m.id into v_msg_id from public.messages m
      where m.workspace_id = v_rec.workspace_id and m.idempotency_key = 'sched:' || v_rec.id::text;
      update public.scheduled_messages set status = 'failed', message_id = v_msg_id, error_detail = 'duplicate_guard' where id = v_rec.id;
      continue;
    end if;

    update public.scheduled_messages set message_id = v_msg_id where id = v_rec.id;

    if v_inst.engine = 'baileys' then
      insert into public.local_motor_commands(
        workspace_id, executor_id, instance_id, command_type, payload, message_id
      )
      values (
        v_rec.workspace_id,
        v_inst.local_executor_id,
        v_inst.id,
        'send_text',
        jsonb_build_object('recipient', v_contact.external_user_id, 'body_text', v_rec.body_text),
        v_msg_id
      )
      returning id into v_command_id;

      -- Para chip local, a mensagem entra imediatamente na fila durável do motor.
      update public.scheduled_messages set status = 'sent' where id = v_rec.id;

      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'scheduled_id', v_rec.id,
        'workspace_id', v_rec.workspace_id,
        'conversation_id', v_rec.conversation_id,
        'message_id', v_msg_id,
        'engine', 'baileys',
        'command_id', v_command_id,
        'recipient', v_contact.external_user_id,
        'body_text', v_rec.body_text
      ));
    else
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'scheduled_id', v_rec.id,
        'workspace_id', v_rec.workspace_id,
        'conversation_id', v_rec.conversation_id,
        'message_id', v_msg_id,
        'provider_instance_name', v_inst.provider_instance_name,
        'recipient', v_contact.external_user_id,
        'body_text', v_rec.body_text
      ));
    end if;
  end loop;

  return v_items;
end;
$$;

commit;
