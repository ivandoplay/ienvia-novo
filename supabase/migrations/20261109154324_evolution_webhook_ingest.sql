begin;

create table private.evolution_webhook_auth (
  workspace_id uuid not null,
  instance_id uuid primary key,
  token_sha256 text not null check (token_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete cascade,
  unique (workspace_id, instance_id)
);
revoke all on table private.evolution_webhook_auth from public, anon, authenticated;
grant all on table private.evolution_webhook_auth to service_role;

-- The webhook token is generated server-side. Only its SHA-256 digest is kept in the private schema.
-- Keep the prior 3-argument owner RPC during rollout so the currently deployed app remains compatible.
create or replace function public.register_my_evolution_instance(
  p_workspace_id uuid,
  p_display_name text,
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
  if p_webhook_token_sha256 is null or p_webhook_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid webhook token digest' using errcode = '22023';
  end if;

  insert into public.instances(workspace_id,channel,engine,display_name,provider_instance_name,status,is_enabled)
  values (p_workspace_id,'whatsapp','evolution',btrim(p_display_name),p_provider_instance_name,'disconnected',false)
  returning * into v_instance;

  insert into private.evolution_webhook_auth(workspace_id,instance_id,token_sha256)
  values (p_workspace_id,v_instance.id,p_webhook_token_sha256);

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','evolution_instance_registered','instance',v_instance.id::text,
    jsonb_build_object('engine','evolution','provider_instance_name',p_provider_instance_name,'is_enabled',false,'webhook_auth_configured',true));

  return jsonb_build_object('id',v_instance.id,'workspace_id',v_instance.workspace_id,
    'channel',v_instance.channel,'engine',v_instance.engine,'display_name',v_instance.display_name,
    'provider_instance_name',v_instance.provider_instance_name,'status',v_instance.status,
    'is_enabled',v_instance.is_enabled,'created_at',v_instance.created_at);
end;
$$;
revoke all on function public.register_my_evolution_instance(uuid,text,text,text) from public, anon;
grant execute on function public.register_my_evolution_instance(uuid,text,text,text) to authenticated;

create or replace function private.ingest_evolution_text(
  p_instance_name text,
  p_token_sha256 text,
  p_event_id text,
  p_event_type text,
  p_sender_jid text,
  p_push_name text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_from_me boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_instance_id uuid;
  v_webhook_event_id uuid;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_phone text;
  v_display_name text;
begin
  if p_instance_name is null or char_length(p_instance_name) > 100
    or p_token_sha256 is null or p_token_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('result','unauthorized');
  end if;

  select a.workspace_id, a.instance_id
  into v_workspace_id, v_instance_id
  from private.evolution_webhook_auth a
  join public.instances i on i.workspace_id = a.workspace_id and i.id = a.instance_id
  where i.provider_instance_name = p_instance_name
    and i.channel = 'whatsapp' and i.engine = 'evolution'
    and a.token_sha256 = p_token_sha256;
  if not found then return jsonb_build_object('result','unauthorized'); end if;

  if p_event_id is null or char_length(p_event_id) not between 1 and 200 then
    raise exception 'Invalid event id' using errcode = '22023';
  end if;
  if p_event_type is null or char_length(p_event_type) not between 1 and 80 then
    raise exception 'Invalid event type' using errcode = '22023';
  end if;

  insert into public.webhook_events(workspace_id,instance_id,engine,provider_event_id,event_type,processing_status)
  values (v_workspace_id,v_instance_id,'evolution',p_event_id,p_event_type,'received')
  on conflict (workspace_id,instance_id,engine,provider_event_id) do nothing
  returning id into v_webhook_event_id;
  if v_webhook_event_id is null then return jsonb_build_object('result','duplicate'); end if;

  if p_event_type <> 'MESSAGES_UPSERT' or coalesce(p_from_me,true)
    or p_sender_jid is null or p_sender_jid !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$'
    or p_body_text is null or char_length(btrim(p_body_text)) not between 1 and 8000
    or p_occurred_at is null then
    update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
    return jsonb_build_object('result','ignored');
  end if;

  v_phone := '+' || split_part(p_sender_jid,'@',1);
  v_display_name := coalesce(nullif(left(btrim(p_push_name),160),''),'Contato');

  insert into public.contacts(workspace_id,instance_id,channel,external_user_id,display_name,phone_e164)
  values (v_workspace_id,v_instance_id,'whatsapp',p_sender_jid,v_display_name,v_phone)
  on conflict (workspace_id,channel,instance_id,external_user_id)
    where external_user_id is not null and erased_at is null
  do update set
    display_name = case when public.contacts.display_name = '' then excluded.display_name else public.contacts.display_name end,
    phone_e164 = coalesce(public.contacts.phone_e164,excluded.phone_e164),
    updated_at = now()
  returning id into v_contact_id;

  perform 1 from public.contacts where workspace_id = v_workspace_id and id = v_contact_id for update;
  select c.id into v_conversation_id
  from public.conversations c
  where c.workspace_id = v_workspace_id and c.contact_id = v_contact_id and c.instance_id = v_instance_id
    and c.stage not in ('resolved','archived')
  order by c.activity_at desc, c.id desc
  limit 1
  for update;
  if v_conversation_id is null then
    insert into public.conversations(workspace_id,contact_id,instance_id,stage,last_message_at,last_message_preview,unread_count)
    values (v_workspace_id,v_contact_id,v_instance_id,'new',p_occurred_at,left(btrim(p_body_text),300),0)
    returning id into v_conversation_id;
  end if;

  insert into public.messages(workspace_id,conversation_id,instance_id,provider_message_id,direction,source_engine,actor_type,status,body_text,occurred_at)
  values (v_workspace_id,v_conversation_id,v_instance_id,p_event_id,'inbound','evolution','contact','received',btrim(p_body_text),p_occurred_at)
  on conflict (workspace_id,instance_id,source_engine,provider_message_id)
    where provider_message_id is not null
  do nothing
  returning id into v_message_id;
  if v_message_id is null then
    update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
    return jsonb_build_object('result','duplicate');
  end if;

  update public.conversations
  set last_message_at = greatest(coalesce(last_message_at,p_occurred_at),p_occurred_at),
      last_message_preview = left(btrim(p_body_text),300),
      unread_count = unread_count + 1
  where workspace_id = v_workspace_id and id = v_conversation_id;
  update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;

  return jsonb_build_object('result','accepted','workspace_id',v_workspace_id,
    'instance_id',v_instance_id,'contact_id',v_contact_id,'conversation_id',v_conversation_id,
    'message_id',v_message_id);
end;
$$;

revoke all on function private.ingest_evolution_text(text,text,text,text,text,text,text,timestamptz,boolean) from public, anon, authenticated;
grant execute on function private.ingest_evolution_text(text,text,text,text,text,text,text,timestamptz,boolean) to service_role;

-- PostgREST exposes public by default; this wrapper is callable only with the server's service-role credential.
create or replace function public.ingest_evolution_text(
  p_instance_name text,
  p_token_sha256 text,
  p_event_id text,
  p_event_type text,
  p_sender_jid text,
  p_push_name text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_from_me boolean
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.ingest_evolution_text(p_instance_name,p_token_sha256,p_event_id,p_event_type,p_sender_jid,p_push_name,p_body_text,p_occurred_at,p_from_me)
$$;
revoke all on function public.ingest_evolution_text(text,text,text,text,text,text,text,timestamptz,boolean) from public, anon, authenticated;
grant execute on function public.ingest_evolution_text(text,text,text,text,text,text,text,timestamptz,boolean) to service_role;

commit;
