alter table public.messages add column if not exists is_historical boolean not null default false;
-- Separate authenticated ingestion for historical messages. No AI or human-reply side effects.
CREATE OR REPLACE FUNCTION public.ingest_local_history_message(p_token_sha256 text, p_instance_id uuid, p_event_id text, p_sender_jid text, p_push_name text, p_body_text text, p_occurred_at timestamp with time zone, p_from_me boolean, p_media jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_adopted_actor text;
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
    and i.engine = 'baileys'
    and i.status <> 'revoked';
  if not found then
    return jsonb_build_object('result', 'instance_not_found');
  end if;

  if p_event_id is null or char_length(p_event_id) not between 1 and 200 then
    raise exception 'Invalid event id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_workspace_id::text || ':' || v_instance_id::text || ':' || coalesce(p_event_id,''),0));
  if exists(select 1 from public.messages where workspace_id=v_workspace_id and instance_id=v_instance_id and provider_message_id=p_event_id) then
    return jsonb_build_object('result','duplicate');
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

    perform 1 from private.admin_alert_deliveries d
    where d.workspace_id = v_workspace_id and d.instance_id = v_instance_id
      and (
        d.provider_message_id = p_event_id
        or (
          d.recipient_core = private.phone_core(p_sender_jid)
          and d.created_at > clock_timestamp() - interval '2 minutes'
          and (
            d.status = 'sending'
            or (d.provider_message_id is null and left(coalesce(v_body, ''), 100) = left(d.body_prefix, 100))
          )
        )
      );
    if found then
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      update public.local_executors set status = 'active', last_seen_at = clock_timestamp() where id = v_auth.executor_id;
      return jsonb_build_object('result', 'ignored');
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


  if v_conversation_id is not null then
    perform 1 from public.conversations c
    where c.workspace_id = v_workspace_id and c.id = v_conversation_id
    for update;
  else
    select c.id into v_conversation_id
    from public.conversations c
    where c.workspace_id = v_workspace_id and c.contact_id = v_contact_id and c.instance_id = v_instance_id

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
      v_media_status := case when coalesce(v_size, 0) > 26214400 then 'too_large' else 'failed' end;
      v_keep_until := private.media_keep_until(v_workspace_id);
    end if;

    insert into public.messages(id, workspace_id, conversation_id, instance_id, provider_message_id, direction,
      source_engine, actor_type, status, body_text, media_object_key, occurred_at, created_at, is_historical)
    values (v_message_id, v_workspace_id, v_conversation_id, v_instance_id, p_event_id,
      case when p_from_me then 'outbound' else 'inbound' end, 'baileys',
      case when p_from_me then 'human' else 'contact' end,
      case when p_from_me then 'sent' else 'received' end,
      v_body, v_object_key, p_occurred_at, p_occurred_at, true);

    if v_kind is not null then
      insert into public.message_attachments(workspace_id, message_id, object_key, content_type, byte_size, kind,
        file_name, duration_seconds, width, height, is_voice, storage_status, retention_delete_after)
      values (v_workspace_id, v_message_id, v_object_key, v_mime, coalesce(v_size, 0), v_kind,
        v_file_name, v_duration, v_width, v_height, v_voice, v_media_status, v_keep_until);
    end if;
  end if;

  -- Importação não muda etapa, não cria pendência, pausa humana ou resposta de IA.
  update public.conversations
  set last_message_preview = case when last_message_at is null or p_occurred_at >= last_message_at
                                  then v_preview else last_message_preview end,
      last_message_at = greatest(coalesce(last_message_at, p_occurred_at), p_occurred_at)
  where workspace_id = v_workspace_id and id = v_conversation_id;

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
$function$;

revoke all on function public.ingest_local_history_message(text,uuid,text,text,text,text,timestamptz,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_local_history_message(text,uuid,text,text,text,text,timestamptz,boolean,jsonb) to service_role;

CREATE OR REPLACE FUNCTION public.ingest_evolution_history_message(p_instance_name text, p_token_sha256 text, p_event_id text, p_event_type text, p_sender_jid text, p_push_name text, p_body_text text, p_occurred_at timestamp with time zone, p_from_me boolean, p_media jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
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
  v_adopted_actor text;
  v_ai jsonb;
  v_media jsonb := case when jsonb_typeof(p_media) = 'object' then p_media end;
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
    and i.channel = 'whatsapp' and i.engine = 'evolution' and i.status <> 'revoked'
    and a.token_sha256 = p_token_sha256;
  if not found then return jsonb_build_object('result','unauthorized'); end if;

  if p_event_id is null or char_length(p_event_id) not between 1 and 200 then
    raise exception 'Invalid event id' using errcode = '22023';
  end if;
  if p_event_type is null or char_length(p_event_type) not between 1 and 80 then
    raise exception 'Invalid event type' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_workspace_id::text || ':' || v_instance_id::text || ':' || coalesce(p_event_id,''),0));
  if exists(select 1 from public.messages where workspace_id=v_workspace_id and instance_id=v_instance_id and provider_message_id=p_event_id) then
    return jsonb_build_object('result','duplicate');
  end if;
  insert into public.webhook_events(workspace_id,instance_id,engine,provider_event_id,event_type,processing_status)
  values (v_workspace_id,v_instance_id,'evolution',p_event_id,p_event_type,'received')
  on conflict (workspace_id,instance_id,engine,provider_event_id) do nothing
  returning id into v_webhook_event_id;
  if v_webhook_event_id is null then return jsonb_build_object('result','duplicate'); end if;

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

  if p_event_type <> 'MESSAGES_UPSERT' or p_from_me is null
    or p_sender_jid is null or p_sender_jid !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$'
    or p_occurred_at is null
    or coalesce(char_length(v_body), 0) > 8000
    or (v_media is null and v_body is null) then
    update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
    return jsonb_build_object('result','ignored');
  end if;

  v_preview := private.message_preview(v_body, v_kind, v_voice, v_file_name);

  if p_from_me then
    perform 1 from public.messages m
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id
      and m.source_engine = 'evolution' and m.provider_message_id = p_event_id;
    if found then
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      return jsonb_build_object('result','duplicate');
    end if;

    -- Eco de um dossiê enviado automaticamente para o WhatsApp administrativo: não cria conversa nem pausa nada.
    perform 1 from private.admin_alert_deliveries d
    where d.workspace_id = v_workspace_id and d.instance_id = v_instance_id
      and (
        d.provider_message_id = p_event_id
        or (
          d.recipient_core = private.phone_core(p_sender_jid)
          and d.created_at > clock_timestamp() - interval '2 minutes'
          and (
            d.status = 'sending'
            or (d.provider_message_id is null and left(coalesce(v_body, ''), 100) = left(d.body_prefix, 100))
          )
        )
      );
    if found then
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      return jsonb_build_object('result','duplicate');
    end if;
  end if;

  v_phone := '+' || split_part(p_sender_jid,'@',1);
  v_display_name := case when p_from_me then '' else coalesce(nullif(left(btrim(p_push_name),160),''),'') end;

  insert into public.contacts(workspace_id,instance_id,channel,external_user_id,display_name,phone_e164)
  values (v_workspace_id,v_instance_id,'whatsapp',p_sender_jid,v_display_name,v_phone)
  on conflict (workspace_id,channel,instance_id,external_user_id)
    where external_user_id is not null and erased_at is null
  do update set
    display_name = case when public.contacts.display_name in ('','Contato') and excluded.display_name <> ''
                        then excluded.display_name else public.contacts.display_name end,
    phone_e164 = coalesce(public.contacts.phone_e164,excluded.phone_e164),
    updated_at = now()
  returning id into v_contact_id;

  perform 1 from public.contacts where workspace_id = v_workspace_id and id = v_contact_id for update;


  if v_conversation_id is not null then
    perform 1 from public.conversations c
    where c.workspace_id = v_workspace_id and c.id = v_conversation_id
    for update;
  else
    select c.id into v_conversation_id
    from public.conversations c
    where c.workspace_id = v_workspace_id and c.contact_id = v_contact_id and c.instance_id = v_instance_id

    order by c.activity_at desc, c.id desc
    limit 1
    for update;
    if v_conversation_id is null then
      insert into public.conversations(workspace_id,contact_id,instance_id,stage,last_message_at,last_message_preview,unread_count)
      values (v_workspace_id,v_contact_id,v_instance_id,case when p_from_me then 'waiting_customer' else 'new' end,
        p_occurred_at,v_preview,0)
      returning id into v_conversation_id;
      v_created := true;
    end if;
  end if;

  if p_from_me then
    perform 1 from public.messages m
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id
      and m.source_engine = 'evolution' and m.provider_message_id = p_event_id;
    if found then
      if v_created then
        delete from public.conversations where workspace_id = v_workspace_id and id = v_conversation_id;
      end if;
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      return jsonb_build_object('result','duplicate');
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
      v_media_status := case when coalesce(v_size, 0) > 26214400 then 'too_large' else 'failed' end;
      v_keep_until := private.media_keep_until(v_workspace_id);
    end if;

    insert into public.messages(id,workspace_id,conversation_id,instance_id,provider_message_id,direction,
      source_engine,actor_type,status,body_text,media_object_key,occurred_at,created_at,is_historical)
    values (v_message_id,v_workspace_id,v_conversation_id,v_instance_id,p_event_id,
      case when p_from_me then 'outbound' else 'inbound' end,'evolution',
      case when p_from_me then 'human' else 'contact' end,
      case when p_from_me then 'sent' else 'received' end,
      v_body,v_object_key,p_occurred_at,p_occurred_at,true);

    if v_kind is not null then
      insert into public.message_attachments(workspace_id,message_id,object_key,content_type,byte_size,kind,
        file_name,duration_seconds,width,height,is_voice,storage_status,retention_delete_after)
      values (v_workspace_id,v_message_id,v_object_key,v_mime,coalesce(v_size,0),v_kind,
        v_file_name,v_duration,v_width,v_height,v_voice,v_media_status,v_keep_until);
    end if;
  end if;

  -- Importação não muda etapa, não cria pendência, pausa humana ou resposta de IA.
  update public.conversations
  set last_message_preview = case when last_message_at is null or p_occurred_at >= last_message_at
                                  then v_preview else last_message_preview end,
      last_message_at = greatest(coalesce(last_message_at, p_occurred_at), p_occurred_at)
  where workspace_id = v_workspace_id and id = v_conversation_id;

  update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;

  return jsonb_build_object('result','accepted','workspace_id',v_workspace_id,
    'instance_id',v_instance_id,'contact_id',v_contact_id,'conversation_id',v_conversation_id,
    'message_id',v_message_id,'direction',case when p_from_me then 'outbound' else 'inbound' end,'adopted',v_adopted,
    'media',case when v_media_status is not null
                 then jsonb_build_object('object_key',v_object_key,'status',v_media_status) end,
    'ai',v_ai,
    'ai_stale',exists (
      select 1 from public.ai_turns t
      where t.workspace_id = v_workspace_id
        and ((t.status = 'waiting' and t.due_at < clock_timestamp() - interval '20 seconds')
          or (t.status = 'running' and t.claimed_at < clock_timestamp() - interval '3 minutes'))));
end;
$function$;

revoke all on function public.ingest_evolution_history_message(text,text,text,text,text,text,text,timestamptz,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_evolution_history_message(text,text,text,text,text,text,text,timestamptz,boolean,jsonb) to service_role;

create table if not exists public.evolution_history_queue (
 id bigint generated always as identity primary key,
 instance_name text not null,
 token_sha256 text not null,
 event_id text not null,
 payload jsonb not null,
 attempts integer not null default 0,
 status text not null default 'pending' check(status in ('pending','done','failed')),
 created_at timestamptz not null default now(),
 unique(instance_name,token_sha256,event_id)
);
alter table public.evolution_history_queue enable row level security;
revoke all on public.evolution_history_queue from anon,authenticated;
grant all on public.evolution_history_queue to service_role;
create or replace function public.enqueue_evolution_history(p_instance_name text,p_token_sha256 text,p_messages jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare x jsonb; total integer:=0;
begin
 if not exists(select 1 from private.evolution_webhook_auth a join public.instances i on i.id=a.instance_id and i.workspace_id=a.workspace_id
 where i.provider_instance_name=p_instance_name and a.token_sha256=p_token_sha256 and i.engine='evolution' and i.status<>'revoked') then
 return jsonb_build_object('result','unauthorized');end if;
 if jsonb_typeof(p_messages)<>'array' or jsonb_array_length(p_messages)>5000 then raise exception 'Invalid history batch';end if;
 for x in select value from jsonb_array_elements(p_messages) loop
  if length(x->>'event_id') between 1 and 200 then
   insert into public.evolution_history_queue(instance_name,token_sha256,event_id,payload)
   values(p_instance_name,p_token_sha256,x->>'event_id',x) on conflict do nothing;
   if found then total:=total+1;end if;
  end if;
 end loop;
 return jsonb_build_object('result','queued','count',total);
end;$$;
create or replace function public.process_evolution_history_queue(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $$
declare x record; r jsonb; total integer:=0;
begin
 for x in select * from public.evolution_history_queue where status='pending' order by id for update skip locked limit least(greatest(p_limit,1),100) loop
  begin
   r:=public.ingest_evolution_history_message(x.instance_name,x.token_sha256,x.event_id,'MESSAGES_UPSERT',x.payload->>'sender_jid',x.payload->>'push_name',x.payload->>'body_text',(x.payload->>'occurred_at')::timestamptz,(x.payload->>'from_me')::boolean,x.payload->'media');
   update public.evolution_history_queue set status=case when r->>'result' in ('accepted','duplicate','ignored') then 'done' else 'failed' end, payload='{}',attempts=attempts+1 where id=x.id;
   total:=total+1;
  exception when others then
   update public.evolution_history_queue set attempts=attempts+1,status=case when attempts>=4 then 'failed' else 'pending' end where id=x.id;
  end;
 end loop;
 return jsonb_build_object('processed',total);
end;$$;
revoke all on function public.enqueue_evolution_history(text,text,jsonb) from public,anon,authenticated;
revoke all on function public.process_evolution_history_queue(integer) from public,anon,authenticated;
grant execute on function public.enqueue_evolution_history(text,text,jsonb) to service_role;
grant execute on function public.process_evolution_history_queue(integer) to service_role;

create table if not exists public.evolution_history_recovery (
 instance_id uuid primary key references public.instances(id) on delete cascade,
 instance_name text not null, token_sha256 text not null,
 next_page integer not null default 1,
 status text not null default 'pending' check(status in ('pending','done','failed')),
 attempts integer not null default 0,
 last_error text, last_synced_at timestamptz, updated_at timestamptz not null default now()
);
alter table public.evolution_history_recovery enable row level security;
revoke all on public.evolution_history_recovery from anon,authenticated;
grant all on public.evolution_history_recovery to service_role;
create or replace function public.request_evolution_history(p_instance_name text,p_token_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare inst uuid;
begin
 select i.id into inst from private.evolution_webhook_auth a join public.instances i on i.id=a.instance_id and i.workspace_id=a.workspace_id
 where i.provider_instance_name=p_instance_name and a.token_sha256=p_token_sha256 and i.engine='evolution' and i.status<>'revoked';
 if inst is null then return jsonb_build_object('result','unauthorized');end if;
 insert into public.evolution_history_recovery(instance_id,instance_name,token_sha256) values(inst,p_instance_name,p_token_sha256)
 on conflict(instance_id) do update set token_sha256=excluded.token_sha256,status='pending',next_page=case when public.evolution_history_recovery.status='pending' then public.evolution_history_recovery.next_page else 1 end,attempts=0,updated_at=now();
 return jsonb_build_object('result','queued');
end;$$;
revoke all on function public.request_evolution_history(text,text) from public,anon,authenticated;
grant execute on function public.request_evolution_history(text,text) to service_role;
