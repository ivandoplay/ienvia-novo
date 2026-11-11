begin;

alter table public.instances add column if not exists provider_instance_name text;
create unique index if not exists instances_provider_instance_name_uq
  on public.instances(provider_instance_name)
  where provider_instance_name is not null;

create or replace function public.register_my_evolution_instance(
  p_workspace_id uuid,
  p_display_name text,
  p_provider_instance_name text
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
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 120 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;
  if p_provider_instance_name is null or p_provider_instance_name !~ '^[a-zA-Z0-9_-]{3,100}$' then
    raise exception 'Invalid provider instance name' using errcode = '22023';
  end if;

  insert into public.instances(workspace_id,channel,engine,display_name,provider_instance_name,status,is_enabled)
  values (p_workspace_id,'whatsapp','evolution',btrim(p_display_name),p_provider_instance_name,'disconnected',false)
  returning * into v_instance;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','evolution_instance_registered','instance',v_instance.id::text,
    jsonb_build_object('engine','evolution','provider_instance_name',p_provider_instance_name,'is_enabled',false));

  return jsonb_build_object('id',v_instance.id,'workspace_id',v_instance.workspace_id,
    'channel',v_instance.channel,'engine',v_instance.engine,'display_name',v_instance.display_name,
    'provider_instance_name',v_instance.provider_instance_name,'status',v_instance.status,
    'is_enabled',v_instance.is_enabled,'created_at',v_instance.created_at);
end;
$$;

create or replace function public.update_my_evolution_instance_state(
  p_workspace_id uuid,
  p_instance_id uuid,
  p_provider_state text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_instance public.instances%rowtype;
  v_new_state text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  v_new_state := case p_provider_state
    when 'open' then 'connected'
    when 'connecting' then 'connecting'
    when 'close' then 'disconnected'
    when 'closed' then 'disconnected'
    else 'error'
  end;
  if p_provider_state is null or p_provider_state not in ('open','connecting','close','closed','error') then
    raise exception 'Unsupported provider state' using errcode = '22023';
  end if;

  update public.instances
  set status = v_new_state,
      last_seen_at = case when v_new_state = 'connected' then now() else last_seen_at end
  where workspace_id = p_workspace_id and id = p_instance_id
    and channel = 'whatsapp' and engine = 'evolution'
  returning * into v_instance;
  if not found then raise exception 'Evolution instance not found' using errcode = 'P0002'; end if;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','evolution_instance_state_checked','instance',v_instance.id::text,
    jsonb_build_object('provider_state',p_provider_state,'stored_status',v_instance.status));

  return jsonb_build_object('id',v_instance.id,'status',v_instance.status,
    'is_enabled',v_instance.is_enabled,'last_seen_at',v_instance.last_seen_at);
end;
$$;

revoke all on function public.register_my_evolution_instance(uuid,text,text) from public, anon;
revoke all on function public.update_my_evolution_instance_state(uuid,uuid,text) from public, anon;
grant execute on function public.register_my_evolution_instance(uuid,text,text) to authenticated;
grant execute on function public.update_my_evolution_instance_state(uuid,uuid,text) to authenticated;

commit;
