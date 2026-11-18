-- Exclusão manual e atômica de conversas selecionadas, somente pelo dono.
-- Não chama o WhatsApp, não apaga contatos e não altera instâncias.
create table if not exists private.deleted_inbox_message_keys (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 instance_id uuid not null,
 provider_message_id text not null,
 deleted_at timestamptz not null default now(),
 primary key(workspace_id,instance_id,provider_message_id)
);
revoke all on private.deleted_inbox_message_keys from public,anon,authenticated;
create table if not exists public.inbox_deleted_file_queue (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 object_key text not null,
 created_at timestamptz not null default now(),
 attempts integer not null default 0,
 primary key(workspace_id,object_key)
);
alter table public.inbox_deleted_file_queue enable row level security;
revoke all on public.inbox_deleted_file_queue from public,anon,authenticated;
grant all on public.inbox_deleted_file_queue to service_role;

create or replace function public.delete_my_selected_conversations(p_workspace_id uuid,p_conversation_ids uuid[],p_confirmation text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 ids uuid[]; instance_ids uuid[]; message_ids uuid[]; inst uuid; quantidade integer; apagadas integer;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then
  raise exception 'workspace_owner_required' using errcode='42501';
 end if;
 if p_confirmation is distinct from 'APAGAR' then raise exception 'confirmation_required' using errcode='22023';end if;
 if p_conversation_ids is null or cardinality(p_conversation_ids) not between 1 and 100 or array_position(p_conversation_ids,null) is not null then
  raise exception 'invalid_selection' using errcode='22023';
 end if;
 select array_agg(distinct x order by x) into ids from unnest(p_conversation_ids) x;
 if cardinality(ids)<>cardinality(p_conversation_ids) then raise exception 'invalid_selection' using errcode='22023';end if;
 select count(*),array_agg(distinct c.instance_id order by c.instance_id) into quantidade,instance_ids
 from public.conversations c where c.workspace_id=p_workspace_id and c.id=any(ids);
 if quantidade<>cardinality(ids) then raise exception 'selection_changed' using errcode='22023';end if;
 -- Mesma ordem das ingestões: trava do chip antes de travas de conversas/mensagens.
 foreach inst in array instance_ids loop
  perform pg_advisory_xact_lock(hashtextextended(inst::text||':inbox-delete',0));
 end loop;
 perform c.id from public.conversations c where c.workspace_id=p_workspace_id and c.id=any(ids) order by c.id for update;
 get diagnostics quantidade=row_count;
 if quantidade<>cardinality(ids) then raise exception 'selection_changed' using errcode='22023';end if;
 select coalesce(array_agg(m.id),'{}') into message_ids from public.messages m where m.workspace_id=p_workspace_id and m.conversation_id=any(ids);
 -- Não destruir registros que um executor/provedor ainda pode estar usando.
 perform j.id from public.outbox_jobs j where j.workspace_id=p_workspace_id and (j.conversation_id=any(ids) or j.message_id=any(message_ids)) order by j.id for update;
 perform l.id from public.local_motor_commands l where l.workspace_id=p_workspace_id and l.message_id=any(message_ids) order by l.id for update;
 perform t.id from public.ai_turns t where t.workspace_id=p_workspace_id and t.conversation_id=any(ids) order by t.id for update;
 perform s.id from public.scheduled_messages s where s.workspace_id=p_workspace_id and s.conversation_id=any(ids) order by s.id for update;
 perform r.id from public.campaign_recipients r where r.workspace_id=p_workspace_id and r.message_id=any(message_ids) order by r.id for update;
 perform d.id from public.campaign_step_deliveries d where d.workspace_id=p_workspace_id and d.message_id=any(message_ids) order by d.id for update;
 if exists(select 1 from public.outbox_jobs where workspace_id=p_workspace_id and (conversation_id=any(ids) or message_id=any(message_ids)) and status='leased')
 or exists(select 1 from public.local_motor_commands where workspace_id=p_workspace_id and message_id=any(message_ids) and status in ('leased','uncertain'))
 or exists(select 1 from public.ai_turns where workspace_id=p_workspace_id and conversation_id=any(ids) and status='running')
 or exists(select 1 from public.scheduled_messages where workspace_id=p_workspace_id and conversation_id=any(ids) and status='processing')
 or exists(select 1 from public.messages where workspace_id=p_workspace_id and id=any(message_ids) and status in ('sending','queued','awaiting_human_confirmation'))
 or exists(select 1 from public.campaign_recipients where workspace_id=p_workspace_id and message_id=any(message_ids) and status in ('queued','sending','awaiting_human_confirmation'))
 or exists(select 1 from public.campaign_step_deliveries where workspace_id=p_workspace_id and message_id=any(message_ids) and status in ('sending','awaiting_human_confirmation'))
 then raise exception 'conversation_busy' using errcode='55000';end if;
 insert into private.deleted_inbox_message_keys(workspace_id,instance_id,provider_message_id)
 select workspace_id,instance_id,provider_message_id from public.messages where workspace_id=p_workspace_id and id=any(message_ids) and provider_message_id is not null
 on conflict do nothing;
 -- Somente arquivos pertencentes às pastas das conversas apagadas. Bibliotecas compartilhadas ficam.
 insert into public.inbox_deleted_file_queue(workspace_id,object_key)
 select distinct p_workspace_id,a.object_key from public.message_attachments a join public.messages m on m.id=a.message_id and m.workspace_id=a.workspace_id
 where a.workspace_id=p_workspace_id and a.message_id=any(message_ids) and a.object_key like p_workspace_id::text||'/'||m.conversation_id::text||'/%'
 and not exists(select 1 from public.message_attachments other where other.workspace_id=p_workspace_id and other.object_key=a.object_key and not(other.message_id=any(message_ids)))
 on conflict do nothing;
 update public.local_motor_commands set status='cancelled',payload='{}'::jsonb,error_detail='conversation_deleted' where workspace_id=p_workspace_id and message_id=any(message_ids) and status='pending';
 update public.local_motor_commands set payload='{}'::jsonb where workspace_id=p_workspace_id and message_id=any(message_ids);
 update public.campaign_recipients set message_id=null where workspace_id=p_workspace_id and message_id=any(message_ids);
 update public.campaign_step_deliveries set message_id=null where workspace_id=p_workspace_id and message_id=any(message_ids);
 delete from public.outbox_jobs where workspace_id=p_workspace_id and (conversation_id=any(ids) or message_id=any(message_ids));
 -- Evita SET NULL da FK composta apagar também workspace_id de uma resposta preservada.
 update public.messages set reply_to_message_id=null where workspace_id=p_workspace_id and reply_to_message_id=any(message_ids);
 delete from public.message_attachments where workspace_id=p_workspace_id and message_id=any(message_ids);
 delete from public.messages where workspace_id=p_workspace_id and id=any(message_ids);
 delete from public.conversations where workspace_id=p_workspace_id and id=any(ids);
 get diagnostics apagadas=row_count;
 if apagadas<>cardinality(ids) then raise exception 'selection_changed';end if;
 insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
 values(p_workspace_id,auth.uid(),'owner','selected_conversations_deleted','workspace',p_workspace_id::text,jsonb_build_object('conversations',apagadas,'messages',cardinality(message_ids),'conversation_ids',to_jsonb(ids)));
 return jsonb_build_object('deleted',apagadas,'messages',cardinality(message_ids));
end;$$;
revoke all on function public.delete_my_selected_conversations(uuid,uuid[],text) from public,anon;
grant execute on function public.delete_my_selected_conversations(uuid,uuid[],text) to authenticated;

-- Guardas geradas das funções atuais; lógica original preservada.
CREATE OR REPLACE FUNCTION private.ingest_evolution_message(p_instance_name text, p_token_sha256 text, p_event_id text, p_event_type text, p_sender_jid text, p_push_name text, p_body_text text, p_occurred_at timestamp with time zone, p_from_me boolean, p_media jsonb)
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

  p_sender_jid := coalesce((select phone_jid from public.whatsapp_lid_aliases where instance_id=v_instance_id and lid=p_sender_jid),p_sender_jid);
  perform pg_advisory_xact_lock(hashtextextended(v_instance_id::text||':inbox-delete',0));
  if exists(select 1 from private.deleted_inbox_message_keys k where k.workspace_id=v_workspace_id and k.instance_id=v_instance_id and k.provider_message_id=p_event_id) then
    return jsonb_build_object('result','ignored','reason','manually_deleted');
  end if;
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
    or p_sender_jid is null or p_sender_jid !~ '^[1-9][0-9]{5,19}@(s[.]whatsapp[.]net|lid)$'
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

  v_phone := case when p_sender_jid like '%@s.whatsapp.net' then '+' || split_part(p_sender_jid,'@',1) else null end;
  v_display_name := case when p_from_me then '' else coalesce(nullif(left(btrim(p_push_name),160),''),'') end;

  insert into public.contacts(workspace_id,instance_id,channel,external_user_id,display_name,phone_e164)
  values (v_workspace_id,v_instance_id,'whatsapp',p_sender_jid,v_display_name,v_phone)
  on conflict (workspace_id,channel,instance_id,external_user_id)
    where external_user_id is not null and erased_at is null
  do update set
    display_name = case when (public.contacts.display_name='' or public.contacts.display_name ~ '^(Contato|Contato WhatsApp|[0-9]+)( · número pendente)?$') and excluded.display_name <> '' and excluded.display_name !~ '^[+0-9[:space:]().-]+$'
                        then excluded.display_name else public.contacts.display_name end,
    phone_e164 = coalesce(public.contacts.phone_e164,excluded.phone_e164),
    updated_at = now()
  returning id into v_contact_id;

  perform 1 from public.contacts where workspace_id = v_workspace_id and id = v_contact_id for update;

  if p_from_me then
    select m.id, m.conversation_id into v_candidate_id, v_conversation_id
    from public.messages m
    join public.conversations c on c.workspace_id = m.workspace_id and c.id = m.conversation_id
    left join public.message_attachments a on a.workspace_id = m.workspace_id and a.message_id = m.id
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id and c.contact_id = v_contact_id
      and m.direction = 'outbound' and m.source_engine = 'evolution'
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
      v_media_status := case when coalesce(v_size, 0) > 26214400 then 'too_large' else 'pending' end;
      v_keep_until := private.media_keep_until(v_workspace_id);
    end if;

    insert into public.messages(id,workspace_id,conversation_id,instance_id,provider_message_id,direction,
      source_engine,actor_type,status,body_text,media_object_key,occurred_at)
    values (v_message_id,v_workspace_id,v_conversation_id,v_instance_id,p_event_id,
      case when p_from_me then 'outbound' else 'inbound' end,'evolution',
      case when p_from_me then 'human' else 'contact' end,
      case when p_from_me then 'sent' else 'received' end,
      v_body,v_object_key,p_occurred_at);

    if v_kind is not null then
      insert into public.message_attachments(workspace_id,message_id,object_key,content_type,byte_size,kind,
        file_name,duration_seconds,width,height,is_voice,storage_status,retention_delete_after)
      values (v_workspace_id,v_message_id,v_object_key,v_mime,coalesce(v_size,0),v_kind,
        v_file_name,v_duration,v_width,v_height,v_voice,v_media_status,v_keep_until);
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
        last_message_at = greatest(coalesce(last_message_at,p_occurred_at),p_occurred_at),
        unread_count = unread_count + 1,
        stage = case when stage = 'waiting_customer' then 'human' else stage end
    where workspace_id = v_workspace_id and id = v_conversation_id;
    if p_sender_jid like '%@s.whatsapp.net' then
    v_ai := private.schedule_ai_turn(v_workspace_id, v_conversation_id, v_instance_id, v_message_id, p_occurred_at);
    end if;
  end if;

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
$function$
;
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

  p_sender_jid := coalesce((select phone_jid from public.whatsapp_lid_aliases where instance_id=v_instance_id and lid=p_sender_jid),p_sender_jid);

  perform pg_advisory_xact_lock(hashtextextended(v_instance_id::text||':inbox-delete',0));
  if exists(select 1 from private.deleted_inbox_message_keys k where k.workspace_id=v_workspace_id and k.instance_id=v_instance_id and k.provider_message_id=p_event_id) then
    return jsonb_build_object('result','ignored','reason','manually_deleted');
  end if;
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
    or p_sender_jid is null or p_sender_jid !~ '^[1-9][0-9]{5,19}@(s[.]whatsapp[.]net|lid)$'
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

  v_phone := case when p_sender_jid like '%@s.whatsapp.net' then '+' || split_part(p_sender_jid,'@',1) else null end;
  v_display_name := case when p_from_me then '' else coalesce(nullif(left(btrim(p_push_name),160),''),'') end;
  if p_sender_jid like '%@lid' then v_display_name := coalesce(nullif(v_display_name,''),'Contato WhatsApp') || ' · número pendente'; end if;

  insert into public.contacts(workspace_id,instance_id,channel,external_user_id,display_name,phone_e164)
  values (v_workspace_id,v_instance_id,'whatsapp',p_sender_jid,v_display_name,v_phone)
  on conflict (workspace_id,channel,instance_id,external_user_id)
    where external_user_id is not null and erased_at is null
  do update set
    display_name = case when (public.contacts.display_name='' or public.contacts.display_name ~ '^(Contato|Contato WhatsApp|[0-9]+)( · número pendente)?$') and excluded.display_name <> '' and excluded.display_name !~ '^(Contato|Contato WhatsApp|[0-9]+)( · número pendente)?$'
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
$function$
;
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

  perform pg_advisory_xact_lock(hashtextextended(v_instance_id::text||':inbox-delete',0));
  if exists(select 1 from private.deleted_inbox_message_keys k where k.workspace_id=v_workspace_id and k.instance_id=v_instance_id and k.provider_message_id=p_event_id) then
    return jsonb_build_object('result','ignored','reason','manually_deleted');
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
    or p_sender_jid is null or p_sender_jid !~ '^[1-9][0-9]{5,19}@(s[.]whatsapp[.]net|lid)$'
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

  v_phone := case when p_sender_jid like '%@s.whatsapp.net' then '+' || split_part(p_sender_jid, '@', 1) else null end;
  v_display_name := case when p_from_me then '' else coalesce(nullif(left(btrim(p_push_name), 160), ''), '') end;
  if p_sender_jid like '%@lid' then v_display_name := coalesce(nullif(v_display_name,''),'Contato WhatsApp') || ' · número pendente'; end if;

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
$function$
;
CREATE OR REPLACE FUNCTION public.ingest_local_message(p_token_sha256 text, p_instance_id uuid, p_event_id text, p_sender_jid text, p_push_name text, p_body_text text, p_occurred_at timestamp with time zone, p_from_me boolean, p_media jsonb DEFAULT NULL::jsonb)
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

  perform pg_advisory_xact_lock(hashtextextended(v_instance_id::text||':inbox-delete',0));
  if exists(select 1 from private.deleted_inbox_message_keys k where k.workspace_id=v_workspace_id and k.instance_id=v_instance_id and k.provider_message_id=p_event_id) then
    return jsonb_build_object('result','ignored','reason','manually_deleted');
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
$function$
;
