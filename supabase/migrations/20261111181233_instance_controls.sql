begin;

-- Fase 1 (Instâncias): o que cada chip faz, o número conectado, o limite de chips por conta
-- e as ações do dono (criar, renomear, conferir, trocar segredo do aviso, remover).

alter table public.instances
  add column purpose text not null default 'attendance'
    check (purpose in ('attendance','campaigns','both')),
  add column connected_phone text
    check (connected_phone is null or connected_phone ~ '^[+][1-9][0-9]{5,19}$');

-- Quantos chips a conta pode ter. Só o servidor muda (o dono não tem permissão nesta coluna).
alter table public.workspaces
  add column max_instances integer not null default 1
    check (max_instances between 0 and 50);

-- As funções antigas de cadastro não respeitavam limite de chips e gravavam auditoria a cada
-- conferência. Saem; as novas ficam logo abaixo.
drop function if exists public.register_my_evolution_instance(uuid,text,text);
drop function if exists public.register_my_evolution_instance(uuid,text,text,text);
drop function if exists public.update_my_evolution_instance_state(uuid,uuid,text);

create or replace function private.evolution_state_to_status(p_provider_state text)
returns text language sql immutable set search_path = '' as $$
  select case p_provider_state
    when 'open' then 'connected'
    when 'connecting' then 'connecting'
    when 'close' then 'disconnected'
    when 'closed' then 'disconnected'
    when 'error' then 'error'
    else null
  end
$$;
revoke all on function private.evolution_state_to_status(text) from public, anon, authenticated;

-- Criar um chip (só o dono). Todo chip nasce desconectado e com a IA desligada.
create or replace function public.create_my_evolution_instance(
  p_workspace_id uuid,
  p_display_name text,
  p_purpose text,
  p_provider_instance_name text,
  p_webhook_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_limit integer;
  v_in_use integer;
  v_instance public.instances%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 60 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;
  if p_purpose is null or p_purpose not in ('attendance','campaigns','both') then
    raise exception 'Invalid purpose' using errcode = '22023';
  end if;
  if p_provider_instance_name is null or p_provider_instance_name !~ '^[a-zA-Z0-9_-]{3,100}$' then
    raise exception 'Invalid provider instance name' using errcode = '22023';
  end if;
  if p_webhook_token_sha256 is null or p_webhook_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid webhook token digest' using errcode = '22023';
  end if;

  -- Trava a conta: dois cliques ao mesmo tempo não passam do limite.
  select w.max_instances into v_limit
  from public.workspaces w
  where w.id = p_workspace_id and w.status = 'active'
  for update;
  if not found then raise exception 'Workspace not active' using errcode = '42501'; end if;

  select count(*) into v_in_use
  from public.instances i
  where i.workspace_id = p_workspace_id and i.status <> 'revoked';
  if v_in_use >= v_limit then
    raise exception 'instance_limit_reached' using errcode = 'P0001';
  end if;

  insert into public.instances(workspace_id,channel,engine,display_name,purpose,provider_instance_name,status,is_enabled)
  values (p_workspace_id,'whatsapp','evolution',btrim(p_display_name),p_purpose,p_provider_instance_name,'disconnected',false)
  returning * into v_instance;

  insert into private.evolution_webhook_auth(workspace_id,instance_id,token_sha256)
  values (p_workspace_id,v_instance.id,p_webhook_token_sha256);

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','instance_created','instance',v_instance.id::text,
    jsonb_build_object('engine','evolution','purpose',v_instance.purpose,'provider_instance_name',p_provider_instance_name));

  return jsonb_build_object('id',v_instance.id,'provider_instance_name',v_instance.provider_instance_name,
    'display_name',v_instance.display_name,'purpose',v_instance.purpose,'status',v_instance.status);
end;
$$;

-- Apelido e função do chip (só o dono).
create or replace function public.update_my_instance_settings(
  p_workspace_id uuid,
  p_instance_id uuid,
  p_display_name text,
  p_purpose text
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
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 60 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;
  if p_purpose is null or p_purpose not in ('attendance','campaigns','both') then
    raise exception 'Invalid purpose' using errcode = '22023';
  end if;

  update public.instances
  set display_name = btrim(p_display_name), purpose = p_purpose
  where workspace_id = p_workspace_id and id = p_instance_id and status <> 'revoked'
  returning * into v_instance;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','instance_settings_updated','instance',v_instance.id::text,
    jsonb_build_object('display_name',v_instance.display_name,'purpose',v_instance.purpose));

  return jsonb_build_object('id',v_instance.id,'display_name',v_instance.display_name,'purpose',v_instance.purpose);
end;
$$;

-- O painel pergunta o estado à Evolution e grava aqui (só o dono).
-- A auditoria só registra quando o estado muda de verdade.
create or replace function public.sync_my_evolution_instance(
  p_workspace_id uuid,
  p_instance_id uuid,
  p_provider_state text,
  p_connected_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_new_status text := private.evolution_state_to_status(p_provider_state);
  v_before public.instances%rowtype;
  v_after public.instances%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if v_new_status is null then
    raise exception 'Unsupported provider state' using errcode = '22023';
  end if;
  if p_connected_phone is not null and p_connected_phone !~ '^[+][1-9][0-9]{5,19}$' then
    raise exception 'Invalid connected phone' using errcode = '22023';
  end if;

  select i.* into v_before
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = p_instance_id
    and i.channel = 'whatsapp' and i.engine = 'evolution' and i.status <> 'revoked'
  for update;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  update public.instances
  set status = v_new_status,
      connected_phone = case when v_new_status = 'connected' then coalesce(p_connected_phone, connected_phone) else connected_phone end,
      last_seen_at = case when v_new_status = 'connected' then now() else last_seen_at end
  where workspace_id = p_workspace_id and id = p_instance_id
  returning * into v_after;

  if v_before.status is distinct from v_after.status then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,v_actor,'owner','instance_status_changed','instance',v_after.id::text,
      jsonb_build_object('from',v_before.status,'to',v_after.status,'source','owner_check'));
  end if;

  return jsonb_build_object('id',v_after.id,'status',v_after.status,
    'connected_phone',v_after.connected_phone,'last_seen_at',v_after.last_seen_at);
end;
$$;

-- Troca o segredo que a Evolution usa para avisar o painel (ex.: quando o endereço do painel muda).
-- Só o resumo (SHA-256) do segredo fica guardado.
create or replace function public.rotate_my_evolution_webhook_token(
  p_workspace_id uuid,
  p_instance_id uuid,
  p_webhook_token_sha256 text
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
  if p_webhook_token_sha256 is null or p_webhook_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid webhook token digest' using errcode = '22023';
  end if;
  perform 1 from public.instances i
  where i.workspace_id = p_workspace_id and i.id = p_instance_id
    and i.channel = 'whatsapp' and i.engine = 'evolution' and i.status <> 'revoked';
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  insert into private.evolution_webhook_auth(workspace_id,instance_id,token_sha256)
  values (p_workspace_id,p_instance_id,p_webhook_token_sha256)
  on conflict (instance_id) do update set token_sha256 = excluded.token_sha256, created_at = now();

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','instance_webhook_token_rotated','instance',p_instance_id::text,'{}'::jsonb);

  return jsonb_build_object('id',p_instance_id);
end;
$$;

-- Remover um chip (só o dono). As conversas e mensagens dele ficam guardadas;
-- o chip sai da lista e os avisos da Evolution deixam de ser aceitos.
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
  set status = 'revoked', is_enabled = false
  where workspace_id = p_workspace_id and id = p_instance_id and status <> 'revoked'
  returning * into v_instance;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  delete from private.evolution_webhook_auth
  where workspace_id = p_workspace_id and instance_id = p_instance_id;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','instance_removed','instance',v_instance.id::text,
    jsonb_build_object('engine',v_instance.engine,'provider_instance_name',v_instance.provider_instance_name));

  return jsonb_build_object('id',v_instance.id,'provider_instance_name',v_instance.provider_instance_name);
end;
$$;

-- Aviso de conexão que chega da Evolution (CONNECTION_UPDATE). Só o servidor chama.
create or replace function private.apply_evolution_connection_update(
  p_instance_name text,
  p_token_sha256 text,
  p_provider_state text,
  p_connected_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_status text := private.evolution_state_to_status(p_provider_state);
  v_before public.instances%rowtype;
  v_after public.instances%rowtype;
begin
  if p_instance_name is null or char_length(p_instance_name) > 100
    or p_token_sha256 is null or p_token_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('result','unauthorized');
  end if;

  select i.* into v_before
  from private.evolution_webhook_auth a
  join public.instances i on i.workspace_id = a.workspace_id and i.id = a.instance_id
  where i.provider_instance_name = p_instance_name
    and i.channel = 'whatsapp' and i.engine = 'evolution' and i.status <> 'revoked'
    and a.token_sha256 = p_token_sha256
  for update of i;
  if not found then return jsonb_build_object('result','unauthorized'); end if;

  if v_new_status is null
    or (p_connected_phone is not null and p_connected_phone !~ '^[+][1-9][0-9]{5,19}$') then
    return jsonb_build_object('result','ignored');
  end if;

  update public.instances
  set status = v_new_status,
      connected_phone = case when v_new_status = 'connected' then coalesce(p_connected_phone, connected_phone) else connected_phone end,
      last_seen_at = case when v_new_status = 'connected' then now() else last_seen_at end
  where workspace_id = v_before.workspace_id and id = v_before.id
  returning * into v_after;

  if v_before.status is distinct from v_after.status then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (v_after.workspace_id,null,'service','instance_status_changed','instance',v_after.id::text,
      jsonb_build_object('from',v_before.status,'to',v_after.status,'source','evolution_webhook'));
  end if;

  return jsonb_build_object('result','applied','workspace_id',v_after.workspace_id,
    'instance_id',v_after.id,'status',v_after.status);
end;
$$;

create or replace function public.apply_evolution_connection_update(
  p_instance_name text,
  p_token_sha256 text,
  p_provider_state text,
  p_connected_phone text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.apply_evolution_connection_update(p_instance_name,p_token_sha256,p_provider_state,p_connected_phone)
$$;

revoke all on function public.create_my_evolution_instance(uuid,text,text,text,text) from public, anon;
revoke all on function public.update_my_instance_settings(uuid,uuid,text,text) from public, anon;
revoke all on function public.sync_my_evolution_instance(uuid,uuid,text,text) from public, anon;
revoke all on function public.rotate_my_evolution_webhook_token(uuid,uuid,text) from public, anon;
revoke all on function public.remove_my_instance(uuid,uuid) from public, anon;
grant execute on function public.create_my_evolution_instance(uuid,text,text,text,text) to authenticated;
grant execute on function public.update_my_instance_settings(uuid,uuid,text,text) to authenticated;
grant execute on function public.sync_my_evolution_instance(uuid,uuid,text,text) to authenticated;
grant execute on function public.rotate_my_evolution_webhook_token(uuid,uuid,text) to authenticated;
grant execute on function public.remove_my_instance(uuid,uuid) to authenticated;

revoke all on function private.apply_evolution_connection_update(text,text,text,text) from public, anon, authenticated;
revoke all on function public.apply_evolution_connection_update(text,text,text,text) from public, anon, authenticated;
grant execute on function private.apply_evolution_connection_update(text,text,text,text) to service_role;
grant execute on function public.apply_evolution_connection_update(text,text,text,text) to service_role;

commit;
