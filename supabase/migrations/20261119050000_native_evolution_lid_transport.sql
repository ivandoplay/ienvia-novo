-- Transporte manual LID somente Evolution; não converter LID em telefone.
CREATE OR REPLACE FUNCTION public.start_my_text_message(p_workspace_id uuid, p_conversation_id uuid, p_body_text text, p_idempotency_key text, p_reply_to_message_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    or (v_contact.external_user_id !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$' and not (v_instance.engine='evolution' and v_contact.external_user_id ~ '^[1-9][0-9]{5,19}@lid$')) then
    raise exception 'contact_unreachable' using errcode = 'P0001';
  end if;

  -- A citação só vale se a mensagem citada for desta mesma conversa.
  if p_reply_to_message_id is not null and not exists (
    select 1 from public.messages cit
    where cit.workspace_id = p_workspace_id
      and cit.conversation_id = p_conversation_id
      and cit.id = p_reply_to_message_id
  ) then
    p_reply_to_message_id := null;
  end if;

  insert into public.messages(workspace_id,conversation_id,instance_id,idempotency_key,direction,
    source_engine,actor_type,status,body_text,occurred_at,sent_by,reply_to_message_id)
  values (p_workspace_id,p_conversation_id,v_instance.id,p_idempotency_key,'outbound',
    v_instance.engine,'human','sending',v_body,now(),v_actor,p_reply_to_message_id)
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
$function$;
CREATE OR REPLACE FUNCTION public.start_my_media_message(p_workspace_id uuid, p_conversation_id uuid, p_idempotency_key text, p_object_key text, p_kind text, p_file_name text, p_caption text, p_duration_seconds integer, p_width integer, p_height integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    or (v_contact.external_user_id !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$' and not (v_instance.engine='evolution' and v_contact.external_user_id ~ '^[1-9][0-9]{5,19}@lid$')) then
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
$function$;
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
$function$;