-- Fase 5: Campanhas, Pastas de Mídia, Fila Segura, Segurança Anti-Bloqueio,
-- Horário de Atendimento, Contatos Ignorados, Alertas de Desconexão/Campanha e Rastreio de Entrega/Resposta.

begin;

-- =============================================================================================
-- 1. Extensões em workspace_ai_settings (fonte única de verdade com Motor de IA) e conversations
-- =============================================================================================

do $$
declare
  v_con text;
begin
  select c.conname into v_con
  from pg_constraint c
  where c.conrelid = 'public.workspace_ai_settings'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%admin_alert_events%';
  if v_con is not null then
    execute format('alter table public.workspace_ai_settings drop constraint %I', v_con);
  end if;

  select c.conname into v_con
  from pg_constraint c
  where c.conrelid = 'private.admin_alert_deliveries'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%kind%';
  if v_con is not null then
    execute format('alter table private.admin_alert_deliveries drop constraint %I', v_con);
  end if;
end
$$;

alter table public.workspace_ai_settings
  add constraint workspace_ai_settings_admin_alert_events_check check (
    admin_alert_events <@ array[
      'handoff','silent_handoff','uncertain_send','error','safety','chip_disconnected','campaign_uncertain'
    ]::text[]
    and array_position(admin_alert_events, null) is null
  );

alter table private.admin_alert_deliveries
  add constraint admin_alert_deliveries_kind_check check (
    kind in ('handoff','silent_handoff','uncertain_send','error','safety','chip_disconnected','campaign_uncertain','test')
  );

alter table public.workspace_ai_settings
  add column antiban_preset text not null default 'equilibrado'
    check (antiban_preset in ('conservador','equilibrado','moderado','personalizado')),
  add column min_typing_ms integer not null default 1800
    check (min_typing_ms between 500 and 10000),
  add column max_typing_ms integer not null default 5200
    check (max_typing_ms between 1000 and 15000),
  add column max_replies_per_minute_per_contact integer not null default 6
    check (max_replies_per_minute_per_contact between 1 and 60),
  add column proactive_min_delay_sec integer not null default 45
    check (proactive_min_delay_sec between 20 and 600),
  add column proactive_max_delay_sec integer not null default 110
    check (proactive_max_delay_sec between 30 and 900),
  add column daily_proactive_limit integer not null default 25
    check (daily_proactive_limit between 1 and 150),
  add column schedule_mode text not null default 'always'
    check (schedule_mode in ('always','business_hours_only','outside_hours_only')),
  add column schedule_start text not null default '08:00'
    check (schedule_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column schedule_end text not null default '18:00'
    check (schedule_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column schedule_work_days integer[] not null default array[1,2,3,4,5,6]::integer[]
    check (schedule_work_days <@ array[0,1,2,3,4,5,6]::integer[] and array_position(schedule_work_days, null) is null),
  add column schedule_timezone text not null default 'America/Fortaleza'
    check (char_length(schedule_timezone) between 1 and 80),
  add column off_hours_reply_message text not null default ''
    check (char_length(off_hours_reply_message) <= 4000),
  add constraint workspace_ai_settings_typing_range_check check (min_typing_ms <= max_typing_ms),
  add constraint workspace_ai_settings_proactive_delay_range_check check (proactive_min_delay_sec <= proactive_max_delay_sec);

alter table public.conversations
  add column off_hours_replied_at timestamptz;

-- Atualiza save_my_ai_settings para também aceitar os novos eventos de alerta quando editado no Motor de IA
-- mantendo 100% compatíveis todos os campos e respostas originais de read_my_ai_settings.
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
  v_valid_events constant text[] := array[
    'handoff','silent_handoff','uncertain_send','error','safety','chip_disconnected','campaign_uncertain'
  ];
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
  if jsonb_typeof(v_new -> 'admin_alert_events') <> 'array' or jsonb_array_length(v_new -> 'admin_alert_events') > 15 then
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

create or replace function private.security_settings_json(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object(
      'antiban_preset', s.antiban_preset,
      'simulate_typing', s.simulate_typing,
      'min_typing_ms', s.min_typing_ms,
      'max_typing_ms', s.max_typing_ms,
      'split_long_messages', s.split_long_messages,
      'debounce_seconds', s.debounce_seconds,
      'pause_on_human_reply', s.pause_on_human_reply,
      'human_pause_minutes', s.human_pause_minutes,
      'max_replies_per_minute_per_contact', s.max_replies_per_minute_per_contact,
      'proactive_min_delay_sec', s.proactive_min_delay_sec,
      'proactive_max_delay_sec', s.proactive_max_delay_sec,
      'daily_proactive_limit', s.daily_proactive_limit,
      'schedule_mode', s.schedule_mode,
      'schedule_start', s.schedule_start,
      'schedule_end', s.schedule_end,
      'schedule_work_days', to_jsonb(s.schedule_work_days),
      'schedule_timezone', s.schedule_timezone,
      'off_hours_reply_message', s.off_hours_reply_message,
      'admin_alert_enabled', s.admin_alert_enabled,
      'admin_alert_whatsapp', s.admin_alert_whatsapp,
      'admin_alert_events', to_jsonb(s.admin_alert_events),
      'admin_alert_include_messages', s.admin_alert_include_messages,
      'updated_at', s.updated_at
    )
    from public.workspace_ai_settings s where s.workspace_id = p_workspace_id),
    jsonb_build_object(
      'antiban_preset', 'equilibrado',
      'simulate_typing', true,
      'min_typing_ms', 1800,
      'max_typing_ms', 5200,
      'split_long_messages', true,
      'debounce_seconds', 6,
      'pause_on_human_reply', true,
      'human_pause_minutes', 60,
      'max_replies_per_minute_per_contact', 6,
      'proactive_min_delay_sec', 45,
      'proactive_max_delay_sec', 110,
      'daily_proactive_limit', 25,
      'schedule_mode', 'always',
      'schedule_start', '08:00',
      'schedule_end', '18:00',
      'schedule_work_days', jsonb_build_array(1,2,3,4,5,6),
      'schedule_timezone', 'America/Fortaleza',
      'off_hours_reply_message', '',
      'admin_alert_enabled', false,
      'admin_alert_whatsapp', '',
      'admin_alert_events', jsonb_build_array('handoff','silent_handoff','uncertain_send','error','safety'),
      'admin_alert_include_messages', true,
      'updated_at', null
    )
  )
$$;

revoke all on function private.security_settings_json(uuid) from public, anon, authenticated;

create or replace function public.read_my_security_settings(p_workspace_id uuid)
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
  return private.security_settings_json(p_workspace_id) || jsonb_build_object(
    'can_edit', private.is_workspace_owner(p_workspace_id)
  );
end;
$$;

revoke all on function public.read_my_security_settings(uuid) from public, anon;
grant execute on function public.read_my_security_settings(uuid) to authenticated;

create or replace function public.save_my_security_settings(p_workspace_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_allowed constant text[] := array[
    'antiban_preset','simulate_typing','min_typing_ms','max_typing_ms','split_long_messages',
    'debounce_seconds','pause_on_human_reply','human_pause_minutes','max_replies_per_minute_per_contact',
    'proactive_min_delay_sec','proactive_max_delay_sec','daily_proactive_limit',
    'schedule_mode','schedule_start','schedule_end','schedule_work_days','schedule_timezone',
    'off_hours_reply_message',
    'admin_alert_enabled','admin_alert_whatsapp','admin_alert_events','admin_alert_include_messages'
  ];
  v_valid_events constant text[] := array[
    'handoff','silent_handoff','uncertain_send','error','safety','chip_disconnected','campaign_uncertain'
  ];
  v_key text;
  v_new jsonb;
  v_whatsapp text;
  v_events text[];
  v_days integer[];
  v_tz text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Invalid settings' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_settings) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Unknown security setting: %', left(v_key, 60) using errcode = '22023';
    end if;
  end loop;

  v_new := (private.security_settings_json(p_workspace_id) - 'updated_at') || p_settings;

  if (v_new ->> 'antiban_preset') not in ('conservador','equilibrado','moderado','personalizado') then
    raise exception 'Invalid antiban_preset' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'simulate_typing') <> 'boolean'
    or jsonb_typeof(v_new -> 'split_long_messages') <> 'boolean'
    or jsonb_typeof(v_new -> 'pause_on_human_reply') <> 'boolean'
    or jsonb_typeof(v_new -> 'admin_alert_enabled') <> 'boolean'
    or jsonb_typeof(v_new -> 'admin_alert_include_messages') <> 'boolean' then
    raise exception 'Invalid boolean flag' using errcode = '22023';
  end if;
  if (v_new ->> 'min_typing_ms') !~ '^[0-9]{1,5}$' or (v_new ->> 'min_typing_ms')::integer not between 500 and 10000 then
    raise exception 'Invalid min_typing_ms' using errcode = '22023';
  end if;
  if (v_new ->> 'max_typing_ms') !~ '^[0-9]{1,5}$' or (v_new ->> 'max_typing_ms')::integer not between 1000 and 15000
    or (v_new ->> 'max_typing_ms')::integer < (v_new ->> 'min_typing_ms')::integer then
    raise exception 'Invalid max_typing_ms' using errcode = '22023';
  end if;
  if (v_new ->> 'debounce_seconds') !~ '^[0-9]{1,3}$' or (v_new ->> 'debounce_seconds')::integer not between 1 and 20 then
    raise exception 'Invalid debounce_seconds' using errcode = '22023';
  end if;
  if (v_new ->> 'human_pause_minutes') !~ '^[0-9]{1,4}$' or (v_new ->> 'human_pause_minutes')::integer not between 5 and 1440 then
    raise exception 'Invalid human_pause_minutes' using errcode = '22023';
  end if;
  if (v_new ->> 'max_replies_per_minute_per_contact') !~ '^[0-9]{1,2}$'
    or (v_new ->> 'max_replies_per_minute_per_contact')::integer not between 1 and 60 then
    raise exception 'Invalid max_replies_per_minute_per_contact' using errcode = '22023';
  end if;
  if (v_new ->> 'proactive_min_delay_sec') !~ '^[0-9]{1,3}$'
    or (v_new ->> 'proactive_min_delay_sec')::integer not between 20 and 600 then
    raise exception 'Invalid proactive_min_delay_sec' using errcode = '22023';
  end if;
  if (v_new ->> 'proactive_max_delay_sec') !~ '^[0-9]{1,3}$'
    or (v_new ->> 'proactive_max_delay_sec')::integer not between 30 and 900
    or (v_new ->> 'proactive_max_delay_sec')::integer < (v_new ->> 'proactive_min_delay_sec')::integer then
    raise exception 'Invalid proactive_max_delay_sec' using errcode = '22023';
  end if;
  if (v_new ->> 'daily_proactive_limit') !~ '^[0-9]{1,3}$'
    or (v_new ->> 'daily_proactive_limit')::integer not between 1 and 150 then
    raise exception 'Invalid daily_proactive_limit' using errcode = '22023';
  end if;
  if (v_new ->> 'schedule_mode') not in ('always','business_hours_only','outside_hours_only') then
    raise exception 'Invalid schedule_mode' using errcode = '22023';
  end if;
  if coalesce(v_new ->> 'schedule_start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(v_new ->> 'schedule_end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'Invalid schedule time' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'schedule_work_days') <> 'array' or jsonb_array_length(v_new -> 'schedule_work_days') > 7 then
    raise exception 'Invalid schedule_work_days' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_new -> 'schedule_work_days') d
    where jsonb_typeof(d) <> 'number' or (d #>> '{}') !~ '^[0-6]$'
  ) then
    raise exception 'Invalid schedule_work_days' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct (d #>> '{}')::integer order by (d #>> '{}')::integer), array[]::integer[])
  into v_days
  from jsonb_array_elements(v_new -> 'schedule_work_days') d;

  v_tz := btrim(coalesce(v_new ->> 'schedule_timezone', ''));
  if char_length(v_tz) not between 1 and 80 or not exists (select 1 from pg_timezone_names where name = v_tz) then
    raise exception 'Invalid schedule_timezone' using errcode = '22023';
  end if;

  if char_length(coalesce(v_new ->> 'off_hours_reply_message', '')) > 4000 then
    raise exception 'Invalid off_hours_reply_message' using errcode = '22023';
  end if;

  v_whatsapp := regexp_replace(coalesce(v_new ->> 'admin_alert_whatsapp', ''), '[^0-9]', '', 'g');
  if v_whatsapp <> '' and v_whatsapp !~ '^[0-9]{10,15}$' then
    raise exception 'Invalid admin_alert_whatsapp' using errcode = '22023';
  end if;
  if (v_new ->> 'admin_alert_enabled')::boolean and v_whatsapp = '' then
    raise exception 'admin_alert_whatsapp_required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_new -> 'admin_alert_events') <> 'array' or jsonb_array_length(v_new -> 'admin_alert_events') > 15 then
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

  insert into public.workspace_ai_settings as s (
    workspace_id, antiban_preset, simulate_typing, min_typing_ms, max_typing_ms,
    split_long_messages, debounce_seconds, pause_on_human_reply, human_pause_minutes,
    max_replies_per_minute_per_contact, proactive_min_delay_sec, proactive_max_delay_sec,
    daily_proactive_limit, schedule_mode, schedule_start, schedule_end, schedule_work_days,
    schedule_timezone, off_hours_reply_message,
    admin_alert_enabled, admin_alert_whatsapp, admin_alert_events, admin_alert_include_messages,
    updated_by
  )
  values (
    p_workspace_id, v_new ->> 'antiban_preset', (v_new ->> 'simulate_typing')::boolean,
    (v_new ->> 'min_typing_ms')::integer, (v_new ->> 'max_typing_ms')::integer,
    (v_new ->> 'split_long_messages')::boolean, (v_new ->> 'debounce_seconds')::integer,
    (v_new ->> 'pause_on_human_reply')::boolean, (v_new ->> 'human_pause_minutes')::integer,
    (v_new ->> 'max_replies_per_minute_per_contact')::integer,
    (v_new ->> 'proactive_min_delay_sec')::integer, (v_new ->> 'proactive_max_delay_sec')::integer,
    (v_new ->> 'daily_proactive_limit')::integer,
    v_new ->> 'schedule_mode', v_new ->> 'schedule_start', v_new ->> 'schedule_end', v_days,
    v_tz, btrim(coalesce(v_new ->> 'off_hours_reply_message', '')),
    (v_new ->> 'admin_alert_enabled')::boolean, v_whatsapp, v_events,
    (v_new ->> 'admin_alert_include_messages')::boolean, v_actor
  )
  on conflict (workspace_id) do update set
    antiban_preset = excluded.antiban_preset,
    simulate_typing = excluded.simulate_typing,
    min_typing_ms = excluded.min_typing_ms,
    max_typing_ms = excluded.max_typing_ms,
    split_long_messages = excluded.split_long_messages,
    debounce_seconds = excluded.debounce_seconds,
    pause_on_human_reply = excluded.pause_on_human_reply,
    human_pause_minutes = excluded.human_pause_minutes,
    max_replies_per_minute_per_contact = excluded.max_replies_per_minute_per_contact,
    proactive_min_delay_sec = excluded.proactive_min_delay_sec,
    proactive_max_delay_sec = excluded.proactive_max_delay_sec,
    daily_proactive_limit = excluded.daily_proactive_limit,
    schedule_mode = excluded.schedule_mode,
    schedule_start = excluded.schedule_start,
    schedule_end = excluded.schedule_end,
    schedule_work_days = excluded.schedule_work_days,
    schedule_timezone = excluded.schedule_timezone,
    off_hours_reply_message = excluded.off_hours_reply_message,
    admin_alert_enabled = excluded.admin_alert_enabled,
    admin_alert_whatsapp = excluded.admin_alert_whatsapp,
    admin_alert_events = excluded.admin_alert_events,
    admin_alert_include_messages = excluded.admin_alert_include_messages,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','security_settings_updated','workspace',p_workspace_id::text,
    jsonb_build_object('changed', p_settings - 'admin_alert_whatsapp'));

  return public.read_my_security_settings(p_workspace_id);
end;
$$;

revoke all on function public.save_my_security_settings(uuid,jsonb) from public, anon;
grant execute on function public.save_my_security_settings(uuid,jsonb) to authenticated;

-- =============================================================================================
-- 2. Contatos Ignorados (whitelist/blacklist unificada) e Horário de Atendimento
-- =============================================================================================

create table public.security_ignored_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  phone_digits text not null check (phone_digits ~ '^[1-9][0-9]{7,14}$'),
  phone_core text not null check (phone_core ~ '^[1-9][0-9]{6,14}$'),
  note text not null default '' check (char_length(note) <= 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, phone_core)
);

create index security_ignored_numbers_ws_idx on public.security_ignored_numbers(workspace_id, created_at desc);

alter table public.security_ignored_numbers enable row level security;
revoke all on public.security_ignored_numbers from anon, authenticated;
grant select on public.security_ignored_numbers to authenticated;
grant all on public.security_ignored_numbers to service_role;

create policy security_ignored_select_member on public.security_ignored_numbers
  for select to authenticated using (private.is_workspace_member(workspace_id));

create or replace function private.is_within_schedule(
  p_mode text,
  p_start text,
  p_end text,
  p_days integer[],
  p_tz text,
  p_at timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_local timestamp;
  v_dow integer;
  v_time time;
  v_start time;
  v_end time;
  v_in_window boolean;
begin
  if p_mode is null or p_mode = 'always' then
    return true;
  end if;
  v_local := p_at at time zone coalesce(nullif(p_tz, ''), 'America/Fortaleza');
  v_dow := extract(dow from v_local)::integer;
  v_time := v_local::time;
  v_start := coalesce(nullif(p_start, ''), '08:00')::time;
  v_end := coalesce(nullif(p_end, ''), '18:00')::time;

  v_in_window := (v_dow = any (coalesce(p_days, array[]::integer[])))
    and case
      when v_start <= v_end then (v_time >= v_start and v_time <= v_end)
      else (v_time >= v_start or v_time <= v_end)
    end;

  if p_mode = 'business_hours_only' then
    return v_in_window;
  end if;
  return not v_in_window;
end;
$$;

revoke all on function private.is_within_schedule(text,text,text,integer[],text,timestamptz) from public, anon, authenticated;

create or replace function private.normalize_phone_digits(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d ~ '^[1-9][0-9]{7,14}$' then d
    else null
  end
  from (
    select case
      when length(d1) in (10, 11) and left(d1, 2) <> '55' and substr(d1, 1, 2)::integer between 11 and 99
        then '55' || d1
      else d1
    end as d
    from (
      select case
        when raw_d ~ '^00[0-9]{8,}$' then substr(raw_d, 3)
        when length(raw_d) in (11, 12) and left(raw_d, 1) = '0' then substr(raw_d, 2)
        else raw_d
      end as d1
      from (select regexp_replace(split_part(coalesce(p_raw, ''), '@', 1), '[^0-9]', '', 'g') as raw_d) s0
    ) s1
  ) s2
$$;

revoke all on function private.normalize_phone_digits(text) from public, anon, authenticated;

create or replace function private.suppression_reason_for_phone(p_workspace_id uuid, p_phone_or_jid text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_core text := private.phone_core(split_part(coalesce(p_phone_or_jid, ''), '@', 1));
  v_ct record;
begin
  if v_core = '' then
    return 'invalid_phone';
  end if;
  if exists (
    select 1 from public.instances o
    where o.workspace_id = p_workspace_id and o.status <> 'revoked' and o.connected_phone is not null
      and private.phone_core(o.connected_phone) = v_core
  ) then
    return 'own_chip';
  end if;
  if exists (
    select 1 from public.security_ignored_numbers i
    where i.workspace_id = p_workspace_id and i.phone_core = v_core
  ) then
    return 'ignored';
  end if;
  for v_ct in
    select ct.ai_ignored, ct.is_blocked, ct.consent_status
    from public.contacts ct
    where ct.workspace_id = p_workspace_id
      and ct.erased_at is null
      and (
        (ct.phone_e164 is not null and private.phone_core(ct.phone_e164) = v_core)
        or (ct.external_user_id is not null and private.phone_core(ct.external_user_id) = v_core)
      )
  loop
    if v_ct.consent_status = 'opted_out' then return 'opted_out'; end if;
    if v_ct.is_blocked then return 'blocked'; end if;
    if v_ct.ai_ignored then return 'ignored'; end if;
  end loop;
  return null;
end;
$$;

revoke all on function private.suppression_reason_for_phone(uuid,text) from public, anon, authenticated;

-- Atualiza ai_block_reason com security_ignored_numbers + janela de horário.
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
  v_sec jsonb;
  v_days integer[];
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
    select 1 from public.security_ignored_numbers ign
    where ign.workspace_id = p_workspace_id
      and ign.phone_core = private.phone_core(coalesce(v_contact.phone_e164, v_contact.external_user_id))
  ) then
    return 'contact_ignored';
  end if;

  if exists (
    select 1 from public.instances o
    where o.workspace_id = p_workspace_id and o.status <> 'revoked' and o.connected_phone is not null
      and private.phone_core(o.connected_phone) = private.phone_core(v_contact.external_user_id)) then
    return 'own_chip';
  end if;

  v_sec := private.security_settings_json(p_workspace_id);
  if (v_sec ->> 'schedule_mode') <> 'always' then
    select coalesce(array_agg((d #>> '{}')::integer), array[]::integer[])
    into v_days
    from jsonb_array_elements(v_sec -> 'schedule_work_days') d;
    if not private.is_within_schedule(
      v_sec ->> 'schedule_mode',
      v_sec ->> 'schedule_start',
      v_sec ->> 'schedule_end',
      v_days,
      v_sec ->> 'schedule_timezone'
    ) then
      return 'outside_hours';
    end if;
  end if;

  return null;
end;
$$;
revoke all on function private.ai_block_reason(uuid, uuid) from public, anon, authenticated;

-- Atualiza claim_ai_turn para respeitar max_replies_per_minute_per_contact configurado em Segurança
-- e informar typing bounds + engine da instância.
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
  v_sec jsonb;
  v_rate_min integer;
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

  v_sec := private.security_settings_json(p_workspace_id);
  v_rate_min := least(greatest(coalesce((v_sec ->> 'max_replies_per_minute_per_contact')::integer, 6), 1), 60);

  select count(*) filter (where t.claimed_at > clock_timestamp() - interval '1 minute'), count(*)
  into v_last_minute, v_last_hour
  from public.ai_turns t
  where t.workspace_id = p_workspace_id and t.conversation_id = v_turn.conversation_id
    and t.claimed_at > clock_timestamp() - interval '1 hour';
  if v_last_minute >= v_rate_min or v_last_hour >= greatest(v_rate_min * 10, 60) then
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
    'typing', jsonb_build_object(
      'min_ms', least(greatest(coalesce((v_sec ->> 'min_typing_ms')::integer, 1800), 500), 10000),
      'max_ms', least(greatest(coalesce((v_sec ->> 'max_typing_ms')::integer, 5200), 1000), 15000)
    ),
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
      'instance_engine', v_instance.engine,
      'provider_instance_name', v_instance.provider_instance_name),
    'messages', v_messages);
end;
$$;
revoke all on function public.claim_ai_turn(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_turn(uuid,uuid,uuid) to service_role;

create or replace function public.list_my_ignored_numbers(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_manual jsonb;
  v_contacts jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'name', i.name,
    'phone_digits', i.phone_digits,
    'note', i.note,
    'created_at', i.created_at
  ) order by i.created_at desc, i.id desc), '[]'::jsonb)
  into v_manual
  from public.security_ignored_numbers i
  where i.workspace_id = p_workspace_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'contact_id', c.id,
    'display_name', c.display_name,
    'phone_e164', c.phone_e164,
    'ai_ignored', c.ai_ignored,
    'is_blocked', c.is_blocked
  ) order by c.updated_at desc, c.id desc), '[]'::jsonb)
  into v_contacts
  from public.contacts c
  where c.workspace_id = p_workspace_id
    and c.erased_at is null
    and (c.ai_ignored or c.is_blocked);

  return jsonb_build_object('manual', v_manual, 'contacts', v_contacts);
end;
$$;
revoke all on function public.list_my_ignored_numbers(uuid) from public, anon;
grant execute on function public.list_my_ignored_numbers(uuid) to authenticated;

-- =============================================================================================
-- 3. Fila Segura (abordagem ativa anti-bloqueio em fila)
-- =============================================================================================

create table public.proactive_queue_state (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  status text not null default 'idle' check (status in ('idle','running','paused','completed')),
  pause_reason text,
  mode text not null default 'auto_rotate' check (mode in ('auto_rotate','single')),
  fixed_instance_id uuid references public.instances(id) on delete set null,
  message_template text not null default '' check (char_length(message_template) <= 4000),
  next_send_at timestamptz,
  last_instance_id uuid,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.proactive_queue_state enable row level security;
revoke all on public.proactive_queue_state from anon, authenticated;
grant select on public.proactive_queue_state to authenticated;
grant all on public.proactive_queue_state to service_role;

create policy proactive_queue_state_select_member on public.proactive_queue_state
  for select to authenticated using (private.is_workspace_member(workspace_id));

create table public.proactive_queue_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  instance_id uuid references public.instances(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  recipient_name text not null default '' check (char_length(recipient_name) <= 160),
  recipient_phone text not null check (recipient_phone ~ '^[1-9][0-9]{7,14}$'),
  phone_core text not null check (phone_core ~ '^[1-9][0-9]{6,14}$'),
  rendered_body text not null check (char_length(rendered_body) between 1 and 4096),
  status text not null default 'pending'
    check (status in ('pending','sending','awaiting_human_confirmation','sent','failed','suppressed','cancelled')),
  suppression_reason text,
  error_detail text,
  provider_message_id text,
  idempotency_key text not null unique,
  local_command_id uuid,
  message_id uuid,
  position integer not null default 0,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index proactive_queue_items_ws_status_idx
  on public.proactive_queue_items(workspace_id, status, position, id);
create index proactive_queue_items_local_cmd_idx
  on public.proactive_queue_items(local_command_id) where local_command_id is not null;
create index proactive_queue_items_daily_idx
  on public.proactive_queue_items(workspace_id, instance_id, sent_at desc) where status = 'sent';

alter table public.proactive_queue_items enable row level security;
revoke all on public.proactive_queue_items from anon, authenticated;
grant select on public.proactive_queue_items to authenticated;
grant all on public.proactive_queue_items to service_role;

create policy proactive_queue_items_select_member on public.proactive_queue_items
  for select to authenticated using (private.is_workspace_member(workspace_id));

create or replace function public.read_my_proactive_queue(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sec jsonb;
  v_tz text;
  v_today_start timestamptz;
  v_state jsonb;
  v_items jsonb;
  v_counts jsonb;
  v_daily jsonb;
  v_chips jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  v_sec := private.security_settings_json(p_workspace_id);
  v_tz := coalesce(nullif(v_sec ->> 'schedule_timezone', ''), 'America/Fortaleza');
  v_today_start := (date_trunc('day', clock_timestamp() at time zone v_tz)) at time zone v_tz;

  select jsonb_build_object(
    'status', q.status,
    'pause_reason', q.pause_reason,
    'mode', q.mode,
    'fixed_instance_id', q.fixed_instance_id,
    'message_template', q.message_template,
    'next_send_at', q.next_send_at,
    'updated_at', q.updated_at
  )
  into v_state
  from public.proactive_queue_state q
  where q.workspace_id = p_workspace_id;

  if v_state is null then
    v_state := jsonb_build_object(
      'status', 'idle',
      'pause_reason', null,
      'mode', 'auto_rotate',
      'fixed_instance_id', null,
      'message_template', '',
      'next_send_at', null,
      'updated_at', null
    );
  end if;

  select jsonb_build_object(
    'pending', count(*) filter (where i.status = 'pending'),
    'sending', count(*) filter (where i.status = 'sending'),
    'awaiting_human_confirmation', count(*) filter (where i.status = 'awaiting_human_confirmation'),
    'sent', count(*) filter (where i.status = 'sent'),
    'failed', count(*) filter (where i.status = 'failed'),
    'suppressed', count(*) filter (where i.status = 'suppressed')
  )
  into v_counts
  from public.proactive_queue_items i
  where i.workspace_id = p_workspace_id and i.status <> 'cancelled';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id,
    'instance_id', i.instance_id,
    'recipient_name', i.recipient_name,
    'recipient_phone', i.recipient_phone,
    'rendered_body', i.rendered_body,
    'status', i.status,
    'suppression_reason', i.suppression_reason,
    'error_detail', i.error_detail,
    'sent_at', i.sent_at,
    'created_at', i.created_at
  ) order by i.position asc, i.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select * from public.proactive_queue_items
    where workspace_id = p_workspace_id and status <> 'cancelled'
    order by
      case when status in ('awaiting_human_confirmation','sending','pending') then 0 else 1 end,
      position asc,
      created_at desc
    limit 200
  ) i;

  select coalesce(jsonb_object_agg(t.instance_id::text, t.qtd), '{}'::jsonb)
  into v_daily
  from (
    select instance_id, count(*)::integer as qtd
    from public.proactive_queue_items
    where workspace_id = p_workspace_id
      and status = 'sent'
      and instance_id is not null
      and sent_at >= v_today_start
    group by instance_id
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ins.id,
    'display_name', ins.display_name,
    'engine', ins.engine,
    'status', ins.status,
    'purpose', ins.purpose,
    'connected_phone', ins.connected_phone
  ) order by ins.created_at asc), '[]'::jsonb)
  into v_chips
  from public.instances ins
  where ins.workspace_id = p_workspace_id
    and ins.status <> 'revoked'
    and ins.purpose in ('campaigns','both');

  return jsonb_build_object(
    'state', v_state,
    'counts', v_counts,
    'items', v_items,
    'daily_sent_by_chip', v_daily,
    'daily_limit', (v_sec ->> 'daily_proactive_limit')::integer,
    'chips', v_chips
  );
end;
$$;
revoke all on function public.read_my_proactive_queue(uuid) from public, anon;
grant execute on function public.read_my_proactive_queue(uuid) to authenticated;

create or replace function public.start_my_proactive_queue(
  p_workspace_id uuid,
  p_mode text,
  p_instance_id uuid,
  p_message_template text,
  p_recipients jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_mode text := case when p_mode = 'single' then 'single' else 'auto_rotate' end;
  v_tpl text := btrim(coalesce(p_message_template, ''));
  v_item jsonb;
  v_phone text;
  v_core text;
  v_name text;
  v_body text;
  v_suppression text;
  v_seen text[] := array[]::text[];
  v_pos integer := 0;
  v_eligible integer := 0;
  v_suppressed integer := 0;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  if char_length(v_tpl) not between 1 and 4000 then
    raise exception 'Invalid message template' using errcode = '22023';
  end if;
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) = 0
    or jsonb_array_length(p_recipients) > 500 then
    raise exception 'Invalid recipients list' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.proactive_queue_items q
    where q.workspace_id = p_workspace_id and q.status = 'awaiting_human_confirmation'
  ) then
    raise exception 'uncertain_send_pending' using errcode = 'P0001';
  end if;

  if v_mode = 'single' then
    if p_instance_id is null or not exists (
      select 1 from public.instances i
      where i.workspace_id = p_workspace_id and i.id = p_instance_id
        and i.status = 'connected' and i.purpose in ('campaigns','both')
    ) then
      raise exception 'chip_not_connected' using errcode = 'P0001';
    end if;
  else
    if not exists (
      select 1 from public.instances i
      where i.workspace_id = p_workspace_id
        and i.status = 'connected' and i.purpose in ('campaigns','both')
    ) then
      raise exception 'chip_not_connected' using errcode = 'P0001';
    end if;
  end if;

  -- Cancela pendentes antigos antes de montar o novo lote.
  update public.proactive_queue_items
  set status = 'cancelled'
  where workspace_id = p_workspace_id and status in ('pending','suppressed');

  for v_item in select jsonb_array_elements(p_recipients) loop
    v_pos := v_pos + 1;
    v_phone := private.normalize_phone_digits(v_item ->> 'phone');
    v_name := left(btrim(coalesce(v_item ->> 'name', '')), 160);
    if v_phone is null then
      v_suppressed := v_suppressed + 1;
      continue;
    end if;
    v_core := private.phone_core(v_phone);
    if v_core = any (v_seen) then
      v_suppressed := v_suppressed + 1;
      continue;
    end if;
    v_seen := array_append(v_seen, v_core);

    v_suppression := private.suppression_reason_for_phone(p_workspace_id, v_phone);
    v_body := replace(
      replace(
        replace(v_tpl, '{{nome}}', case when v_name <> '' then v_name else 'olá' end),
        '{{primeiro_nome}}',
        case when v_name <> '' then split_part(v_name, ' ', 1) else 'olá' end
      ),
      '{{telefone}}',
      v_phone
    );
    v_body := left(btrim(v_body), 4096);
    if v_body = '' then v_body := left(v_tpl, 4096); end if;

    insert into public.proactive_queue_items(
      workspace_id, recipient_name, recipient_phone, phone_core, rendered_body,
      status, suppression_reason, idempotency_key, position
    )
    values (
      p_workspace_id, v_name, v_phone, v_core, v_body,
      case when v_suppression is null then 'pending' else 'suppressed' end,
      v_suppression,
      'proactive-' || gen_random_uuid()::text,
      v_pos
    );

    if v_suppression is null then
      v_eligible := v_eligible + 1;
    else
      v_suppressed := v_suppressed + 1;
    end if;
  end loop;

  insert into public.proactive_queue_state(
    workspace_id, status, pause_reason, mode, fixed_instance_id, message_template, next_send_at, updated_by, updated_at
  )
  values (
    p_workspace_id,
    case when v_eligible > 0 then 'running' else 'completed' end,
    null,
    v_mode,
    case when v_mode = 'single' then p_instance_id else null end,
    v_tpl,
    clock_timestamp(),
    v_actor,
    now()
  )
  on conflict (workspace_id) do update set
    status = excluded.status,
    pause_reason = null,
    mode = excluded.mode,
    fixed_instance_id = excluded.fixed_instance_id,
    message_template = excluded.message_template,
    next_send_at = excluded.next_send_at,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,v_kind,'proactive_queue_started','workspace',p_workspace_id::text,
    jsonb_build_object('eligible',v_eligible,'suppressed',v_suppressed,'mode',v_mode));

  return jsonb_build_object('eligible', v_eligible, 'suppressed', v_suppressed);
end;
$$;
revoke all on function public.start_my_proactive_queue(uuid,text,uuid,text,jsonb) from public, anon;
grant execute on function public.start_my_proactive_queue(uuid,text,uuid,text,jsonb) to authenticated;

create or replace function public.pause_my_proactive_queue(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  update public.proactive_queue_state
  set status = 'paused', pause_reason = 'manual', updated_by = auth.uid(), updated_at = now()
  where workspace_id = p_workspace_id and status = 'running';
  return public.read_my_proactive_queue(p_workspace_id);
end;
$$;
revoke all on function public.pause_my_proactive_queue(uuid) from public, anon;
grant execute on function public.pause_my_proactive_queue(uuid) to authenticated;

create or replace function public.resume_my_proactive_queue(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.proactive_queue_items
    where workspace_id = p_workspace_id and status = 'awaiting_human_confirmation'
  ) then
    raise exception 'uncertain_send_pending' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.proactive_queue_items
    where workspace_id = p_workspace_id and status = 'pending'
  ) then
    update public.proactive_queue_state
    set status = 'completed', pause_reason = null, updated_by = auth.uid(), updated_at = now()
    where workspace_id = p_workspace_id;
  else
    update public.proactive_queue_state
    set status = 'running', pause_reason = null, next_send_at = clock_timestamp(), updated_by = auth.uid(), updated_at = now()
    where workspace_id = p_workspace_id;
  end if;
  return public.read_my_proactive_queue(p_workspace_id);
end;
$$;
revoke all on function public.resume_my_proactive_queue(uuid) from public, anon;
grant execute on function public.resume_my_proactive_queue(uuid) to authenticated;

create or replace function public.clear_my_proactive_queue(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  update public.proactive_queue_items
  set status = 'cancelled'
  where workspace_id = p_workspace_id and status in ('pending','suppressed');
  update public.proactive_queue_state
  set status = 'idle', pause_reason = null, updated_by = auth.uid(), updated_at = now()
  where workspace_id = p_workspace_id and status <> 'idle';
  return public.read_my_proactive_queue(p_workspace_id);
end;
$$;
revoke all on function public.clear_my_proactive_queue(uuid) from public, anon;
grant execute on function public.clear_my_proactive_queue(uuid) to authenticated;

create or replace function public.resolve_my_proactive_uncertain(
  p_workspace_id uuid,
  p_item_id uuid,
  p_confirmed_sent boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.proactive_queue_items%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  select * into v_item
  from public.proactive_queue_items
  where workspace_id = p_workspace_id and id = p_item_id
  for update;
  if not found or v_item.status <> 'awaiting_human_confirmation' then
    raise exception 'Uncertain item not found' using errcode = 'P0002';
  end if;

  update public.proactive_queue_items
  set status = case when p_confirmed_sent then 'sent' else 'failed' end,
      sent_at = case when p_confirmed_sent then coalesce(sent_at, clock_timestamp()) else sent_at end,
      error_detail = case when p_confirmed_sent then null else coalesce(error_detail, 'Confirmado manualmente que não saiu') end
  where id = v_item.id;

  if v_item.message_id is not null then
    perform private.finish_outbound_message(
      p_workspace_id,
      v_item.message_id,
      case when p_confirmed_sent then 'sent' else 'failed' end,
      null,
      v_actor,
      private.actor_kind_for(p_workspace_id, v_actor)
    );
  end if;

  if not exists (
    select 1 from public.proactive_queue_items
    where workspace_id = p_workspace_id and status = 'awaiting_human_confirmation'
  ) then
    update public.proactive_queue_state
    set pause_reason = case when pause_reason = 'uncertain_send' then 'manual' else pause_reason end,
        updated_by = v_actor,
        updated_at = now()
    where workspace_id = p_workspace_id;
  end if;

  return public.read_my_proactive_queue(p_workspace_id);
end;
$$;
revoke all on function public.resolve_my_proactive_uncertain(uuid,uuid,boolean) from public, anon;
grant execute on function public.resolve_my_proactive_uncertain(uuid,uuid,boolean) to authenticated;

-- Reconcilia contatos ignorados em add/remove (inclui cancelar fila segura e destinatários pendentes)
create or replace function public.add_my_ignored_number(
  p_workspace_id uuid,
  p_name text,
  p_phone text,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_name text := left(btrim(coalesce(p_name, '')), 160);
  v_digits text := private.normalize_phone_digits(p_phone);
  v_core text;
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if v_digits is null then
    raise exception 'Invalid phone number' using errcode = '22023';
  end if;
  if v_name = '' then
    v_name := '+' || v_digits;
  end if;
  v_core := private.phone_core(v_digits);
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  insert into public.security_ignored_numbers(workspace_id, name, phone_digits, phone_core, note, created_by)
  values (p_workspace_id, v_name, v_digits, v_core, v_note, v_actor)
  on conflict (workspace_id, phone_core) do update set
    name = excluded.name,
    phone_digits = excluded.phone_digits,
    note = excluded.note;

  update public.contacts
  set ai_ignored = true, updated_at = now()
  where workspace_id = p_workspace_id
    and erased_at is null
    and (
      (phone_e164 is not null and private.phone_core(phone_e164) = v_core)
      or (external_user_id is not null and private.phone_core(external_user_id) = v_core)
    );

  update public.proactive_queue_items
  set status = 'suppressed', suppression_reason = 'ignored'
  where workspace_id = p_workspace_id and status = 'pending' and phone_core = v_core;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,v_kind,'ignored_number_added','workspace',p_workspace_id::text,
    jsonb_build_object('phone_core',v_core));

  return public.list_my_ignored_numbers(p_workspace_id);
end;
$$;
revoke all on function public.add_my_ignored_number(uuid,text,text,text) from public, anon;
grant execute on function public.add_my_ignored_number(uuid,text,text,text) to authenticated;

create or replace function public.remove_my_ignored_number(
  p_workspace_id uuid,
  p_id uuid default null,
  p_contact_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_core text;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  if p_id is not null then
    delete from public.security_ignored_numbers
    where workspace_id = p_workspace_id and id = p_id
    returning phone_core into v_core;
    if v_core is not null then
      update public.contacts
      set ai_ignored = false, updated_at = now()
      where workspace_id = p_workspace_id and erased_at is null
        and (
          (phone_e164 is not null and private.phone_core(phone_e164) = v_core)
          or (external_user_id is not null and private.phone_core(external_user_id) = v_core)
        );
    end if;
  end if;

  if p_contact_id is not null then
    update public.contacts
    set ai_ignored = false, updated_at = now()
    where workspace_id = p_workspace_id and id = p_contact_id and erased_at is null
    returning private.phone_core(coalesce(phone_e164, external_user_id)) into v_core;
    if v_core is not null and v_core <> '' then
      delete from public.security_ignored_numbers
      where workspace_id = p_workspace_id and phone_core = v_core;
    end if;
  end if;

  return public.list_my_ignored_numbers(p_workspace_id);
end;
$$;
revoke all on function public.remove_my_ignored_number(uuid,uuid,uuid) from public, anon;
grant execute on function public.remove_my_ignored_number(uuid,uuid,uuid) to authenticated;

-- =============================================================================================
-- 4. Pastas de Mídia e Campanhas (disparos em lote com prévia e confirmação obrigatórias)
-- =============================================================================================

create table public.campaign_media_folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  kind text not null check (kind in ('image','audio')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create index campaign_media_folders_ws_idx on public.campaign_media_folders(workspace_id, kind, created_at desc);

alter table public.campaign_media_folders enable row level security;
revoke all on public.campaign_media_folders from anon, authenticated;
grant select on public.campaign_media_folders to authenticated;
grant all on public.campaign_media_folders to service_role;

create policy campaign_media_folders_select_member on public.campaign_media_folders
  for select to authenticated using (private.is_workspace_member(workspace_id));

create table public.campaign_media_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  folder_id uuid not null,
  kind text not null check (kind in ('image','audio')),
  object_key text not null,
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (char_length(content_type) between 1 and 120),
  byte_size bigint not null check (byte_size between 1 and 26214400),
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, object_key),
  foreign key (workspace_id, folder_id) references public.campaign_media_folders(workspace_id, id) on delete cascade
);

create index campaign_media_files_folder_idx on public.campaign_media_files(workspace_id, folder_id, sort_order, created_at);

alter table public.campaign_media_files enable row level security;
revoke all on public.campaign_media_files from anon, authenticated;
grant select on public.campaign_media_files to authenticated;
grant all on public.campaign_media_files to service_role;

create policy campaign_media_files_select_member on public.campaign_media_files
  for select to authenticated using (private.is_workspace_member(workspace_id));

-- Permite envio assinado pelo navegador para pastas de campanha além de conversas na Inbox.
create or replace function private.can_upload_media_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
    p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/envios/[a-zA-Z0-9_-]{16,80}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and exists (
      select 1
      from public.conversations c
      join public.workspace_memberships m
        on m.workspace_id = c.workspace_id and m.user_id = auth.uid() and m.status = 'active'
      where c.workspace_id = private.media_object_workspace(p_name)
        and c.id::text = split_part(p_name, '/', 2)
    )
  ) or (
    p_name ~ '^[0-9a-f-]{36}/campanhas/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and exists (
      select 1
      from public.campaign_media_folders f
      join public.workspace_memberships m
        on m.workspace_id = f.workspace_id and m.user_id = auth.uid() and m.status = 'active'
      where f.workspace_id = private.media_object_workspace(p_name)
        and f.id::text = split_part(p_name, '/', 3)
    )
  )
$$;
revoke all on function private.can_upload_media_object(text) from public, anon;
grant execute on function private.can_upload_media_object(text) to authenticated;

create or replace function public.list_my_campaign_media(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_folders jsonb;
  v_files jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'kind', f.kind,
    'created_at', f.created_at
  ) order by f.created_at desc, f.id desc), '[]'::jsonb)
  into v_folders
  from public.campaign_media_folders f
  where f.workspace_id = p_workspace_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', mf.id,
    'folder_id', mf.folder_id,
    'kind', mf.kind,
    'object_key', mf.object_key,
    'file_name', mf.file_name,
    'content_type', mf.content_type,
    'byte_size', mf.byte_size,
    'created_at', mf.created_at
  ) order by mf.sort_order asc, mf.created_at asc, mf.id asc), '[]'::jsonb)
  into v_files
  from public.campaign_media_files mf
  where mf.workspace_id = p_workspace_id;

  return jsonb_build_object('folders', v_folders, 'files', v_files);
end;
$$;
revoke all on function public.list_my_campaign_media(uuid) from public, anon;
grant execute on function public.list_my_campaign_media(uuid) to authenticated;

create or replace function public.create_my_campaign_media_folder(
  p_workspace_id uuid,
  p_name text,
  p_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := left(btrim(coalesce(p_name, '')), 120);
  v_folder public.campaign_media_folders%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if char_length(v_name) < 1 then
    raise exception 'Invalid folder name' using errcode = '22023';
  end if;
  if p_kind not in ('image','audio') then
    raise exception 'Invalid folder kind' using errcode = '22023';
  end if;

  insert into public.campaign_media_folders(workspace_id, name, kind, created_by)
  values (p_workspace_id, v_name, p_kind, v_actor)
  returning * into v_folder;

  return jsonb_build_object('id', v_folder.id, 'name', v_folder.name, 'kind', v_folder.kind, 'created_at', v_folder.created_at);
end;
$$;
revoke all on function public.create_my_campaign_media_folder(uuid,text,text) from public, anon;
grant execute on function public.create_my_campaign_media_folder(uuid,text,text) to authenticated;

create or replace function public.register_my_campaign_media_file(
  p_workspace_id uuid,
  p_folder_id uuid,
  p_file_id uuid,
  p_object_key text,
  p_file_name text,
  p_content_type text,
  p_byte_size bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_folder public.campaign_media_folders%rowtype;
  v_prefix text;
  v_file public.campaign_media_files%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  select * into v_folder
  from public.campaign_media_folders f
  where f.workspace_id = p_workspace_id and f.id = p_folder_id;
  if not found then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;

  v_prefix := p_workspace_id::text || '/campanhas/' || p_folder_id::text || '/' || p_file_id::text || '/';
  if p_object_key is null or left(p_object_key, char_length(v_prefix)) <> v_prefix then
    raise exception 'Invalid object key' using errcode = '22023';
  end if;
  if p_byte_size is null or p_byte_size not between 1 and 26214400 then
    raise exception 'Invalid byte size' using errcode = '22023';
  end if;

  insert into public.campaign_media_files(
    id, workspace_id, folder_id, kind, object_key, file_name, content_type, byte_size, created_by
  )
  values (
    p_file_id, p_workspace_id, p_folder_id, v_folder.kind, p_object_key,
    left(btrim(coalesce(p_file_name, 'arquivo')), 200),
    left(btrim(coalesce(p_content_type, 'application/octet-stream')), 120),
    p_byte_size,
    v_actor
  )
  returning * into v_file;

  return jsonb_build_object(
    'id', v_file.id,
    'folder_id', v_file.folder_id,
    'kind', v_file.kind,
    'object_key', v_file.object_key,
    'file_name', v_file.file_name,
    'content_type', v_file.content_type,
    'byte_size', v_file.byte_size,
    'created_at', v_file.created_at
  );
end;
$$;
revoke all on function public.register_my_campaign_media_file(uuid,uuid,uuid,text,text,text,bigint) from public, anon;
grant execute on function public.register_my_campaign_media_file(uuid,uuid,uuid,text,text,text,bigint) to authenticated;

create or replace function public.delete_my_campaign_media_file(p_workspace_id uuid, p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  delete from public.campaign_media_files
  where workspace_id = p_workspace_id and id = p_file_id
  returning object_key into v_key;
  if not found then
    raise exception 'File not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('deleted', true, 'object_key', v_key);
end;
$$;
revoke all on function public.delete_my_campaign_media_file(uuid,uuid) from public, anon;
grant execute on function public.delete_my_campaign_media_file(uuid,uuid) to authenticated;

create or replace function public.delete_my_campaign_media_folder(p_workspace_id uuid, p_folder_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys text[];
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  select coalesce(array_agg(object_key), array[]::text[]) into v_keys
  from public.campaign_media_files
  where workspace_id = p_workspace_id and folder_id = p_folder_id;

  delete from public.campaign_media_folders
  where workspace_id = p_workspace_id and id = p_folder_id;
  if not found then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object('deleted', true, 'object_keys', to_jsonb(v_keys));
end;
$$;
revoke all on function public.delete_my_campaign_media_folder(uuid,uuid) from public, anon;
grant execute on function public.delete_my_campaign_media_folder(uuid,uuid) to authenticated;

-- Extensões em campaigns, campaign_recipients e histórico por bloco (campaign_step_deliveries)
alter table public.campaigns
  add column distribution text not null default 'fixed' check (distribution in ('fixed','round_robin')),
  add column instance_ids uuid[] not null default array[]::uuid[],
  add column blocks jsonb not null default '[]'::jsonb,
  add column cadence jsonb not null default '{}'::jsonb,
  add column pause_reason text,
  add column pause_detail text,
  add column next_action_at timestamptz,
  add column batch_sent_count integer not null default 0 check (batch_sent_count >= 0),
  add column batch_target integer not null default 10 check (batch_target >= 1);

create index campaigns_runner_idx
  on public.campaigns(status, next_action_at)
  where status in ('scheduled','running');

alter table public.campaign_recipients
  add column custom_fields jsonb not null default '{}'::jsonb,
  add column current_step integer not null default 0 check (current_step >= 0),
  add column last_error text,
  add column delivered_at timestamptz,
  add column read_at timestamptz,
  add column replied_at timestamptz;

create table public.campaign_step_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  recipient_id uuid not null,
  instance_id uuid not null,
  step_index integer not null check (step_index >= 0),
  block_type text not null check (block_type in ('text','image','audio')),
  status text not null default 'sending'
    check (status in ('sending','awaiting_human_confirmation','sent','delivered','read','failed')),
  idempotency_key text not null,
  rendered_body text,
  media_file_id uuid,
  message_id uuid,
  local_command_id uuid,
  provider_message_id text,
  error_detail text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, campaign_id, recipient_id, step_index),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete cascade,
  foreign key (workspace_id, recipient_id) references public.campaign_recipients(workspace_id, id) on delete cascade,
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete restrict,
  foreign key (workspace_id, message_id) references public.messages(workspace_id, id) on delete restrict
);

create index campaign_step_deliveries_campaign_idx
  on public.campaign_step_deliveries(workspace_id, campaign_id, status, created_at desc);
create index campaign_step_deliveries_msg_idx
  on public.campaign_step_deliveries(workspace_id, message_id) where message_id is not null;
create index campaign_step_deliveries_local_cmd_idx
  on public.campaign_step_deliveries(local_command_id) where local_command_id is not null;

alter table public.campaign_step_deliveries enable row level security;
revoke all on public.campaign_step_deliveries from anon, authenticated;
grant select on public.campaign_step_deliveries to authenticated;
grant all on public.campaign_step_deliveries to service_role;

create policy campaign_step_deliveries_select_member on public.campaign_step_deliveries
  for select to authenticated using (private.is_workspace_member(workspace_id));

-- =============================================================================================
-- 5. RPCs de Campanhas para o Painel (authenticated com membership)
-- =============================================================================================

create or replace function public.list_my_campaigns(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'status', c.status,
    'distribution', c.distribution,
    'instance_ids', to_jsonb(c.instance_ids),
    'blocks', c.blocks,
    'cadence', c.cadence,
    'pause_reason', c.pause_reason,
    'pause_detail', c.pause_detail,
    'scheduled_for', c.scheduled_for,
    'confirmed_at', c.confirmed_at,
    'started_at', c.started_at,
    'finished_at', c.finished_at,
    'created_at', c.created_at,
    'updated_at', c.updated_at,
    'stats', (
      select jsonb_build_object(
        'total', count(*),
        'eligible', count(*) filter (where r.send_allowed),
        'queued', count(*) filter (where r.status in ('pending','queued','sending')),
        'sent', count(*) filter (where r.status in ('sent','delivered','read','replied')),
        'delivered', count(*) filter (where r.status in ('delivered','read','replied')),
        'read', count(*) filter (where r.status in ('read','replied')),
        'replied', count(*) filter (where r.status = 'replied'),
        'failed', count(*) filter (where r.status = 'failed'),
        'suppressed', count(*) filter (where r.status = 'suppressed'),
        'uncertain', count(*) filter (where r.status = 'awaiting_human_confirmation'),
        'cancelled', count(*) filter (where r.status = 'cancelled')
      )
      from public.campaign_recipients r
      where r.workspace_id = c.workspace_id and r.campaign_id = c.id
    )
  ) order by c.created_at desc, c.id desc), '[]'::jsonb)
  into v_items
  from public.campaigns c
  where c.workspace_id = p_workspace_id;

  return v_items;
end;
$$;
revoke all on function public.list_my_campaigns(uuid) from public, anon;
grant execute on function public.list_my_campaigns(uuid) to authenticated;

create or replace function public.read_my_campaign(p_workspace_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_camp public.campaigns%rowtype;
  v_recipients jsonb;
  v_deliveries jsonb;
  v_stats jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select * into v_camp
  from public.campaigns c
  where c.workspace_id = p_workspace_id and c.id = p_campaign_id;
  if not found then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'total', count(*),
    'eligible', count(*) filter (where r.send_allowed),
    'queued', count(*) filter (where r.status in ('pending','queued','sending')),
    'sent', count(*) filter (where r.status in ('sent','delivered','read','replied')),
    'delivered', count(*) filter (where r.status in ('delivered','read','replied')),
    'read', count(*) filter (where r.status in ('read','replied')),
    'replied', count(*) filter (where r.status = 'replied'),
    'failed', count(*) filter (where r.status = 'failed'),
    'suppressed', count(*) filter (where r.status = 'suppressed'),
    'uncertain', count(*) filter (where r.status = 'awaiting_human_confirmation'),
    'cancelled', count(*) filter (where r.status = 'cancelled')
  )
  into v_stats
  from public.campaign_recipients r
  where r.workspace_id = p_workspace_id and r.campaign_id = p_campaign_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'contact_id', r.contact_id,
    'instance_id', r.instance_id,
    'instance_name', ins.display_name,
    'display_name', ct.display_name,
    'phone_e164', ct.phone_e164,
    'custom_fields', r.custom_fields,
    'status', r.status,
    'send_allowed', r.send_allowed,
    'suppression_reason', r.suppression_reason,
    'current_step', r.current_step,
    'last_error', r.last_error,
    'sent_at', r.sent_at,
    'delivered_at', r.delivered_at,
    'read_at', r.read_at,
    'replied_at', r.replied_at
  ) order by
    case when r.status = 'awaiting_human_confirmation' then 0
         when r.status = 'sending' then 1
         when r.status in ('queued','pending') then 2
         else 3 end,
    r.created_at asc,
    r.id asc), '[]'::jsonb)
  into v_recipients
  from (
    select * from public.campaign_recipients
    where workspace_id = p_workspace_id and campaign_id = p_campaign_id
    order by created_at asc, id asc
    limit 500
  ) r
  join public.contacts ct on ct.workspace_id = r.workspace_id and ct.id = r.contact_id
  left join public.instances ins on ins.workspace_id = r.workspace_id and ins.id = r.instance_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id,
    'recipient_id', d.recipient_id,
    'instance_id', d.instance_id,
    'step_index', d.step_index,
    'block_type', d.block_type,
    'status', d.status,
    'rendered_body', d.rendered_body,
    'media_file_id', d.media_file_id,
    'error_detail', d.error_detail,
    'created_at', d.created_at,
    'finished_at', d.finished_at
  ) order by d.created_at desc), '[]'::jsonb)
  into v_deliveries
  from public.campaign_step_deliveries d
  where d.workspace_id = p_workspace_id
    and d.campaign_id = p_campaign_id
    and (d.status = 'awaiting_human_confirmation' or d.status = 'failed' or d.status = 'sending');

  return jsonb_build_object(
    'campaign', jsonb_build_object(
      'id', v_camp.id,
      'name', v_camp.name,
      'status', v_camp.status,
      'distribution', v_camp.distribution,
      'instance_ids', to_jsonb(v_camp.instance_ids),
      'blocks', v_camp.blocks,
      'cadence', v_camp.cadence,
      'pause_reason', v_camp.pause_reason,
      'pause_detail', v_camp.pause_detail,
      'scheduled_for', v_camp.scheduled_for,
      'confirmed_at', v_camp.confirmed_at,
      'started_at', v_camp.started_at,
      'finished_at', v_camp.finished_at,
      'created_at', v_camp.created_at,
      'updated_at', v_camp.updated_at
    ),
    'stats', v_stats,
    'recipients', v_recipients,
    'attention_deliveries', v_deliveries
  );
end;
$$;
revoke all on function public.read_my_campaign(uuid,uuid) from public, anon;
grant execute on function public.read_my_campaign(uuid,uuid) to authenticated;

create or replace function public.save_my_campaign_draft(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_name text,
  p_distribution text,
  p_instance_ids uuid[],
  p_blocks jsonb,
  p_cadence jsonb,
  p_recipients jsonb,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_name text := left(btrim(coalesce(p_name, '')), 160);
  v_dist text := case when p_distribution = 'round_robin' then 'round_robin' else 'fixed' end;
  v_insts uuid[] := array[]::uuid[];
  v_summary text := '';
  v_camp public.campaigns%rowtype;
  v_item jsonb;
  v_phone text;
  v_core text;
  v_name_ct text;
  v_jid text;
  v_inst_id uuid;
  v_contact_id uuid;
  v_suppression text;
  v_seen text[] := array[]::text[];
  v_idx integer := 0;
  v_fields jsonb;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  if char_length(v_name) not between 1 and 160 then
    raise exception 'Invalid campaign name' using errcode = '22023';
  end if;
  if p_blocks is null or jsonb_typeof(p_blocks) <> 'array' or jsonb_array_length(p_blocks) not between 1 and 15 then
    raise exception 'Invalid campaign blocks' using errcode = '22023';
  end if;
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) > 5000 then
    raise exception 'Invalid recipients list' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct i.id), array[]::uuid[])
  into v_insts
  from public.instances i
  where i.workspace_id = p_workspace_id
    and i.id = any (coalesce(p_instance_ids, array[]::uuid[]))
    and i.status <> 'revoked'
    and i.purpose in ('campaigns','both');

  if coalesce(array_length(v_insts, 1), 0) = 0 then
    raise exception 'campaign_chip_required' using errcode = 'P0001';
  end if;
  if v_dist = 'fixed' then
    v_insts := array[v_insts[1]];
  end if;

  v_summary := left(coalesce(nullif(btrim((p_blocks -> 0 -> 'texts' ->> 0)), ''), 'Campanha em blocos'), 4000);

  if p_campaign_id is not null then
    select * into v_camp
    from public.campaigns c
    where c.workspace_id = p_workspace_id and c.id = p_campaign_id
    for update;
    if not found then
      raise exception 'Campaign not found' using errcode = 'P0002';
    end if;
    if v_camp.status not in ('draft','awaiting_confirmation') then
      raise exception 'campaign_locked' using errcode = 'P0001';
    end if;

    update public.campaigns
    set name = v_name,
        status = 'draft',
        text_body = v_summary,
        distribution = v_dist,
        instance_ids = v_insts,
        blocks = p_blocks,
        cadence = coalesce(p_cadence, '{}'::jsonb),
        scheduled_for = p_scheduled_for,
        confirmed_by = null,
        confirmed_at = null,
        pause_reason = null,
        pause_detail = null,
        updated_at = now()
    where id = v_camp.id
    returning * into v_camp;

    delete from public.campaign_recipients
    where workspace_id = p_workspace_id and campaign_id = v_camp.id;
  else
    insert into public.campaigns(
      workspace_id, name, status, text_body, distribution, instance_ids, blocks, cadence,
      scheduled_for, created_by
    )
    values (
      p_workspace_id, v_name, 'draft', v_summary, v_dist, v_insts, p_blocks,
      coalesce(p_cadence, '{}'::jsonb), p_scheduled_for, v_actor
    )
    returning * into v_camp;
  end if;

  for v_item in select jsonb_array_elements(p_recipients) loop
    v_phone := private.normalize_phone_digits(v_item ->> 'phone');
    if v_phone is null then
      continue;
    end if;
    v_core := private.phone_core(v_phone);
    if v_core = any (v_seen) then
      continue;
    end if;
    v_seen := array_append(v_seen, v_core);
    v_idx := v_idx + 1;

    v_inst_id := v_insts[((v_idx - 1) % array_length(v_insts, 1)) + 1];
    v_name_ct := left(btrim(coalesce(v_item ->> 'name', '')), 160);
    v_jid := v_phone || '@s.whatsapp.net';
    v_fields := case when jsonb_typeof(v_item -> 'fields') = 'object' then v_item -> 'fields' else '{}'::jsonb end;

    select ct.id into v_contact_id
    from public.contacts ct
    where ct.workspace_id = p_workspace_id
      and ct.erased_at is null
      and (
        (ct.external_user_id is not null and private.phone_core(ct.external_user_id) = v_core)
        or (ct.phone_e164 is not null and private.phone_core(ct.phone_e164) = v_core)
      )
    order by (ct.instance_id = v_inst_id) desc, ct.created_at asc
    limit 1;

    if v_contact_id is null then
      insert into public.contacts(workspace_id, instance_id, channel, external_user_id, display_name, phone_e164)
      values (p_workspace_id, v_inst_id, 'whatsapp', v_jid, v_name_ct, '+' || v_phone)
      on conflict (workspace_id, channel, instance_id, external_user_id)
        where external_user_id is not null and erased_at is null
      do update set
        display_name = case when public.contacts.display_name in ('','Contato') and excluded.display_name <> ''
                            then excluded.display_name else public.contacts.display_name end,
        phone_e164 = coalesce(public.contacts.phone_e164, excluded.phone_e164),
        updated_at = now()
      returning id into v_contact_id;
    elsif v_name_ct <> '' then
      update public.contacts
      set display_name = case when display_name in ('','Contato') then v_name_ct else display_name end,
          updated_at = now()
      where workspace_id = p_workspace_id and id = v_contact_id;
    end if;

    v_suppression := private.suppression_reason_for_phone(p_workspace_id, v_phone);

    insert into public.campaign_recipients(
      workspace_id, campaign_id, contact_id, instance_id, status,
      eligibility_checked_at, send_allowed, suppression_reason,
      idempotency_key, custom_fields, current_step
    )
    values (
      p_workspace_id, v_camp.id, v_contact_id, v_inst_id,
      case when v_suppression is null then 'pending' else 'suppressed' end,
      now(), v_suppression is null, v_suppression,
      'camp-' || replace(v_camp.id::text, '-', '') || '-' || replace(v_contact_id::text, '-', ''),
      v_fields,
      0
    )
    on conflict (workspace_id, campaign_id, contact_id) do nothing;
  end loop;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,v_kind,'campaign_draft_saved','campaign',v_camp.id::text,
    jsonb_build_object('recipients_imported', v_idx, 'blocks', jsonb_array_length(p_blocks)));

  return public.read_my_campaign(p_workspace_id, v_camp.id);
end;
$$;
revoke all on function public.save_my_campaign_draft(uuid,uuid,text,text,uuid[],jsonb,jsonb,jsonb,timestamptz) from public, anon;
grant execute on function public.save_my_campaign_draft(uuid,uuid,text,text,uuid[],jsonb,jsonb,jsonb,timestamptz) to authenticated;

create or replace function public.prepare_my_campaign_preview(p_workspace_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camp public.campaigns%rowtype;
  v_block jsonb;
  v_folder_id uuid;
  v_rec record;
  v_sup text;
  v_eligible integer := 0;
  v_suppressed integer := 0;
  v_samples jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select * into v_camp
  from public.campaigns c
  where c.workspace_id = p_workspace_id and c.id = p_campaign_id
  for update;
  if not found then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;
  if v_camp.status not in ('draft','awaiting_confirmation') then
    raise exception 'campaign_locked' using errcode = 'P0001';
  end if;

  -- Valida todos os blocos de texto e pastas de mídia antes de liberar confirmação.
  for v_block in select jsonb_array_elements(v_camp.blocks) loop
    if (v_block ->> 'type') = 'text' then
      if not exists (
        select 1 from jsonb_array_elements_text(coalesce(v_block -> 'texts', '[]'::jsonb)) t
        where btrim(t) <> ''
      ) then
        raise exception 'empty_text_block' using errcode = 'P0001';
      end if;
    elsif (v_block ->> 'type') in ('image','audio') then
      v_folder_id := nullif(v_block ->> 'folder_id', '')::uuid;
      if v_folder_id is null or not exists (
        select 1 from public.campaign_media_files mf
        where mf.workspace_id = p_workspace_id
          and mf.folder_id = v_folder_id
          and mf.kind = (v_block ->> 'type')
      ) then
        raise exception 'media_folder_empty' using errcode = 'P0001';
      end if;
    end if;
  end loop;

  -- Reavalia elegibilidade de cada destinatário agora.
  for v_rec in
    select r.id, ct.phone_e164, ct.external_user_id, ct.display_name, r.custom_fields
    from public.campaign_recipients r
    join public.contacts ct on ct.workspace_id = r.workspace_id and ct.id = r.contact_id
    where r.workspace_id = p_workspace_id and r.campaign_id = p_campaign_id
    order by r.created_at asc, r.id asc
  loop
    v_sup := private.suppression_reason_for_phone(p_workspace_id, coalesce(v_rec.phone_e164, v_rec.external_user_id));
    update public.campaign_recipients
    set status = case when v_sup is null then 'pending' else 'suppressed' end,
        send_allowed = v_sup is null,
        suppression_reason = v_sup,
        eligibility_checked_at = now()
    where id = v_rec.id;

    if v_sup is null then
      v_eligible := v_eligible + 1;
      if jsonb_array_length(v_samples) < 5 then
        v_samples := v_samples || jsonb_build_array(jsonb_build_object(
          'recipient_id', v_rec.id,
          'name', v_rec.display_name,
          'phone', v_rec.phone_e164,
          'custom_fields', v_rec.custom_fields
        ));
      end if;
    else
      v_suppressed := v_suppressed + 1;
    end if;
  end loop;

  if v_eligible = 0 then
    raise exception 'no_eligible_recipients' using errcode = 'P0001';
  end if;

  update public.campaigns
  set status = 'awaiting_confirmation', updated_at = now()
  where id = v_camp.id;

  return jsonb_build_object(
    'eligible', v_eligible,
    'suppressed', v_suppressed,
    'samples', v_samples,
    'detail', public.read_my_campaign(p_workspace_id, p_campaign_id)
  );
end;
$$;
revoke all on function public.prepare_my_campaign_preview(uuid,uuid) from public, anon;
grant execute on function public.prepare_my_campaign_preview(uuid,uuid) to authenticated;

create or replace function public.confirm_my_campaign(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_camp public.campaigns%rowtype;
  v_sched timestamptz := coalesce(p_scheduled_for, null);
  v_batch_min integer;
  v_batch_max integer;
  v_target integer;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  select * into v_camp
  from public.campaigns c
  where c.workspace_id = p_workspace_id and c.id = p_campaign_id
  for update;
  if not found then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;
  if v_camp.status <> 'awaiting_confirmation' then
    raise exception 'preview_required_before_confirm' using errcode = 'P0001';
  end if;
  if v_sched is null then
    v_sched := v_camp.scheduled_for;
  end if;

  if not exists (
    select 1 from public.instances i
    where i.workspace_id = p_workspace_id
      and i.id = any (v_camp.instance_ids)
      and i.status = 'connected'
      and i.purpose in ('campaigns','both')
  ) then
    raise exception 'chip_not_connected' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.campaign_recipients r
    where r.workspace_id = p_workspace_id and r.campaign_id = p_campaign_id and r.status = 'pending' and r.send_allowed
  ) then
    raise exception 'no_eligible_recipients' using errcode = 'P0001';
  end if;

  v_batch_min := least(greatest(coalesce((v_camp.cadence ->> 'batchMin')::integer, 8), 1), 100);
  v_batch_max := greatest(v_batch_min, least(coalesce((v_camp.cadence ->> 'batchMax')::integer, 15), 100));
  v_target := v_batch_min + floor(random() * (v_batch_max - v_batch_min + 1))::integer;

  update public.campaign_recipients
  set status = 'queued'
  where workspace_id = p_workspace_id and campaign_id = p_campaign_id and status = 'pending' and send_allowed;

  if v_sched is not null and v_sched > clock_timestamp() + interval '30 seconds' then
    update public.campaigns
    set status = 'scheduled',
        scheduled_for = v_sched,
        next_action_at = v_sched,
        confirmed_by = v_actor,
        confirmed_at = clock_timestamp(),
        batch_sent_count = 0,
        batch_target = v_target,
        pause_reason = null,
        pause_detail = null,
        updated_at = now()
    where id = v_camp.id;
  else
    update public.campaigns
    set status = 'running',
        scheduled_for = null,
        next_action_at = clock_timestamp(),
        confirmed_by = v_actor,
        confirmed_at = clock_timestamp(),
        started_at = coalesce(started_at, clock_timestamp()),
        batch_sent_count = 0,
        batch_target = v_target,
        pause_reason = null,
        pause_detail = null,
        updated_at = now()
    where id = v_camp.id;
  end if;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,v_kind,'campaign_confirmed','campaign',v_camp.id::text,
    jsonb_build_object('scheduled_for', v_sched));

  return public.read_my_campaign(p_workspace_id, p_campaign_id);
end;
$$;
revoke all on function public.confirm_my_campaign(uuid,uuid,timestamptz) from public, anon;
grant execute on function public.confirm_my_campaign(uuid,uuid,timestamptz) to authenticated;

create or replace function public.pause_my_campaign(p_workspace_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  update public.campaigns
  set status = 'paused', pause_reason = 'manual', pause_detail = 'Pausada pelo usuário', updated_at = now()
  where workspace_id = p_workspace_id and id = p_campaign_id and status in ('running','scheduled');
  if not found then
    raise exception 'Campaign cannot be paused' using errcode = 'P0001';
  end if;
  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,private.actor_kind_for(p_workspace_id, v_actor),'campaign_paused','campaign',p_campaign_id::text,'{}'::jsonb);
  return public.read_my_campaign(p_workspace_id, p_campaign_id);
end;
$$;
revoke all on function public.pause_my_campaign(uuid,uuid) from public, anon;
grant execute on function public.pause_my_campaign(uuid,uuid) to authenticated;

create or replace function public.resume_my_campaign(p_workspace_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_camp public.campaigns%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  select * into v_camp from public.campaigns
  where workspace_id = p_workspace_id and id = p_campaign_id for update;
  if not found or v_camp.status <> 'paused' then
    raise exception 'Campaign is not paused' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.campaign_step_deliveries d
    where d.workspace_id = p_workspace_id and d.campaign_id = p_campaign_id
      and d.status = 'awaiting_human_confirmation'
  ) then
    raise exception 'uncertain_send_pending' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.instances i
    where i.workspace_id = p_workspace_id
      and i.id = any (v_camp.instance_ids)
      and i.status = 'connected'
      and i.purpose in ('campaigns','both')
  ) then
    raise exception 'chip_not_connected' using errcode = 'P0001';
  end if;

  update public.campaigns
  set status = 'running',
      pause_reason = null,
      pause_detail = null,
      next_action_at = clock_timestamp(),
      updated_at = now()
  where id = v_camp.id;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,private.actor_kind_for(p_workspace_id, v_actor),'campaign_resumed','campaign',p_campaign_id::text,'{}'::jsonb);

  return public.read_my_campaign(p_workspace_id, p_campaign_id);
end;
$$;
revoke all on function public.resume_my_campaign(uuid,uuid) from public, anon;
grant execute on function public.resume_my_campaign(uuid,uuid) to authenticated;

create or replace function public.cancel_my_campaign(p_workspace_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  update public.campaigns
  set status = 'cancelled', finished_at = coalesce(finished_at, clock_timestamp()), updated_at = now()
  where workspace_id = p_workspace_id and id = p_campaign_id
    and status in ('draft','awaiting_confirmation','scheduled','running','paused');
  if not found then
    raise exception 'Campaign cannot be cancelled' using errcode = 'P0001';
  end if;

  update public.campaign_recipients
  set status = 'cancelled'
  where workspace_id = p_workspace_id and campaign_id = p_campaign_id
    and status in ('pending','queued');

  return public.read_my_campaign(p_workspace_id, p_campaign_id);
end;
$$;
revoke all on function public.cancel_my_campaign(uuid,uuid) from public, anon;
grant execute on function public.cancel_my_campaign(uuid,uuid) to authenticated;

create or replace function public.delete_my_campaign_draft(p_workspace_id uuid, p_campaign_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  delete from public.campaigns
  where workspace_id = p_workspace_id
    and id = p_campaign_id
    and status in ('draft','awaiting_confirmation','cancelled')
    and not exists (
      select 1 from public.campaign_step_deliveries d
      where d.workspace_id = p_workspace_id and d.campaign_id = p_campaign_id
    );
  if not found then
    raise exception 'Campaign cannot be deleted' using errcode = 'P0001';
  end if;
  return jsonb_build_object('deleted', true);
end;
$$;
revoke all on function public.delete_my_campaign_draft(uuid,uuid) from public, anon;
grant execute on function public.delete_my_campaign_draft(uuid,uuid) to authenticated;

-- Reavalia conclusão da campanha após finalizar um passo/destinatário
create or replace function private.recompute_campaign_completion(p_workspace_id uuid, p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.campaign_recipients r
    where r.workspace_id = p_workspace_id
      and r.campaign_id = p_campaign_id
      and r.status in ('pending','queued','sending','awaiting_human_confirmation')
  ) then
    update public.campaigns
    set status = 'completed',
        finished_at = coalesce(finished_at, clock_timestamp()),
        pause_reason = null,
        pause_detail = null,
        updated_at = now()
    where workspace_id = p_workspace_id
      and id = p_campaign_id
      and status in ('running','paused','scheduled');
  end if;
end;
$$;
revoke all on function private.recompute_campaign_completion(uuid,uuid) from public, anon, authenticated;

create or replace function public.resolve_my_campaign_uncertain(
  p_workspace_id uuid,
  p_campaign_id uuid,
  p_delivery_id uuid,
  p_confirmed_sent boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_del public.campaign_step_deliveries%rowtype;
  v_camp public.campaigns%rowtype;
  v_total_steps integer;
  v_next_step integer;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select * into v_del
  from public.campaign_step_deliveries d
  where d.workspace_id = p_workspace_id and d.campaign_id = p_campaign_id and d.id = p_delivery_id
  for update;
  if not found or v_del.status <> 'awaiting_human_confirmation' then
    raise exception 'Uncertain delivery not found' using errcode = 'P0002';
  end if;

  select * into v_camp from public.campaigns where workspace_id = p_workspace_id and id = p_campaign_id for update;
  v_total_steps := coalesce(jsonb_array_length(v_camp.blocks), 1);

  update public.campaign_step_deliveries
  set status = case when p_confirmed_sent then 'sent' else 'failed' end,
      finished_at = coalesce(finished_at, clock_timestamp()),
      error_detail = case when p_confirmed_sent then null else coalesce(error_detail, 'Confirmado manualmente que não saiu') end
  where id = v_del.id;

  if v_del.message_id is not null then
    perform private.finish_outbound_message(
      p_workspace_id,
      v_del.message_id,
      case when p_confirmed_sent then 'sent' else 'failed' end,
      null,
      v_actor,
      private.actor_kind_for(p_workspace_id, v_actor)
    );
  end if;

  if p_confirmed_sent then
    v_next_step := v_del.step_index + 1;
    if v_next_step >= v_total_steps then
      update public.campaign_recipients
      set status = 'sent', current_step = v_next_step, sent_at = coalesce(sent_at, clock_timestamp()), last_error = null
      where workspace_id = p_workspace_id and id = v_del.recipient_id;
    else
      update public.campaign_recipients
      set status = 'queued', current_step = v_next_step, last_error = null
      where workspace_id = p_workspace_id and id = v_del.recipient_id;
    end if;
  else
    update public.campaign_recipients
    set status = 'failed', last_error = coalesce(v_del.error_detail, 'Confirmado manualmente que não saiu')
    where workspace_id = p_workspace_id and id = v_del.recipient_id;
  end if;

  if not exists (
    select 1 from public.campaign_step_deliveries d
    where d.workspace_id = p_workspace_id and d.campaign_id = p_campaign_id and d.status = 'awaiting_human_confirmation'
  ) then
    update public.campaigns
    set pause_reason = case when pause_reason = 'uncertain_send' then 'manual' else pause_reason end,
        pause_detail = case when pause_reason = 'uncertain_send' then 'Envio conferido; clique em Retomar se quiser continuar.' else pause_detail end
    where id = p_campaign_id;
  end if;

  perform private.recompute_campaign_completion(p_workspace_id, p_campaign_id);
  return public.read_my_campaign(p_workspace_id, p_campaign_id);
end;
$$;
revoke all on function public.resolve_my_campaign_uncertain(uuid,uuid,uuid,boolean) from public, anon;
grant execute on function public.resolve_my_campaign_uncertain(uuid,uuid,uuid,boolean) to authenticated;

-- =============================================================================================
-- 6. RPCs de Serviço (cron, executor de campanhas, fila segura, alertas Baileys/desconexão)
-- =============================================================================================

-- Garante contato + conversa no WhatsApp para um telefone (usado por campanhas e fila segura).
create or replace function private.ensure_whatsapp_conversation(
  p_workspace_id uuid,
  p_instance_id uuid,
  p_phone_digits text,
  p_name text default ''
)
returns table(contact_id uuid, conversation_id uuid, recipient_jid text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jid text := p_phone_digits || '@s.whatsapp.net';
  v_core text := private.phone_core(p_phone_digits);
  v_contact_id uuid;
  v_conv_id uuid;
begin
  select ct.id into v_contact_id
  from public.contacts ct
  where ct.workspace_id = p_workspace_id
    and ct.erased_at is null
    and (
      (ct.instance_id = p_instance_id and ct.external_user_id is not null and private.phone_core(ct.external_user_id) = v_core)
      or (ct.phone_e164 is not null and private.phone_core(ct.phone_e164) = v_core)
    )
  order by (ct.instance_id = p_instance_id) desc, ct.created_at asc
  limit 1;

  if v_contact_id is null then
    insert into public.contacts(workspace_id, instance_id, channel, external_user_id, display_name, phone_e164)
    values (p_workspace_id, p_instance_id, 'whatsapp', v_jid, left(btrim(coalesce(p_name, '')), 160), '+' || p_phone_digits)
    on conflict (workspace_id, channel, instance_id, external_user_id)
      where external_user_id is not null and erased_at is null
    do update set
      phone_e164 = coalesce(public.contacts.phone_e164, excluded.phone_e164),
      updated_at = now()
    returning id into v_contact_id;
  end if;

  select ct.external_user_id into v_jid
  from public.contacts ct
  where ct.workspace_id = p_workspace_id and ct.id = v_contact_id;
  if v_jid is null or v_jid !~ '^[1-9][0-9]{7,14}@s[.]whatsapp[.]net$' then
    v_jid := p_phone_digits || '@s.whatsapp.net';
  end if;

  select c.id into v_conv_id
  from public.conversations c
  where c.workspace_id = p_workspace_id
    and c.contact_id = v_contact_id
    and c.instance_id = p_instance_id
    and c.stage not in ('resolved','archived')
  order by c.activity_at desc, c.id desc
  limit 1
  for update;

  if v_conv_id is null then
    insert into public.conversations(workspace_id, contact_id, instance_id, stage, unread_count)
    values (p_workspace_id, v_contact_id, p_instance_id, 'waiting_customer', 0)
    returning id into v_conv_id;
  end if;

  return query select v_contact_id, v_conv_id, v_jid;
end;
$$;
revoke all on function private.ensure_whatsapp_conversation(uuid,uuid,text,text) from public, anon, authenticated;

-- Finaliza resultado da fila segura e pausa automaticamente se houver envio incerto.
create or replace function private.apply_proactive_outcome(
  p_workspace_id uuid,
  p_item_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_error_detail text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.proactive_queue_items%rowtype;
  v_alert boolean := false;
begin
  select * into v_item
  from public.proactive_queue_items i
  where i.workspace_id = p_workspace_id and i.id = p_item_id
  for update;
  if not found or v_item.status <> 'sending' then
    return jsonb_build_object('result', 'ignored');
  end if;

  update public.proactive_queue_items
  set status = case
        when p_outcome = 'sent' then 'sent'
        when p_outcome = 'failed' then 'failed'
        else 'awaiting_human_confirmation'
      end,
      provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
      error_detail = nullif(left(btrim(coalesce(p_error_detail, '')), 500), ''),
      sent_at = case when p_outcome = 'sent' then clock_timestamp() else sent_at end
  where id = v_item.id;

  if p_outcome = 'uncertain' then
    v_alert := true;
    update public.proactive_queue_state
    set status = 'paused', pause_reason = 'uncertain_send', updated_at = now()
    where workspace_id = p_workspace_id;
  elsif not exists (
    select 1 from public.proactive_queue_items
    where workspace_id = p_workspace_id and status in ('pending','sending','awaiting_human_confirmation')
  ) then
    update public.proactive_queue_state
    set status = 'completed', pause_reason = null, updated_at = now()
    where workspace_id = p_workspace_id and status = 'running';
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'alert_uncertain', v_alert,
    'recipient_phone', v_item.recipient_phone,
    'recipient_name', v_item.recipient_name,
    'instance_id', v_item.instance_id
  );
end;
$$;
revoke all on function private.apply_proactive_outcome(uuid,uuid,text,text,text) from public, anon, authenticated;

create or replace function public.claim_due_proactive_items(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_state public.proactive_queue_state%rowtype;
  v_item public.proactive_queue_items%rowtype;
  v_sec jsonb;
  v_tz text;
  v_today_start timestamptz;
  v_daily_limit integer;
  v_min_delay integer;
  v_max_delay integer;
  v_delay integer;
  v_inst public.instances%rowtype;
  v_sup text;
  v_ctx record;
  v_msg_id uuid;
  v_cmd_id uuid;
  v_out jsonb := '[]'::jsonb;
begin
  for v_state in
    select q.*
    from public.proactive_queue_state q
    where q.status = 'running'
      and (q.next_send_at is null or q.next_send_at <= clock_timestamp())
    order by q.next_send_at asc nulls first
    limit v_limit
    for update skip locked
  loop
    if exists (
      select 1 from public.proactive_queue_items i
      where i.workspace_id = v_state.workspace_id and i.status = 'awaiting_human_confirmation'
    ) then
      update public.proactive_queue_state
      set status = 'paused', pause_reason = 'uncertain_send', updated_at = now()
      where workspace_id = v_state.workspace_id;
      continue;
    end if;

    v_sec := private.security_settings_json(v_state.workspace_id);
    v_tz := coalesce(nullif(v_sec ->> 'schedule_timezone', ''), 'America/Fortaleza');
    v_today_start := (date_trunc('day', clock_timestamp() at time zone v_tz)) at time zone v_tz;
    v_daily_limit := least(greatest(coalesce((v_sec ->> 'daily_proactive_limit')::integer, 25), 1), 150);
    v_min_delay := least(greatest(coalesce((v_sec ->> 'proactive_min_delay_sec')::integer, 45), 20), 600);
    v_max_delay := greatest(v_min_delay, least(coalesce((v_sec ->> 'proactive_max_delay_sec')::integer, 110), 900));

    -- Pula qualquer item cujo número passou a ser ignorado/bloqueado depois que a fila começou.
    loop
      select i.* into v_item
      from public.proactive_queue_items i
      where i.workspace_id = v_state.workspace_id and i.status = 'pending'
      order by i.position asc, i.created_at asc
      limit 1
      for update skip locked;

      if not found then
        v_item := null;
        exit;
      end if;

      v_sup := private.suppression_reason_for_phone(v_state.workspace_id, v_item.recipient_phone);
      if v_sup is not null then
        update public.proactive_queue_items
        set status = 'suppressed', suppression_reason = v_sup
        where id = v_item.id;
        continue;
      end if;
      exit;
    end loop;

    if v_item.id is null then
      if not exists (
        select 1 from public.proactive_queue_items i
        where i.workspace_id = v_state.workspace_id and i.status = 'sending'
      ) then
        update public.proactive_queue_state
        set status = 'completed', pause_reason = null, updated_at = now()
        where workspace_id = v_state.workspace_id;
      end if;
      continue;
    end if;

    -- Escolhe chip conectado apto para campanhas dentro do teto diário (sem trocar chip fixo!).
    v_inst := null;
    if v_state.mode = 'single' then
      select ins.* into v_inst
      from public.instances ins
      left join public.local_executors ex on ex.id = ins.local_executor_id
      where ins.workspace_id = v_state.workspace_id
        and ins.id = v_state.fixed_instance_id
        and ins.status = 'connected'
        and ins.purpose in ('campaigns','both')
        and (
          (ins.engine = 'evolution' and ins.provider_instance_name is not null)
          or (ins.engine = 'baileys' and ex.id is not null and ex.status = 'active' and ex.last_seen_at >= clock_timestamp() - interval '2 minutes')
        );
      if not found then
        update public.proactive_queue_state
        set status = 'paused', pause_reason = 'chip_offline', updated_at = now()
        where workspace_id = v_state.workspace_id;
        continue;
      end if;
      if (
        select count(*) from public.proactive_queue_items s
        where s.workspace_id = v_state.workspace_id and s.instance_id = v_inst.id
          and s.status = 'sent' and s.sent_at >= v_today_start
      ) >= v_daily_limit then
        update public.proactive_queue_state
        set status = 'paused', pause_reason = 'daily_limit', updated_at = now()
        where workspace_id = v_state.workspace_id;
        continue;
      end if;
    else
      select ins.* into v_inst
      from public.instances ins
      left join public.local_executors ex on ex.id = ins.local_executor_id
      where ins.workspace_id = v_state.workspace_id
        and ins.status = 'connected'
        and ins.purpose in ('campaigns','both')
        and (
          (ins.engine = 'evolution' and ins.provider_instance_name is not null)
          or (ins.engine = 'baileys' and ex.id is not null and ex.status = 'active' and ex.last_seen_at >= clock_timestamp() - interval '2 minutes')
        )
        and (
          select count(*) from public.proactive_queue_items s
          where s.workspace_id = v_state.workspace_id and s.instance_id = ins.id
            and s.status = 'sent' and s.sent_at >= v_today_start
        ) < v_daily_limit
      order by (ins.id = v_state.last_instance_id) asc, ins.created_at asc
      limit 1;

      if not found then
        update public.proactive_queue_state
        set status = 'paused',
            pause_reason = case when exists (
              select 1 from public.instances ins
              where ins.workspace_id = v_state.workspace_id and ins.status = 'connected' and ins.purpose in ('campaigns','both')
            ) then 'daily_limit' else 'chip_offline' end,
            updated_at = now()
        where workspace_id = v_state.workspace_id;
        continue;
      end if;
    end if;

    select * into v_ctx from private.ensure_whatsapp_conversation(
      v_state.workspace_id, v_inst.id, v_item.recipient_phone, v_item.recipient_name
    );

    v_msg_id := gen_random_uuid();
    insert into public.messages(
      id, workspace_id, conversation_id, instance_id, idempotency_key,
      direction, source_engine, actor_type, status, body_text, occurred_at
    )
    values (
      v_msg_id, v_state.workspace_id, v_ctx.conversation_id, v_inst.id, v_item.idempotency_key,
      'outbound', v_inst.engine, 'system', 'sending', v_item.rendered_body, clock_timestamp()
    );

    v_delay := v_min_delay + floor(random() * (v_max_delay - v_min_delay + 1))::integer;

    if v_inst.engine = 'baileys' then
      insert into public.local_motor_commands(
        workspace_id, executor_id, instance_id, command_type, payload, message_id
      )
      values (
        v_state.workspace_id, v_inst.local_executor_id, v_inst.id, 'send_text',
        jsonb_build_object('recipient', v_ctx.recipient_jid, 'body_text', v_item.rendered_body),
        v_msg_id
      )
      returning id into v_cmd_id;

      update public.proactive_queue_items
      set status = 'sending', instance_id = v_inst.id, contact_id = v_ctx.contact_id,
          message_id = v_msg_id, local_command_id = v_cmd_id
      where id = v_item.id;

      update public.proactive_queue_state
      set last_instance_id = v_inst.id,
          next_send_at = clock_timestamp() + make_interval(secs => v_delay),
          updated_at = now()
      where workspace_id = v_state.workspace_id;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'item_id', v_item.id, 'workspace_id', v_state.workspace_id, 'engine', 'baileys'
      ));
    else
      update public.proactive_queue_items
      set status = 'sending', instance_id = v_inst.id, contact_id = v_ctx.contact_id,
          message_id = v_msg_id
      where id = v_item.id;

      update public.proactive_queue_state
      set last_instance_id = v_inst.id,
          next_send_at = clock_timestamp() + make_interval(secs => v_delay),
          updated_at = now()
      where workspace_id = v_state.workspace_id;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'item_id', v_item.id,
        'workspace_id', v_state.workspace_id,
        'engine', 'evolution',
        'message_id', v_msg_id,
        'provider_instance_name', v_inst.provider_instance_name,
        'recipient', v_ctx.recipient_jid,
        'body_text', v_item.rendered_body
      ));
    end if;
  end loop;

  return v_out;
end;
$$;
revoke all on function public.claim_due_proactive_items(integer) from public, anon, authenticated;
grant execute on function public.claim_due_proactive_items(integer) to service_role;

create or replace function public.finish_proactive_item(
  p_workspace_id uuid,
  p_item_id uuid,
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
  v_item public.proactive_queue_items%rowtype;
  v_res jsonb;
begin
  if p_outcome not in ('sent','failed','uncertain') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;
  select * into v_item
  from public.proactive_queue_items
  where workspace_id = p_workspace_id and id = p_item_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_item.message_id is not null then
    perform private.finish_outbound_message(
      p_workspace_id, v_item.message_id, p_outcome,
      nullif(left(btrim(coalesce(p_provider_message_id, '')), 200), ''),
      null, 'service'
    );
  end if;
  v_res := private.apply_proactive_outcome(p_workspace_id, p_item_id, p_outcome, p_provider_message_id, p_error_detail);
  return v_res;
end;
$$;
revoke all on function public.finish_proactive_item(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.finish_proactive_item(uuid,uuid,text,text,text) to service_role;

-- Executor de Campanhas: 3 etapas atômicas (claim step -> dispatch payload -> finish delivery)
create or replace function public.claim_due_campaign_steps(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_camp public.campaigns%rowtype;
  v_rec public.campaign_recipients%rowtype;
  v_ct public.contacts%rowtype;
  v_inst public.instances%rowtype;
  v_exec public.local_executors%rowtype;
  v_sup text;
  v_total_steps integer;
  v_block jsonb;
  v_block_type text;
  v_del_id uuid;
  v_media_files jsonb;
  v_cad jsonb;
  v_tz text;
  v_today_start timestamptz;
  v_daily_limit integer;
  v_days integer[];
  v_int_min integer;
  v_int_max integer;
  v_step_sec integer;
  v_bmin integer;
  v_bmax integer;
  v_pmin integer;
  v_pmax integer;
  v_delay integer;
  v_next_batch integer;
  v_next_target integer;
  v_ai_keys jsonb := '{}'::jsonb;
  v_ai_settings jsonb := '{}'::jsonb;
  v_out jsonb := '[]'::jsonb;
  v_idx_done integer := 0;
begin
  -- Promove campanhas agendadas cuja hora chegou.
  update public.campaigns
  set status = 'running',
      started_at = coalesce(started_at, clock_timestamp()),
      next_action_at = coalesce(next_action_at, scheduled_for, clock_timestamp()),
      updated_at = now()
  where status = 'scheduled'
    and scheduled_for is not null
    and scheduled_for <= clock_timestamp();

  for v_camp in
    select c.*
    from public.campaigns c
    where c.status = 'running'
      and (c.next_action_at is null or c.next_action_at <= clock_timestamp())
    order by c.next_action_at asc nulls first, c.created_at asc
    limit v_limit
    for update skip locked
  loop
    v_idx_done := v_idx_done + 1;
    if v_idx_done > v_limit then exit; end if;

    if exists (
      select 1 from public.campaign_step_deliveries d
      where d.workspace_id = v_camp.workspace_id and d.campaign_id = v_camp.id
        and d.status = 'awaiting_human_confirmation'
    ) then
      update public.campaigns
      set status = 'paused', pause_reason = 'uncertain_send',
          pause_detail = 'Um envio ficou sem confirmação do WhatsApp.', updated_at = now()
      where id = v_camp.id;
      continue;
    end if;

    v_cad := coalesce(v_camp.cadence, '{}'::jsonb);
    v_tz := coalesce(nullif(v_cad ->> 'timezone', ''), v_camp.timezone, 'America/Fortaleza');

    if coalesce((v_cad ->> 'restrictHours')::boolean, false) then
      select coalesce(array_agg((d #>> '{}')::integer), array[1,2,3,4,5,6]::integer[])
      into v_days
      from jsonb_array_elements(coalesce(v_cad -> 'workDays', '[1,2,3,4,5,6]'::jsonb)) d;
      if not private.is_within_schedule(
        'business_hours_only',
        coalesce(v_cad ->> 'windowStart', '08:00'),
        coalesce(v_cad ->> 'windowEnd', '19:00'),
        v_days,
        v_tz
      ) then
        update public.campaigns
        set next_action_at = clock_timestamp() + interval '1 minute',
            pause_detail = 'Aguardando janela de horário configurada.'
        where id = v_camp.id;
        continue;
      end if;
    end if;

    v_total_steps := coalesce(jsonb_array_length(v_camp.blocks), 0);
    if v_total_steps < 1 then
      update public.campaigns
      set status = 'failed', pause_reason = 'no_blocks', finished_at = clock_timestamp(), updated_at = now()
      where id = v_camp.id;
      continue;
    end if;

    -- Encontra o próximo destinatário elegível (pulando suprimidos na hora).
    loop
      select r.* into v_rec
      from public.campaign_recipients r
      where r.workspace_id = v_camp.workspace_id
        and r.campaign_id = v_camp.id
        and r.status in ('queued','pending')
        and r.current_step < v_total_steps
      order by (r.current_step > 0) desc, r.created_at asc, r.id asc
      limit 1
      for update skip locked;

      if not found then
        v_rec := null;
        exit;
      end if;

      -- Se já existe entrega aberta para este passo (corrida ou trava), não reenvia.
      if exists (
        select 1 from public.campaign_step_deliveries d
        where d.workspace_id = v_camp.workspace_id
          and d.campaign_id = v_camp.id
          and d.recipient_id = v_rec.id
          and d.step_index = v_rec.current_step
      ) then
        if v_rec.current_step + 1 >= v_total_steps then
          update public.campaign_recipients set status = 'sent', sent_at = coalesce(sent_at, clock_timestamp())
          where id = v_rec.id;
        else
          update public.campaign_recipients set current_step = v_rec.current_step + 1 where id = v_rec.id;
        end if;
        continue;
      end if;

      select ct.* into v_ct from public.contacts ct
      where ct.workspace_id = v_camp.workspace_id and ct.id = v_rec.contact_id;
      v_sup := private.suppression_reason_for_phone(v_camp.workspace_id, coalesce(v_ct.phone_e164, v_ct.external_user_id));
      if v_sup is not null then
        update public.campaign_recipients
        set status = 'suppressed', send_allowed = false, suppression_reason = v_sup
        where id = v_rec.id;
        continue;
      end if;
      exit;
    end loop;

    if v_rec.id is null then
      perform private.recompute_campaign_completion(v_camp.workspace_id, v_camp.id);
      continue;
    end if;

    -- Confere chip do destinatário (sem fallback silencioso em modo fixo).
    v_daily_limit := least(greatest(coalesce((v_cad ->> 'dailyLimitPerChip')::integer, 0), 0), 2000);
    v_today_start := (date_trunc('day', clock_timestamp() at time zone v_tz)) at time zone v_tz;

    select i.* into v_inst
    from public.instances i
    where i.workspace_id = v_camp.workspace_id and i.id = v_rec.instance_id;

    if v_inst.id is null or v_inst.status <> 'connected' or v_inst.purpose not in ('campaigns','both')
      or (v_inst.engine = 'baileys' and not exists (
        select 1 from public.local_executors ex
        where ex.id = v_inst.local_executor_id and ex.status = 'active'
          and ex.last_seen_at >= clock_timestamp() - interval '2 minutes'
      )) then
      if v_camp.distribution = 'round_robin' then
        select i.* into v_inst
        from public.instances i
        left join public.local_executors ex on ex.id = i.local_executor_id
        where i.workspace_id = v_camp.workspace_id
          and i.id = any (v_camp.instance_ids)
          and i.status = 'connected'
          and i.purpose in ('campaigns','both')
          and (
            (i.engine = 'evolution' and i.provider_instance_name is not null)
            or (i.engine = 'baileys' and ex.id is not null and ex.status = 'active'
                and ex.last_seen_at >= clock_timestamp() - interval '2 minutes')
          )
        order by i.created_at asc
        limit 1;
        if found then
          update public.campaign_recipients set instance_id = v_inst.id where id = v_rec.id;
        else
          update public.campaigns
          set status = 'paused', pause_reason = 'chip_disconnected',
              pause_detail = 'Nenhum chip do rodízio está conectado no momento.', updated_at = now()
          where id = v_camp.id;
          continue;
        end if;
      else
        update public.campaigns
        set status = 'paused', pause_reason = 'chip_disconnected',
            pause_detail = 'O chip selecionado desconectou. Reconecte antes de retomar.', updated_at = now()
        where id = v_camp.id;
        continue;
      end if;
    end if;

    if v_daily_limit > 0 then
      if (
        select count(*) from public.campaign_step_deliveries d
        where d.workspace_id = v_camp.workspace_id and d.instance_id = v_inst.id
          and d.step_index = 0 and d.status in ('sent','delivered','read')
          and d.created_at >= v_today_start
      ) >= v_daily_limit then
        update public.campaigns
        set status = 'paused', pause_reason = 'daily_limit',
            pause_detail = 'Teto diário de disparos por chip atingido hoje.', updated_at = now()
        where id = v_camp.id;
        continue;
      end if;
    end if;

    v_block := v_camp.blocks -> v_rec.current_step;
    v_block_type := v_block ->> 'type';
    if v_block_type not in ('text','image','audio') then
      update public.campaign_recipients set status = 'failed', last_error = 'Bloco inválido na campanha' where id = v_rec.id;
      continue;
    end if;

    v_media_files := '[]'::jsonb;
    if v_block_type in ('image','audio') then
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', mf.id, 'object_key', mf.object_key, 'file_name', mf.file_name,
        'content_type', mf.content_type, 'byte_size', mf.byte_size
      ) order by mf.sort_order asc, mf.created_at asc, mf.id asc), '[]'::jsonb)
      into v_media_files
      from public.campaign_media_files mf
      where mf.workspace_id = v_camp.workspace_id
        and mf.folder_id = nullif(v_block ->> 'folder_id', '')::uuid
        and mf.kind = v_block_type;
      if jsonb_array_length(v_media_files) = 0 then
        update public.campaigns
        set status = 'paused', pause_reason = 'no_media',
            pause_detail = 'A pasta de mídia escolhida está vazia.', updated_at = now()
        where id = v_camp.id;
        continue;
      end if;
    end if;

    v_del_id := gen_random_uuid();
    insert into public.campaign_step_deliveries(
      id, workspace_id, campaign_id, recipient_id, instance_id, step_index, block_type, status, idempotency_key
    )
    values (
      v_del_id, v_camp.workspace_id, v_camp.id, v_rec.id, v_inst.id, v_rec.current_step,
      v_block_type, 'sending', v_rec.idempotency_key || '-s' || v_rec.current_step::text
    );

    update public.campaign_recipients
    set status = 'sending'
    where id = v_rec.id;

    -- Calcula próximo momento de ação (intervalo entre blocos ou entre pessoas/lotes).
    v_int_min := least(greatest(coalesce((v_cad ->> 'intervalMinSec')::integer, 35), 15), 600);
    v_int_max := greatest(v_int_min, least(coalesce((v_cad ->> 'intervalMaxSec')::integer, 80), 900));
    v_step_sec := least(greatest(coalesce((v_cad ->> 'stepIntervalSec')::integer, 4), 2), 30);
    v_bmin := least(greatest(coalesce((v_cad ->> 'batchMin')::integer, 8), 1), 100);
    v_bmax := greatest(v_bmin, least(coalesce((v_cad ->> 'batchMax')::integer, 15), 100));
    v_pmin := least(greatest(coalesce((v_cad ->> 'batchPauseMinSec')::integer, 180), 30), 3600);
    v_pmax := greatest(v_pmin, least(coalesce((v_cad ->> 'batchPauseMaxSec')::integer, 420), 7200));

    if v_rec.current_step + 1 < v_total_steps then
      v_delay := v_step_sec;
      v_next_batch := v_camp.batch_sent_count;
      v_next_target := v_camp.batch_target;
    else
      v_next_batch := v_camp.batch_sent_count + 1;
      if v_next_batch >= v_camp.batch_target then
        v_delay := v_pmin + floor(random() * (v_pmax - v_pmin + 1))::integer;
        v_next_batch := 0;
        v_next_target := v_bmin + floor(random() * (v_bmax - v_bmin + 1))::integer;
      else
        v_delay := v_int_min + floor(random() * (v_int_max - v_int_min + 1))::integer;
        v_next_target := v_camp.batch_target;
      end if;
    end if;

    update public.campaigns
    set next_action_at = clock_timestamp() + make_interval(secs => v_delay),
        batch_sent_count = v_next_batch,
        batch_target = v_next_target,
        pause_detail = null,
        updated_at = now()
    where id = v_camp.id;

    if v_block_type = 'text' and (v_block ->> 'mode') = 'ai' then
      v_ai_settings := private.ai_settings_json(v_camp.workspace_id);
      select coalesce(jsonb_object_agg(k.provider, k.ciphertext), '{}'::jsonb)
      into v_ai_keys
      from private.workspace_ai_secrets k
      where k.workspace_id = v_camp.workspace_id;
    else
      v_ai_settings := '{}'::jsonb;
      v_ai_keys := '{}'::jsonb;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'delivery_id', v_del_id,
      'workspace_id', v_camp.workspace_id,
      'campaign_id', v_camp.id,
      'campaign_name', v_camp.name,
      'recipient_id', v_rec.id,
      'step_index', v_rec.current_step,
      'total_steps', v_total_steps,
      'block', v_block,
      'media_files', v_media_files,
      'recipient', jsonb_build_object(
        'name', v_ct.display_name,
        'phone', regexp_replace(coalesce(v_ct.phone_e164, split_part(v_ct.external_user_id, '@', 1)), '[^0-9]', '', 'g'),
        'jid', v_ct.external_user_id,
        'custom_fields', v_rec.custom_fields
      ),
      'instance', jsonb_build_object(
        'id', v_inst.id,
        'engine', v_inst.engine,
        'provider_instance_name', v_inst.provider_instance_name,
        'local_executor_id', v_inst.local_executor_id
      ),
      'ai', case when v_block_type = 'text' and (v_block ->> 'mode') = 'ai'
                 then jsonb_build_object('settings', v_ai_settings, 'keys', v_ai_keys)
                 else null end
    ));
  end loop;

  return v_out;
end;
$$;
revoke all on function public.claim_due_campaign_steps(integer) from public, anon, authenticated;
grant execute on function public.claim_due_campaign_steps(integer) to service_role;

create or replace function public.dispatch_claimed_campaign_step(
  p_workspace_id uuid,
  p_delivery_id uuid,
  p_rendered_body text,
  p_media_file_id uuid default null,
  p_is_voice boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_del public.campaign_step_deliveries%rowtype;
  v_rec public.campaign_recipients%rowtype;
  v_ct public.contacts%rowtype;
  v_inst public.instances%rowtype;
  v_mf public.campaign_media_files%rowtype;
  v_conv_id uuid;
  v_msg_id uuid;
  v_cmd_id uuid;
  v_body text := nullif(btrim(coalesce(p_rendered_body, '')), '');
  v_jid text;
begin
  select * into v_del
  from public.campaign_step_deliveries d
  where d.workspace_id = p_workspace_id and d.id = p_delivery_id
  for update;
  if not found or v_del.status <> 'sending' then
    return jsonb_build_object('result', 'ignored');
  end if;

  select * into v_rec from public.campaign_recipients where workspace_id = p_workspace_id and id = v_del.recipient_id;
  select * into v_ct from public.contacts where workspace_id = p_workspace_id and id = v_rec.contact_id;
  select * into v_inst from public.instances where workspace_id = p_workspace_id and id = v_del.instance_id;

  v_jid := coalesce(v_ct.external_user_id, regexp_replace(coalesce(v_ct.phone_e164, ''), '[^0-9]', '', 'g') || '@s.whatsapp.net');

  select c.id into v_conv_id
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.contact_id = v_ct.id and c.instance_id = v_inst.id
    and c.stage not in ('resolved','archived')
  order by c.activity_at desc, c.id desc
  limit 1
  for update;

  if v_conv_id is null then
    insert into public.conversations(workspace_id, contact_id, instance_id, stage, unread_count)
    values (p_workspace_id, v_ct.id, v_inst.id, 'waiting_customer', 0)
    returning id into v_conv_id;
  end if;

  v_msg_id := gen_random_uuid();
  if p_media_file_id is not null then
    select * into v_mf
    from public.campaign_media_files mf
    where mf.workspace_id = p_workspace_id and mf.id = p_media_file_id;
    if not found then
      raise exception 'Media file not found' using errcode = 'P0002';
    end if;

    insert into public.messages(
      id, workspace_id, conversation_id, instance_id, idempotency_key,
      direction, source_engine, actor_type, status, body_text, media_object_key, occurred_at
    )
    values (
      v_msg_id, p_workspace_id, v_conv_id, v_inst.id, v_del.idempotency_key,
      'outbound', v_inst.engine, 'system', 'sending', null, v_mf.object_key, clock_timestamp()
    );

    insert into public.message_attachments(
      workspace_id, message_id, object_key, content_type, byte_size,
      kind, file_name, is_voice, storage_status, retention_delete_after
    )
    values (
      p_workspace_id, v_msg_id, v_mf.object_key, v_mf.content_type, v_mf.byte_size,
      v_mf.kind, v_mf.file_name, coalesce(p_is_voice, false), 'stored', private.media_keep_until(p_workspace_id)
    );
  else
    insert into public.messages(
      id, workspace_id, conversation_id, instance_id, idempotency_key,
      direction, source_engine, actor_type, status, body_text, occurred_at
    )
    values (
      v_msg_id, p_workspace_id, v_conv_id, v_inst.id, v_del.idempotency_key,
      'outbound', v_inst.engine, 'system', 'sending', coalesce(v_body, ' '), clock_timestamp()
    );
  end if;

  if v_inst.engine = 'baileys' then
    insert into public.local_motor_commands(
      workspace_id, executor_id, instance_id, command_type, payload, message_id
    )
    values (
      p_workspace_id,
      v_inst.local_executor_id,
      v_inst.id,
      case when p_media_file_id is not null then 'send_media' else 'send_text' end,
      case when p_media_file_id is not null then jsonb_build_object('recipient', v_jid)
           else jsonb_build_object('recipient', v_jid, 'body_text', coalesce(v_body, '')) end,
      v_msg_id
    )
    returning id into v_cmd_id;

    update public.campaign_step_deliveries
    set rendered_body = v_body, media_file_id = p_media_file_id, message_id = v_msg_id, local_command_id = v_cmd_id
    where id = v_del.id;

    return jsonb_build_object('result', 'queued_local', 'command_id', v_cmd_id, 'message_id', v_msg_id);
  end if;

  update public.campaign_step_deliveries
  set rendered_body = v_body, media_file_id = p_media_file_id, message_id = v_msg_id
  where id = v_del.id;

  return jsonb_build_object(
    'result', 'ready_evolution',
    'message_id', v_msg_id,
    'provider_instance_name', v_inst.provider_instance_name,
    'recipient', v_jid,
    'body_text', v_body,
    'attachment', case when p_media_file_id is not null then jsonb_build_object(
      'object_key', v_mf.object_key,
      'kind', v_mf.kind,
      'content_type', v_mf.content_type,
      'file_name', v_mf.file_name,
      'is_voice', coalesce(p_is_voice, false)
    ) else null end
  );
end;
$$;
revoke all on function public.dispatch_claimed_campaign_step(uuid,uuid,text,uuid,boolean) from public, anon, authenticated;
grant execute on function public.dispatch_claimed_campaign_step(uuid,uuid,text,uuid,boolean) to service_role;

create or replace function private.apply_campaign_step_outcome(
  p_workspace_id uuid,
  p_delivery_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_error_detail text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_del public.campaign_step_deliveries%rowtype;
  v_camp public.campaigns%rowtype;
  v_total_steps integer;
  v_next_step integer;
  v_alert boolean := false;
begin
  select * into v_del
  from public.campaign_step_deliveries d
  where d.workspace_id = p_workspace_id and d.id = p_delivery_id
  for update;
  if not found or v_del.status <> 'sending' then
    return jsonb_build_object('result', 'ignored');
  end if;

  select * into v_camp from public.campaigns where workspace_id = p_workspace_id and id = v_del.campaign_id for update;
  v_total_steps := greatest(coalesce(jsonb_array_length(v_camp.blocks), 1), 1);

  update public.campaign_step_deliveries
  set status = case
        when p_outcome = 'sent' then 'sent'
        when p_outcome = 'failed' then 'failed'
        else 'awaiting_human_confirmation'
      end,
      provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
      error_detail = nullif(left(btrim(coalesce(p_error_detail, '')), 500), ''),
      finished_at = clock_timestamp()
  where id = v_del.id;

  if p_outcome = 'sent' then
    v_next_step := v_del.step_index + 1;
    if v_next_step >= v_total_steps then
      update public.campaign_recipients
      set status = 'sent', current_step = v_next_step, sent_at = clock_timestamp(), last_error = null
      where id = v_del.recipient_id;
    else
      update public.campaign_recipients
      set status = 'queued', current_step = v_next_step, last_error = null
      where id = v_del.recipient_id;
    end if;
    perform private.recompute_campaign_completion(p_workspace_id, v_camp.id);
  elsif p_outcome = 'failed' then
    update public.campaign_recipients
    set status = 'failed', last_error = nullif(left(btrim(coalesce(p_error_detail, '')), 500), '')
    where id = v_del.recipient_id;
    perform private.recompute_campaign_completion(p_workspace_id, v_camp.id);
  else
    v_alert := true;
    update public.campaign_recipients
    set status = 'awaiting_human_confirmation',
        last_error = nullif(left(btrim(coalesce(p_error_detail, 'Sem confirmação do WhatsApp')), 500), '')
    where id = v_del.recipient_id;

    update public.campaigns
    set status = 'paused',
        pause_reason = 'uncertain_send',
        pause_detail = 'Um envio da campanha ficou sem confirmação. Confira no WhatsApp antes de retomar.',
        updated_at = now()
    where id = v_camp.id and status = 'running';
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'alert_uncertain', v_alert,
    'campaign_id', v_camp.id,
    'campaign_name', v_camp.name,
    'instance_id', v_del.instance_id
  );
end;
$$;
revoke all on function private.apply_campaign_step_outcome(uuid,uuid,text,text,text) from public, anon, authenticated;

create or replace function public.finish_campaign_step_delivery(
  p_workspace_id uuid,
  p_delivery_id uuid,
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
  v_del public.campaign_step_deliveries%rowtype;
begin
  if p_outcome not in ('sent','failed','uncertain') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;
  select * into v_del from public.campaign_step_deliveries
  where workspace_id = p_workspace_id and id = p_delivery_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_del.message_id is not null then
    perform private.finish_outbound_message(
      p_workspace_id, v_del.message_id, p_outcome,
      nullif(left(btrim(coalesce(p_provider_message_id, '')), 200), ''),
      null, 'service'
    );
  end if;
  return private.apply_campaign_step_outcome(p_workspace_id, p_delivery_id, p_outcome, p_provider_message_id, p_error_detail);
end;
$$;
revoke all on function public.finish_campaign_step_delivery(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.finish_campaign_step_delivery(uuid,uuid,text,text,text) to service_role;

create or replace function public.sweep_stuck_campaign_steps()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_del public.campaign_step_deliveries%rowtype;
  v_count integer := 0;
begin
  -- Passos travados há mais de 3 min sem conclusão viram "awaiting_human_confirmation" (nunca reenviam).
  for v_del in
    select d.*
    from public.campaign_step_deliveries d
    where d.status = 'sending'
      and d.local_command_id is null
      and d.created_at < clock_timestamp() - interval '3 minutes'
    limit 20
    for update skip locked
  loop
    perform public.finish_campaign_step_delivery(
      v_del.workspace_id, v_del.id, 'uncertain', null, 'Envio interrompido sem resposta; confira no chip.'
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.sweep_stuck_campaign_steps() from public, anon, authenticated;
grant execute on function public.sweep_stuck_campaign_steps() to service_role;

-- Propaga is_voice ao motor local, propaga conclusão de comando Baileys para Fila Segura / Campanha / Alertas,
-- e marca leases expirados de send_text/send_media como 'uncertain' sem nunca reenviar.
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
  v_cmd public.local_motor_commands%rowtype;
  v_expired public.local_motor_commands%rowtype;
  v_inst public.instances%rowtype;
  v_msg public.messages%rowtype;
  v_att public.message_attachments%rowtype;
  v_proactive_id uuid;
  v_delivery_id uuid;
  v_items jsonb := '[]'::jsonb;
begin
  select * into v_auth from private.auth_local_executor(p_token_sha256);
  if not found then
    return jsonb_build_object('result', 'unauthorized');
  end if;

  update public.local_executors
  set status = 'active', last_seen_at = clock_timestamp()
  where id = v_auth.executor_id;

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
      set status = 'uncertain',
          error_detail = 'lease_expired_after_dispatch'
      where id = v_expired.id;
      if v_expired.message_id is not null then
        perform private.finish_outbound_message(
          v_expired.workspace_id,
          v_expired.message_id,
          'uncertain',
          null,
          null,
          'service'
        );
      end if;
      select p.id into v_proactive_id from public.proactive_queue_items p where p.local_command_id = v_expired.id;
      if v_proactive_id is not null then
        perform private.apply_proactive_outcome(v_expired.workspace_id, v_proactive_id, 'uncertain', null, 'lease_expired_after_dispatch');
      end if;
      select d.id into v_delivery_id from public.campaign_step_deliveries d where d.local_command_id = v_expired.id;
      if v_delivery_id is not null then
        perform private.apply_campaign_step_outcome(v_expired.workspace_id, v_delivery_id, 'uncertain', null, 'lease_expired_after_dispatch');
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
        'is_voice', v_att.is_voice,
        'caption', v_msg.body_text
      ) end,
      'attempts', v_cmd.attempts,
      'created_at', v_cmd.created_at
    ));
  end loop;

  return jsonb_build_object('result', 'ok', 'executor_id', v_auth.executor_id, 'commands', v_items);
end;
$$;
revoke all on function public.claim_local_motor_commands(text,integer) from public, anon, authenticated;
grant execute on function public.claim_local_motor_commands(text,integer) to service_role;

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
  v_proactive_id uuid;
  v_delivery_id uuid;
  v_alert_id uuid;
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
  v_msg_outcome := case when p_outcome in ('sent','succeeded') then 'sent'
                        when p_outcome = 'failed' then 'failed'
                        else 'uncertain' end;

  update public.local_motor_commands
  set status = v_new_status,
      provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
      error_detail = nullif(left(btrim(coalesce(p_error_detail, '')), 500), '')
  where id = v_cmd.id;

  if v_cmd.message_id is not null then
    v_finish := private.finish_outbound_message(
      v_cmd.workspace_id,
      v_cmd.message_id,
      v_msg_outcome,
      nullif(left(btrim(coalesce(p_provider_message_id, '')), 200), ''),
      null,
      'service'
    );
  end if;

  select p.id into v_proactive_id from public.proactive_queue_items p where p.local_command_id = v_cmd.id;
  if v_proactive_id is not null then
    perform private.apply_proactive_outcome(
      v_cmd.workspace_id, v_proactive_id, v_msg_outcome, p_provider_message_id, p_error_detail
    );
  end if;

  select d.id into v_delivery_id from public.campaign_step_deliveries d where d.local_command_id = v_cmd.id;
  if v_delivery_id is not null then
    perform private.apply_campaign_step_outcome(
      v_cmd.workspace_id, v_delivery_id, v_msg_outcome, p_provider_message_id, p_error_detail
    );
  end if;

  if (v_cmd.payload ? 'admin_alert_delivery_id') then
    begin
      v_alert_id := (v_cmd.payload ->> 'admin_alert_delivery_id')::uuid;
      update private.admin_alert_deliveries
      set status = v_msg_outcome,
          provider_message_id = coalesce(nullif(btrim(coalesce(p_provider_message_id, '')), ''), provider_message_id),
          error_detail = nullif(left(btrim(coalesce(p_error_detail, '')), 500), ''),
          finished_at = clock_timestamp()
      where workspace_id = v_cmd.workspace_id and id = v_alert_id;
    exception when others then
      null;
    end;
  end if;

  update public.local_executors
  set status = 'active', last_seen_at = clock_timestamp()
  where id = v_auth.executor_id;

  return jsonb_build_object('result', 'ok', 'status', v_new_status, 'message', v_finish);
end;
$$;
revoke all on function public.complete_local_motor_command(text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.complete_local_motor_command(text,uuid,text,text,text) to service_role;

-- Rastreio de entrega/leitura (Evolution MESSAGES_UPDATE) + Resposta automática em campanhas (schedule_ai_turn)
-- + Alerta de desconexão (Evolution & Baileys) + Envio de alertas pelo WhatsApp em qualquer chip conectado.
create or replace function public.apply_evolution_message_status(
  p_instance_name text,
  p_token_sha256 text,
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_instance_id uuid;
  v_item jsonb;
  v_pid text;
  v_status text;
  v_msg_id uuid;
  v_del public.campaign_step_deliveries%rowtype;
  v_applied integer := 0;
begin
  if p_instance_name is null or p_token_sha256 is null or p_token_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('result', 'unauthorized');
  end if;
  select a.workspace_id, a.instance_id
  into v_workspace_id, v_instance_id
  from private.evolution_webhook_auth a
  join public.instances i on i.workspace_id = a.workspace_id and i.id = a.instance_id
  where i.provider_instance_name = p_instance_name
    and i.channel = 'whatsapp' and i.engine = 'evolution' and i.status <> 'revoked'
    and a.token_sha256 = p_token_sha256;
  if not found then
    return jsonb_build_object('result', 'unauthorized');
  end if;

  if p_updates is null or jsonb_typeof(p_updates) <> 'array' then
    return jsonb_build_object('result', 'ok', 'applied', 0);
  end if;

  for v_item in select jsonb_array_elements(p_updates) loop
    v_pid := nullif(btrim(coalesce(v_item ->> 'provider_message_id', '')), '');
    v_status := v_item ->> 'status';
    if v_pid is null or v_status not in ('delivered','read') then
      continue;
    end if;

    update public.messages
    set status = case
      when v_status = 'read' and status in ('sent','delivered') then 'read'
      when v_status = 'delivered' and status = 'sent' then 'delivered'
      else status
    end
    where workspace_id = v_workspace_id
      and instance_id = v_instance_id
      and provider_message_id = v_pid
      and direction = 'outbound'
    returning id into v_msg_id;

    if v_msg_id is not null then
      v_applied := v_applied + 1;
      select d.* into v_del
      from public.campaign_step_deliveries d
      where d.workspace_id = v_workspace_id and d.message_id = v_msg_id;
      if found then
        update public.campaign_step_deliveries
        set status = case
          when v_status = 'read' and status in ('sent','delivered') then 'read'
          when v_status = 'delivered' and status = 'sent' then 'delivered'
          else status
        end
        where id = v_del.id;

        update public.campaign_recipients
        set status = case
              when v_status = 'read' and status in ('sent','delivered') then 'read'
              when v_status = 'delivered' and status = 'sent' then 'delivered'
              else status
            end,
            delivered_at = coalesce(delivered_at, clock_timestamp()),
            read_at = case when v_status = 'read' then coalesce(read_at, clock_timestamp()) else read_at end
        where workspace_id = v_workspace_id and id = v_del.recipient_id;
      end if;
    end if;
  end loop;

  return jsonb_build_object('result', 'ok', 'applied', v_applied);
end;
$$;
revoke all on function public.apply_evolution_message_status(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_evolution_message_status(text,text,jsonb) to service_role;

-- Atualiza schedule_ai_turn: marca resposta do cliente em campanhas recentes AND trata resposta fora do horário (cooldown 6h).
create or replace function private.schedule_ai_turn(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_instance_id uuid,
  p_message_id uuid,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_wait integer;
  v_turn_id uuid;
  v_conv public.conversations%rowtype;
  v_sec jsonb;
  v_off_msg text;
  v_inst public.instances%rowtype;
  v_ct public.contacts%rowtype;
  v_off_msg_id uuid;
  v_off_cmd_id uuid;
  v_off_reply jsonb := null;
begin
  select * into v_conv from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;

  -- Qualquer mensagem recebida marca campanhas recentes daquele contato como respondidas.
  if found then
    update public.campaign_recipients
    set status = 'replied',
        replied_at = coalesce(replied_at, p_occurred_at),
        delivered_at = coalesce(delivered_at, p_occurred_at)
    where workspace_id = p_workspace_id
      and contact_id = v_conv.contact_id
      and status in ('sent','delivered','read')
      and sent_at >= clock_timestamp() - interval '30 days';
  end if;

  if p_occurred_at is null or p_occurred_at < clock_timestamp() - interval '5 minutes' then
    v_reason := 'old_message';
  else
    v_reason := private.ai_block_reason(p_workspace_id, p_conversation_id);
  end if;

  if v_reason is not null then
    perform private.cancel_waiting_ai_turn(p_workspace_id, p_conversation_id, v_reason);
    update public.conversations set stage = 'waiting_human'
    where workspace_id = p_workspace_id and id = p_conversation_id and stage = 'ai';

    if v_reason = 'outside_hours' and v_conv.id is not null
      and (v_conv.off_hours_replied_at is null or v_conv.off_hours_replied_at < clock_timestamp() - interval '6 hours') then
      v_sec := private.security_settings_json(p_workspace_id);
      v_off_msg := btrim(coalesce(v_sec ->> 'off_hours_reply_message', ''));
      if v_off_msg <> '' then
        select * into v_inst from public.instances i where i.workspace_id = p_workspace_id and i.id = p_instance_id;
        select * into v_ct from public.contacts ct where ct.workspace_id = p_workspace_id and ct.id = v_conv.contact_id;
        if v_inst.id is not null and v_ct.external_user_id is not null then
          v_off_msg_id := gen_random_uuid();
          insert into public.messages(
            id, workspace_id, conversation_id, instance_id, idempotency_key,
            direction, source_engine, actor_type, status, body_text, occurred_at
          )
          values (
            v_off_msg_id, p_workspace_id, p_conversation_id, p_instance_id, 'offhours-' || p_message_id::text,
            'outbound', v_inst.engine, 'system', 'sending', left(v_off_msg, 4096), clock_timestamp()
          )
          on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing
          returning id into v_off_msg_id;

          if v_off_msg_id is not null then
            update public.conversations
            set off_hours_replied_at = clock_timestamp()
            where workspace_id = p_workspace_id and id = p_conversation_id;

            if v_inst.engine = 'baileys' and v_inst.local_executor_id is not null then
              insert into public.local_motor_commands(
                workspace_id, executor_id, instance_id, command_type, payload, message_id
              )
              values (
                p_workspace_id, v_inst.local_executor_id, v_inst.id, 'send_text',
                jsonb_build_object('recipient', v_ct.external_user_id, 'body_text', left(v_off_msg, 4096)),
                v_off_msg_id
              )
              returning id into v_off_cmd_id;
            elsif v_inst.engine = 'evolution' and v_inst.provider_instance_name is not null then
              v_off_reply := jsonb_build_object(
                'message_id', v_off_msg_id,
                'provider_instance_name', v_inst.provider_instance_name,
                'recipient', v_ct.external_user_id,
                'body_text', left(v_off_msg, 4096)
              );
            end if;
          end if;
        end if;
      end if;
    end if;

    return jsonb_build_object('scheduled', false, 'reason', v_reason)
      || case when v_off_reply is not null
              then jsonb_build_object('off_hours_reply', v_off_reply)
              else '{}'::jsonb end;
  end if;

  v_wait := least(greatest(coalesce((private.ai_settings_json(p_workspace_id) ->> 'debounce_seconds')::integer, 6), 1), 20);

  update public.ai_turns
  set trigger_message_id = p_message_id, due_at = clock_timestamp() + make_interval(secs => v_wait)
  where workspace_id = p_workspace_id and conversation_id = p_conversation_id and status = 'waiting'
  returning id into v_turn_id;

  if v_turn_id is null then
    insert into public.ai_turns(workspace_id, conversation_id, instance_id, trigger_message_id, due_at)
    values (p_workspace_id, p_conversation_id, p_instance_id, p_message_id, clock_timestamp() + make_interval(secs => v_wait))
    returning id into v_turn_id;
  end if;

  update public.conversations set stage = 'ai'
  where workspace_id = p_workspace_id and id = p_conversation_id and stage <> 'ai';

  return jsonb_build_object('scheduled', true, 'turn_id', v_turn_id, 'wait_ms', v_wait * 1000);
end;
$$;
revoke all on function private.schedule_ai_turn(uuid, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;

create or replace function public.finish_offhours_message(
  p_workspace_id uuid,
  p_message_id uuid,
  p_outcome text,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.finish_outbound_message(p_workspace_id, p_message_id, p_outcome, p_provider_message_id, null, 'service');
end;
$$;
revoke all on function public.finish_offhours_message(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.finish_offhours_message(uuid,uuid,text,text) to service_role;

-- Envia ou enfileira alerta administrativo (suporta Baileys e Evolution, inclusive desconexão/campanha).
create or replace function public.enqueue_workspace_admin_alert(
  p_workspace_id uuid,
  p_kind text,
  p_body_text text,
  p_preferred_instance_id uuid default null,
  p_turn_id uuid default null,
  p_conversation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sec jsonb;
  v_wa text;
  v_events text[];
  v_inst public.instances%rowtype;
  v_del_id uuid;
  v_cmd_id uuid;
begin
  if p_kind not in ('handoff','silent_handoff','uncertain_send','error','safety','chip_disconnected','campaign_uncertain','test') then
    raise exception 'Invalid alert kind' using errcode = '22023';
  end if;

  v_sec := private.security_settings_json(p_workspace_id);
  if p_kind <> 'test' and not coalesce((v_sec ->> 'admin_alert_enabled')::boolean, false) then
    return jsonb_build_object('result', 'disabled');
  end if;

  v_wa := regexp_replace(coalesce(v_sec ->> 'admin_alert_whatsapp', ''), '[^0-9]', '', 'g');
  if v_wa !~ '^[0-9]{10,15}$' then
    return jsonb_build_object('result', 'no_whatsapp');
  end if;

  if p_kind <> 'test' then
    select coalesce(array_agg(e #>> '{}'), array[]::text[]) into v_events
    from jsonb_array_elements(coalesce(v_sec -> 'admin_alert_events', '[]'::jsonb)) e;
    if not (p_kind = any (v_events)) then
      return jsonb_build_object('result', 'event_disabled');
    end if;
  end if;

  -- Prefere o chip indicado (se conectado), senão qualquer outro chip conectado do workspace.
  select i.* into v_inst
  from public.instances i
  left join public.local_executors ex on ex.id = i.local_executor_id
  where i.workspace_id = p_workspace_id
    and i.status = 'connected'
    and (
      (i.engine = 'evolution' and i.provider_instance_name is not null)
      or (i.engine = 'baileys' and ex.id is not null and ex.status = 'active' and ex.last_seen_at >= clock_timestamp() - interval '2 minutes')
    )
  order by (i.id = p_preferred_instance_id) desc, i.created_at asc
  limit 1;

  if not found then
    return jsonb_build_object('result', 'no_connected_chip');
  end if;

  insert into private.admin_alert_deliveries(
    workspace_id, instance_id, conversation_id, turn_id, kind,
    recipient_core, recipient_whatsapp, body_prefix, status
  )
  values (
    p_workspace_id, v_inst.id, p_conversation_id, p_turn_id, p_kind,
    private.phone_core(v_wa), v_wa, left(btrim(coalesce(p_body_text, '')), 120), 'sending'
  )
  on conflict (turn_id, kind) where turn_id is not null do nothing
  returning id into v_del_id;

  if v_del_id is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  if v_inst.engine = 'baileys' then
    insert into public.local_motor_commands(
      workspace_id, executor_id, instance_id, command_type, payload, message_id
    )
    values (
      p_workspace_id, v_inst.local_executor_id, v_inst.id, 'send_text',
      jsonb_build_object(
        'recipient', v_wa || '@s.whatsapp.net',
        'body_text', left(btrim(coalesce(p_body_text, '')), 4096),
        'admin_alert_delivery_id', v_del_id
      ),
      null
    )
    returning id into v_cmd_id;

    return jsonb_build_object('result', 'queued_local', 'delivery_id', v_del_id, 'command_id', v_cmd_id);
  end if;

  return jsonb_build_object(
    'result', 'ready_evolution',
    'delivery_id', v_del_id,
    'provider_instance_name', v_inst.provider_instance_name,
    'recipient_whatsapp', v_wa
  );
end;
$$;
revoke all on function public.enqueue_workspace_admin_alert(uuid,text,text,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.enqueue_workspace_admin_alert(uuid,text,text,uuid,uuid,uuid) to service_role;

-- Também marca alerta de desconexão no retorno de apply_evolution_connection_update e report_local_instance_state.
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

  return jsonb_build_object(
    'result','applied',
    'instance_id',v_after.id,
    'workspace_id',v_after.workspace_id,
    'display_name',v_after.display_name,
    'status',v_after.status,
    'alert_disconnected', (v_before.status = 'connected' and v_after.status in ('disconnected','error'))
  );
end;
$$;
revoke all on function private.apply_evolution_connection_update(text,text,text,text) from public, anon, authenticated;
grant execute on function private.apply_evolution_connection_update(text,text,text,text) to service_role;

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
    'workspace_id', v_after.workspace_id,
    'display_name', v_after.display_name,
    'status', v_after.status,
    'connected_phone', v_after.connected_phone,
    'alert_disconnected', (v_before.status = 'connected' and v_after.status in ('disconnected','error'))
  );
end;
$$;
revoke all on function public.report_local_instance_state(text,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.report_local_instance_state(text,uuid,text,text,text,text) to service_role;

-- Também adiciona filtro de eco administrativo em ingest_local_message para Baileys.
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
$$;
revoke all on function public.ingest_local_message(text,uuid,text,text,text,text,timestamptz,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_local_message(text,uuid,text,text,text,text,timestamptz,boolean,jsonb) to service_role;

commit;
