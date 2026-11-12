begin;

-- Fase 2 (fechamento completo):
--   1. Alerta automático com dossiê completo no WhatsApp administrativo quando a conversa passa
--      para modo manual, entra em pausa silenciosa, tem envio incerto, falha ou para por segurança.
--   2. Estúdio completo no Treinamento: Mensagens prontas (M01–M13+), Estúdio de Skills
--      (operacionais S01–S35+ e humanização H01–H32+), Matriz de objeções (O001–O045+),
--      gatilhos configurados que sempre chamam o administrador e Cérebro completo / Pacote Turbo (.zip/.json).

-- =============================================================================================
-- 1. Alerta e Dossiê Administrativo em workspace_ai_settings
-- =============================================================================================

alter table public.workspace_ai_settings
  add column admin_alert_enabled boolean not null default false,
  add column admin_alert_whatsapp text not null default ''
    check (admin_alert_whatsapp = '' or admin_alert_whatsapp ~ '^[0-9]{10,15}$'),
  add column admin_alert_events text[] not null default array['handoff','silent_handoff','uncertain_send','error','safety']::text[]
    check (
      admin_alert_events <@ array['handoff','silent_handoff','uncertain_send','error','safety']::text[]
      and array_position(admin_alert_events, null) is null
    ),
  add column admin_alert_include_messages boolean not null default true;

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
        'human_pause_minutes', s.human_pause_minutes,
        'admin_alert_enabled', s.admin_alert_enabled,
        'admin_alert_whatsapp', s.admin_alert_whatsapp,
        'admin_alert_events', to_jsonb(s.admin_alert_events),
        'admin_alert_include_messages', s.admin_alert_include_messages,
        'updated_at', s.updated_at)
     from public.workspace_ai_settings s where s.workspace_id = p_workspace_id),
    jsonb_build_object(
        'provider', 'gemini', 'fallback_provider', 'none',
        'second_fallback_provider', 'none',
        'gemini_model', 'gemini-3.5-flash-lite', 'openrouter_model', 'deepseek/deepseek-chat',
        'nvidia_model', 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        'temperature', 0.35, 'max_history_messages', 20,
        'debounce_seconds', 6, 'simulate_typing', true,
        'split_long_messages', true, 'pause_on_human_reply', true,
        'human_pause_minutes', 60,
        'admin_alert_enabled', false,
        'admin_alert_whatsapp', '',
        'admin_alert_events', jsonb_build_array('handoff','silent_handoff','uncertain_send','error','safety'),
        'admin_alert_include_messages', true,
        'updated_at', null))
$$;

revoke all on function private.ai_settings_json(uuid) from public, anon, authenticated;

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
    'pause_on_human_reply','human_pause_minutes',
    'admin_alert_enabled','admin_alert_whatsapp','admin_alert_events','admin_alert_include_messages'];
  v_valid_events constant text[] := array['handoff','silent_handoff','uncertain_send','error','safety'];
  v_key text;
  v_new jsonb;
  v_whatsapp text;
  v_events text[];
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
    or (v_new ->> 'debounce_seconds')::integer not between 1 and 20 then
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
  if jsonb_typeof(v_new -> 'admin_alert_enabled') <> 'boolean' then
    raise exception 'Invalid admin_alert_enabled' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'admin_alert_include_messages') <> 'boolean' then
    raise exception 'Invalid admin_alert_include_messages' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'admin_alert_whatsapp') <> 'string' then
    raise exception 'Invalid admin_alert_whatsapp' using errcode = '22023';
  end if;
  v_whatsapp := regexp_replace(coalesce(v_new ->> 'admin_alert_whatsapp', ''), '[^0-9]', '', 'g');
  if v_whatsapp <> '' and v_whatsapp !~ '^[0-9]{10,15}$' then
    raise exception 'Invalid admin_alert_whatsapp' using errcode = '22023';
  end if;
  if (v_new ->> 'admin_alert_enabled')::boolean and v_whatsapp = '' then
    raise exception 'admin_alert_whatsapp_required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_new -> 'admin_alert_events') <> 'array' or jsonb_array_length(v_new -> 'admin_alert_events') > 10 then
    raise exception 'Invalid admin_alert_events' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_new -> 'admin_alert_events') e
    where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (v_valid_events))
  ) then
    raise exception 'Invalid admin_alert_events' using errcode = '22023';
  end if;
  select coalesce(array_agg(ev order by ord), array[]::text[])
  into v_events
  from unnest(v_valid_events) with ordinality as u(ev, ord)
  where u.ev in (select jsonb_array_elements_text(v_new -> 'admin_alert_events'));

  insert into public.workspace_ai_settings as s (workspace_id, provider, fallback_provider,
    second_fallback_provider, gemini_model, openrouter_model, nvidia_model, temperature,
    max_history_messages, debounce_seconds, simulate_typing,
    split_long_messages, pause_on_human_reply, human_pause_minutes,
    admin_alert_enabled, admin_alert_whatsapp, admin_alert_events, admin_alert_include_messages,
    updated_by)
  values (p_workspace_id, v_new ->> 'provider', v_new ->> 'fallback_provider',
    v_new ->> 'second_fallback_provider', v_new ->> 'gemini_model', v_new ->> 'openrouter_model',
    v_new ->> 'nvidia_model', round((v_new ->> 'temperature')::numeric, 2),
    (v_new ->> 'max_history_messages')::integer, (v_new ->> 'debounce_seconds')::integer,
    (v_new ->> 'simulate_typing')::boolean, (v_new ->> 'split_long_messages')::boolean,
    (v_new ->> 'pause_on_human_reply')::boolean, (v_new ->> 'human_pause_minutes')::integer,
    (v_new ->> 'admin_alert_enabled')::boolean, v_whatsapp, v_events,
    (v_new ->> 'admin_alert_include_messages')::boolean, v_actor)
  on conflict (workspace_id) do update set
    provider = excluded.provider, fallback_provider = excluded.fallback_provider,
    second_fallback_provider = excluded.second_fallback_provider, gemini_model = excluded.gemini_model,
    openrouter_model = excluded.openrouter_model, nvidia_model = excluded.nvidia_model,
    temperature = excluded.temperature,
    max_history_messages = excluded.max_history_messages, debounce_seconds = excluded.debounce_seconds,
    simulate_typing = excluded.simulate_typing, split_long_messages = excluded.split_long_messages,
    pause_on_human_reply = excluded.pause_on_human_reply, human_pause_minutes = excluded.human_pause_minutes,
    admin_alert_enabled = excluded.admin_alert_enabled,
    admin_alert_whatsapp = excluded.admin_alert_whatsapp,
    admin_alert_events = excluded.admin_alert_events,
    admin_alert_include_messages = excluded.admin_alert_include_messages,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_settings_updated','workspace',p_workspace_id::text,
    jsonb_build_object('changed', p_settings - 'admin_alert_whatsapp'
      || case when p_settings ? 'admin_alert_whatsapp'
              then jsonb_build_object('admin_alert_whatsapp_set', v_whatsapp <> '')
              else '{}'::jsonb end));

  return public.read_my_ai_settings(p_workspace_id);
end;
$$;

revoke all on function public.save_my_ai_settings(uuid,jsonb) from public, anon;
grant execute on function public.save_my_ai_settings(uuid,jsonb) to authenticated;

-- =============================================================================================
-- 2. Rastreamento interno dos dossiês enviados ao WhatsApp do administrador
-- =============================================================================================

create table private.admin_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  instance_id uuid not null,
  conversation_id uuid,
  turn_id uuid,
  kind text not null check (kind in ('handoff','silent_handoff','uncertain_send','error','safety','test')),
  recipient_core text not null,
  recipient_whatsapp text not null,
  body_prefix text not null default '',
  status text not null default 'sending' check (status in ('sending','sent','failed','uncertain')),
  provider_message_id text,
  error_detail text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index admin_alert_deliveries_match_idx
  on private.admin_alert_deliveries(workspace_id, instance_id, provider_message_id)
  where provider_message_id is not null;

create index admin_alert_deliveries_sending_idx
  on private.admin_alert_deliveries(workspace_id, instance_id, recipient_core, created_at)
  where status = 'sending';

create unique index admin_alert_deliveries_turn_kind_uq
  on private.admin_alert_deliveries(turn_id, kind)
  where turn_id is not null;

revoke all on table private.admin_alert_deliveries from public, anon, authenticated;
grant all on table private.admin_alert_deliveries to service_role;

create or replace function public.start_admin_alert_delivery(
  p_workspace_id uuid,
  p_turn_id uuid,
  p_conversation_id uuid,
  p_instance_id uuid,
  p_kind text,
  p_recipient_whatsapp text,
  p_body_prefix text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_clean text := regexp_replace(coalesce(p_recipient_whatsapp, ''), '[^0-9]', '', 'g');
begin
  if p_workspace_id is null or p_instance_id is null or v_clean = '' then
    raise exception 'Invalid alert delivery arguments' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('handoff','silent_handoff','uncertain_send','error','safety','test') then
    raise exception 'Invalid alert kind' using errcode = '22023';
  end if;

  insert into private.admin_alert_deliveries(
    workspace_id, instance_id, conversation_id, turn_id, kind,
    recipient_core, recipient_whatsapp, body_prefix, status
  )
  values (
    p_workspace_id, p_instance_id, p_conversation_id, p_turn_id, p_kind,
    private.phone_core(v_clean), v_clean, left(coalesce(p_body_prefix, ''), 120), 'sending'
  )
  on conflict (turn_id, kind) where turn_id is not null do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.start_admin_alert_delivery(uuid,uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.start_admin_alert_delivery(uuid,uuid,uuid,uuid,text,text,text) to service_role;

create or replace function public.finish_admin_alert_delivery(
  p_workspace_id uuid,
  p_delivery_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_detail text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('sent','failed','uncertain') then
    raise exception 'Invalid delivery status' using errcode = '22023';
  end if;

  update private.admin_alert_deliveries d
  set status = p_status,
      provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), d.provider_message_id),
      error_detail = nullif(left(private.trim_text(coalesce(p_error_detail, '')), 300), ''),
      finished_at = clock_timestamp()
  where d.workspace_id = p_workspace_id and d.id = p_delivery_id;
end;
$$;

revoke all on function public.finish_admin_alert_delivery(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.finish_admin_alert_delivery(uuid,uuid,text,text,text) to service_role;

-- Contexto leve para enviar o dossiê mesmo quando claim_ai_turn travou no rate_limit (safety).
create or replace function public.read_admin_alert_context(p_workspace_id uuid, p_turn_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_turns%rowtype;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_messages jsonb;
begin
  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id;
  if not found then return null; end if;

  select i.* into v_instance from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_turn.instance_id;

  select ct.* into v_contact
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id;

  select coalesce(jsonb_agg(to_jsonb(t) - 'rn' order by t.rn desc), '[]'::jsonb) into v_messages
  from (
    select m.id, m.direction, m.actor_type, m.status, m.body_text, m.occurred_at,
           row_number() over (order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc) as rn
    from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = v_turn.conversation_id
      and m.status not in ('failed','cancelled')
    order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc
    limit 12
  ) t;

  return jsonb_build_object(
    'settings', private.ai_settings_json(p_workspace_id),
    'conversation', jsonb_build_object(
      'id', v_turn.conversation_id,
      'contact_name', v_contact.display_name,
      'contact_phone', v_contact.phone_e164,
      'contact_email', v_contact.email,
      'recipient', v_contact.external_user_id,
      'instance_id', v_instance.id,
      'instance_label', v_instance.display_name,
      'instance_phone', v_instance.connected_phone,
      'provider_instance_name', v_instance.provider_instance_name
    ),
    'messages', v_messages
  );
end;
$$;

revoke all on function public.read_admin_alert_context(uuid,uuid) from public, anon, authenticated;
grant execute on function public.read_admin_alert_context(uuid,uuid) to service_role;

-- Atualiza ingest_evolution_message para ignorar o eco dos dossiês enviados pelo sistema ao admin.
create or replace function private.ingest_evolution_message(
  p_instance_name text,
  p_token_sha256 text,
  p_event_id text,
  p_event_type text,
  p_sender_jid text,
  p_push_name text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_from_me boolean,
  p_media jsonb
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
    v_ai := private.schedule_ai_turn(v_workspace_id, v_conversation_id, v_instance_id, v_message_id, p_occurred_at);
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
$$;

revoke all on function private.ingest_evolution_message(text,text,text,text,text,text,text,timestamptz,boolean,jsonb) from public, anon, authenticated;

-- =============================================================================================
-- 3. Estúdio completo e Cérebro em public.ai_agents + dados do contato em claim_ai_turn
-- =============================================================================================

alter table public.ai_agents
  add column escalation_rules text not null default ''
    check (char_length(escalation_rules) <= 4000),
  add column approved_messages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(approved_messages) = 'array' and jsonb_array_length(approved_messages) <= 100 and octet_length(approved_messages::text) <= 262144),
  add column operational_skills jsonb not null default '[]'::jsonb
    check (jsonb_typeof(operational_skills) = 'array' and jsonb_array_length(operational_skills) <= 100 and octet_length(operational_skills::text) <= 393216),
  add column humanization_skills jsonb not null default '[]'::jsonb
    check (jsonb_typeof(humanization_skills) = 'array' and jsonb_array_length(humanization_skills) <= 100 and octet_length(humanization_skills::text) <= 262144),
  add column objections jsonb not null default '[]'::jsonb
    check (jsonb_typeof(objections) = 'array' and jsonb_array_length(objections) <= 150 and octet_length(objections::text) <= 262144),
  add column brain_pack jsonb not null default '{}'::jsonb
    check (jsonb_typeof(brain_pack) = 'object' and octet_length(brain_pack::text) <= 393216);

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
    'escalation_rules', a.escalation_rules,
    'lock_until_manual_resume', a.lock_until_manual_resume,
    'prompt_shield_enabled', a.prompt_shield_enabled,
    'robot_question_policy', a.robot_question_policy,
    'approved_messages', a.approved_messages,
    'operational_skills', a.operational_skills,
    'humanization_skills', a.humanization_skills,
    'objections', a.objections,
    'brain_pack', a.brain_pack,
    'updated_at', a.updated_at, 'revision', a.revision,
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

revoke all on function private.ai_agent_json(uuid,uuid,boolean) from public, anon, authenticated;

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
          'approved_message_count', jsonb_array_length(a.approved_messages),
          'operational_skill_count', jsonb_array_length(a.operational_skills),
          'humanization_skill_count', jsonb_array_length(a.humanization_skills),
          'objection_count', jsonb_array_length(a.objections),
          'pack_name', coalesce(nullif(a.brain_pack ->> 'name', ''), ''),
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

revoke all on function public.read_my_ai_agents(uuid) from public, anon;
grant execute on function public.read_my_ai_agents(uuid) to authenticated;

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
    'extra_instructions', 4000, 'escalation_rules', 4000);
  v_flags constant text[] := array['solo_identity','lock_until_manual_resume','prompt_shield_enabled'];
  v_key text;
  v_value jsonb;
  v_data jsonb := '{}'::jsonb;
  v_agent public.ai_agents%rowtype;
  v_created boolean := false;
  v_count integer;
  v_faqs jsonb;
  v_faq jsonb;
  v_item jsonb;
  v_position integer := 0;
  v_question text;
  v_answer text;
  v_expected integer;
  v_approved jsonb;
  v_op_skills jsonb;
  v_hum_skills jsonb;
  v_objections jsonb;
  v_brain_pack jsonb;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Invalid agent data' using errcode = '22023';
  end if;

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
    elsif v_key = 'approved_messages' then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 100
        or octet_length(v_value::text) > 262144 then
        raise exception 'Invalid approved_messages' using errcode = '22023';
      end if;
      for v_item in select * from jsonb_array_elements(v_value) loop
        if jsonb_typeof(v_item) <> 'object'
          or jsonb_typeof(v_item -> 'id') <> 'string'
          or char_length(private.trim_text(v_item ->> 'id')) not between 1 and 60
          or jsonb_typeof(v_item -> 'text') <> 'string'
          or char_length(private.trim_text(v_item ->> 'text')) not between 1 and 4000 then
          raise exception 'Invalid approved_messages' using errcode = '22023';
        end if;
      end loop;
      v_approved := v_value;
    elsif v_key = 'operational_skills' then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 100
        or octet_length(v_value::text) > 393216 then
        raise exception 'Invalid operational_skills' using errcode = '22023';
      end if;
      for v_item in select * from jsonb_array_elements(v_value) loop
        if jsonb_typeof(v_item) <> 'object'
          or jsonb_typeof(v_item -> 'id') <> 'string'
          or char_length(private.trim_text(v_item ->> 'id')) not between 1 and 60
          or jsonb_typeof(v_item -> 'name') <> 'string'
          or char_length(private.trim_text(v_item ->> 'name')) not between 1 and 200 then
          raise exception 'Invalid operational_skills' using errcode = '22023';
        end if;
      end loop;
      v_op_skills := v_value;
    elsif v_key = 'humanization_skills' then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 100
        or octet_length(v_value::text) > 262144 then
        raise exception 'Invalid humanization_skills' using errcode = '22023';
      end if;
      for v_item in select * from jsonb_array_elements(v_value) loop
        if jsonb_typeof(v_item) <> 'object'
          or jsonb_typeof(v_item -> 'id') <> 'string'
          or char_length(private.trim_text(v_item ->> 'id')) not between 1 and 60
          or jsonb_typeof(v_item -> 'name') <> 'string'
          or char_length(private.trim_text(v_item ->> 'name')) not between 1 and 200 then
          raise exception 'Invalid humanization_skills' using errcode = '22023';
        end if;
      end loop;
      v_hum_skills := v_value;
    elsif v_key = 'objections' then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 150
        or octet_length(v_value::text) > 262144 then
        raise exception 'Invalid objections' using errcode = '22023';
      end if;
      for v_item in select * from jsonb_array_elements(v_value) loop
        if jsonb_typeof(v_item) <> 'object'
          or jsonb_typeof(v_item -> 'id') <> 'string'
          or char_length(private.trim_text(v_item ->> 'id')) not between 1 and 60
          or jsonb_typeof(v_item -> 'input_pattern') <> 'string'
          or char_length(private.trim_text(v_item ->> 'input_pattern')) not between 1 and 500 then
          raise exception 'Invalid objections' using errcode = '22023';
        end if;
      end loop;
      v_objections := v_value;
    elsif v_key = 'brain_pack' then
      if jsonb_typeof(v_value) <> 'object' or octet_length(v_value::text) > 393216 then
        raise exception 'Invalid brain_pack' using errcode = '22023';
      end if;
      v_brain_pack := v_value;
    elsif v_key = 'expected_revision' then
      if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}') !~ '^[0-9]{1,9}$' or (v_value #>> '{}')::integer < 1 then
        raise exception 'Invalid expected_revision' using errcode = '22023';
      end if;
      v_expected := (v_value #>> '{}')::integer;
    else
      raise exception 'Unknown agent field: %', left(v_key, 60) using errcode = '22023';
    end if;
  end loop;
  if v_data ? 'label' and v_data ->> 'label' = '' then
    raise exception 'Invalid label' using errcode = '22023';
  end if;

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
    insert into public.ai_agents(workspace_id, label, is_default, updated_by)
    values (p_workspace_id, v_data ->> 'label', v_count = 0, v_actor)
    returning * into v_agent;
    v_created := true;
  else
    select a.* into v_agent from public.ai_agents a
    where a.workspace_id = p_workspace_id and a.id = p_agent_id
    for update;
    if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
    if v_expected is not null and v_agent.revision <> v_expected then
      raise exception 'agent_changed' using errcode = 'P0001';
    end if;
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
    escalation_rules = coalesce(v_data ->> 'escalation_rules', a.escalation_rules),
    lock_until_manual_resume = coalesce((v_data ->> 'lock_until_manual_resume')::boolean, a.lock_until_manual_resume),
    prompt_shield_enabled = coalesce((v_data ->> 'prompt_shield_enabled')::boolean, a.prompt_shield_enabled),
    robot_question_policy = coalesce(v_data ->> 'robot_question_policy', a.robot_question_policy),
    approved_messages = coalesce(v_approved, a.approved_messages),
    operational_skills = coalesce(v_op_skills, a.operational_skills),
    humanization_skills = coalesce(v_hum_skills, a.humanization_skills),
    objections = coalesce(v_objections, a.objections),
    brain_pack = coalesce(v_brain_pack, a.brain_pack),
    revision = (case when v_created then a.revision else a.revision + 1 end),
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
    jsonb_build_object('fields', (select coalesce(jsonb_agg(t.k order by t.k), '[]'::jsonb) from jsonb_object_keys(p_data) as t(k) where t.k <> 'expected_revision'),
      'faq_count', case when v_faqs is not null then jsonb_array_length(v_faqs) end));

  return private.ai_agent_json(p_workspace_id, v_agent.id, false) || jsonb_build_object('can_edit', true);
end;
$$;

revoke all on function public.save_my_ai_agent(uuid,uuid,jsonb) from public, anon;
grant execute on function public.save_my_ai_agent(uuid,uuid,jsonb) to authenticated;

-- Atualiza claim_ai_turn para incluir dados completos do cliente e do chip no objeto conversation
-- (usados na montagem do dossiê ao administrador).
create or replace function public.claim_ai_turn(p_workspace_id uuid, p_turn_id uuid, p_trigger_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_turns%rowtype;
  v_reason text;
  v_settings jsonb;
  v_history integer;
  v_last_minute integer;
  v_last_hour integer;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_agent_id uuid;
  v_messages jsonb;
begin
  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id;
  if not found then return jsonb_build_object('result','gone'); end if;

  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id
  for update;
  perform private.reap_ai_turns(p_workspace_id, v_turn.conversation_id);

  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id for update;
  if v_turn.status <> 'waiting' then
    return jsonb_build_object('result','gone','status',v_turn.status);
  end if;
  if p_trigger_message_id is not null and v_turn.trigger_message_id <> p_trigger_message_id then
    return jsonb_build_object('result','superseded');
  end if;
  if v_turn.due_at > clock_timestamp() then
    return jsonb_build_object('result','early',
      'wait_ms', greatest(ceil(extract(epoch from (v_turn.due_at - clock_timestamp())) * 1000)::integer, 1));
  end if;
  if exists (
    select 1 from public.ai_turns r
    where r.workspace_id = p_workspace_id and r.conversation_id = v_turn.conversation_id and r.status = 'running') then
    return jsonb_build_object('result','busy');
  end if;

  v_reason := private.ai_block_reason(p_workspace_id, v_turn.conversation_id);
  if v_reason is not null then
    update public.ai_turns set status = 'skipped', finished_at = clock_timestamp(), outcome_detail = v_reason
    where workspace_id = p_workspace_id and id = v_turn.id;
    update public.conversations set stage = 'waiting_human'
    where workspace_id = p_workspace_id and id = v_turn.conversation_id and stage = 'ai';
    return jsonb_build_object('result','skipped','reason',v_reason);
  end if;

  select count(*) filter (where t.claimed_at > clock_timestamp() - interval '1 minute'), count(*)
  into v_last_minute, v_last_hour
  from public.ai_turns t
  where t.workspace_id = p_workspace_id and t.conversation_id = v_turn.conversation_id
    and t.claimed_at > clock_timestamp() - interval '1 hour';
  if v_last_minute >= 6 or v_last_hour >= 60 then
    update public.ai_turns set status = 'handed_off', finished_at = clock_timestamp(), outcome_detail = 'rate_limit'
    where workspace_id = p_workspace_id and id = v_turn.id;
    perform private.hand_conversation_to_human(p_workspace_id, v_turn.conversation_id, 'safety',
      'A IA respondeu muitas vezes em pouco tempo nesta conversa e parou por segurança. Pode haver um robô do outro lado.',
      false);
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,null,'service','ai_safety_stop','conversation',v_turn.conversation_id::text,
      jsonb_build_object('turn',v_turn.id,'last_minute',v_last_minute,'last_hour',v_last_hour));
    return jsonb_build_object('result','handed_off','reason','rate_limit');
  end if;

  update public.ai_turns set status = 'running', claimed_at = clock_timestamp()
  where workspace_id = p_workspace_id and id = v_turn.id;

  v_settings := private.ai_settings_json(p_workspace_id);
  v_history := least(greatest(coalesce((v_settings ->> 'max_history_messages')::integer, 20), 4), 60);

  select i.* into v_instance from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_turn.instance_id;
  select ct.* into v_contact
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id;

  select a.id into v_agent_id
  from public.ai_agents a
  where a.workspace_id = p_workspace_id
    and (a.id = v_instance.ai_agent_id or (v_instance.ai_agent_id is null and a.is_default));

  select coalesce(jsonb_agg(to_jsonb(t) - 'rn' order by t.rn desc), '[]'::jsonb) into v_messages
  from (
    select m.id, m.direction, m.actor_type, m.status, m.body_text, m.occurred_at,
           (select jsonb_build_object('kind', a.kind, 'content_type', a.content_type, 'byte_size', a.byte_size,
                     'file_name', a.file_name, 'is_voice', a.is_voice, 'object_key', a.object_key,
                     'status', case when a.deletion_status in ('pending','deleted') then 'deleted'
                                    else a.storage_status end)
            from public.message_attachments a
            where a.workspace_id = m.workspace_id and a.message_id = m.id) as attachment,
           row_number() over (order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc) as rn
    from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = v_turn.conversation_id
      and m.status not in ('failed','cancelled')
    order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc
    limit v_history
  ) t;

  return jsonb_build_object(
    'result', 'claimed',
    'turn', jsonb_build_object('id', v_turn.id, 'conversation_id', v_turn.conversation_id,
      'trigger_message_id', v_turn.trigger_message_id),
    'settings', v_settings,
    'keys', coalesce((select jsonb_object_agg(k.provider, k.ciphertext)
                      from private.workspace_ai_secrets k where k.workspace_id = p_workspace_id), '{}'::jsonb),
    'agent', case when v_agent_id is not null then private.ai_agent_json(p_workspace_id, v_agent_id, true) end,
    'conversation', jsonb_build_object(
      'id', v_turn.conversation_id,
      'contact_name', v_contact.display_name,
      'contact_phone', v_contact.phone_e164,
      'contact_email', v_contact.email,
      'recipient', v_contact.external_user_id,
      'instance_id', v_instance.id,
      'instance_label', v_instance.display_name,
      'instance_phone', v_instance.connected_phone,
      'provider_instance_name', v_instance.provider_instance_name),
    'messages', v_messages);
end;
$$;

revoke all on function public.claim_ai_turn(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_turn(uuid,uuid,uuid) to service_role;

commit;
