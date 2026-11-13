-- Fase 7: Configurações (marca white-label e exportação de dados),
-- Clientes SaaS (administração do master + Modo Suporte auditado) e
-- limpeza automática de mídias expiradas por retenção LGPD.

begin;

-- =============================================================================================
-- 1. White-label (nome e subtítulo no topo) + metadados privados de clientes SaaS
-- =============================================================================================

alter table public.workspaces
  add column if not exists brand_name text not null default 'Ienvia',
  add column if not exists brand_subtitle text not null default 'Atendente Universal';

alter table public.workspaces
  drop constraint if exists workspaces_brand_name_len,
  add constraint workspaces_brand_name_len
    check (char_length(btrim(brand_name)) between 2 and 40);

alter table public.workspaces
  drop constraint if exists workspaces_brand_subtitle_len,
  add constraint workspaces_brand_subtitle_len
    check (char_length(btrim(brand_subtitle)) <= 60);

grant update (brand_name, brand_subtitle) on public.workspaces to authenticated;

create table if not exists private.workspace_admin_meta (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  plan_label text not null default 'Padrão'
    check (char_length(btrim(plan_label)) between 1 and 60),
  admin_notes text not null default ''
    check (char_length(admin_notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on table private.workspace_admin_meta from public, anon, authenticated;
grant all on table private.workspace_admin_meta to service_role;

drop trigger if exists workspace_admin_meta_touch_updated_at on private.workspace_admin_meta;
create trigger workspace_admin_meta_touch_updated_at
  before update on private.workspace_admin_meta
  for each row execute function private.touch_updated_at();

-- =============================================================================================
-- 2. Modo Suporte auditado (sessões temporárias do administrador master)
-- =============================================================================================

create table if not exists public.support_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  reason text not null default '' check (char_length(reason) <= 300),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '4 hours'),
  ended_at timestamptz
);

create index if not exists support_sessions_admin_active_idx
  on public.support_sessions (admin_user_id, expires_at desc)
  where ended_at is null;

create index if not exists support_sessions_workspace_idx
  on public.support_sessions (workspace_id, started_at desc);

alter table public.support_sessions enable row level security;
revoke all on public.support_sessions from public, anon, authenticated;
grant select on public.support_sessions to authenticated;
grant all on public.support_sessions to service_role;

drop policy if exists support_sessions_select_own_master on public.support_sessions;
create policy support_sessions_select_own_master
  on public.support_sessions
  for select
  to authenticated
  using (admin_user_id = auth.uid() and private.is_platform_master());

create or replace function private.has_active_support_session(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.support_sessions s
    join private.platform_admins a on a.user_id = s.admin_user_id and a.is_active
    join public.workspaces w on w.id = s.workspace_id
    where s.admin_user_id = auth.uid()
      and s.workspace_id = p_workspace_id
      and s.ended_at is null
      and s.expires_at > now()
      and w.status in ('active', 'closed')
  )
$$;
revoke all on function private.has_active_support_session(uuid) from public, anon;
grant execute on function private.has_active_support_session(uuid) to authenticated;

-- Atualiza os helpers de pertencimento e auditoria para reconhecer o Modo Suporte ativo,
-- mantendo o isolamento total quando o master NÃO está em suporte na empresa.
create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.status = 'active'
  ) or private.has_active_support_session(p_workspace_id);
$$;

create or replace function private.is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.status = 'active' and m.role = 'owner'
  ) or private.has_active_support_session(p_workspace_id);
$$;

create or replace function private.is_active_workspace_user(p_workspace_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.status = 'active'
  ) or exists (
    select 1
    from public.support_sessions s
    join private.platform_admins a on a.user_id = s.admin_user_id and a.is_active
    join public.workspaces w on w.id = s.workspace_id
    where s.admin_user_id = p_user_id
      and s.workspace_id = p_workspace_id
      and s.ended_at is null
      and s.expires_at > now()
      and w.status in ('active', 'closed')
  );
$$;

create or replace function private.actor_kind_for(p_workspace_id uuid, p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select case when m.role = 'owner' then 'owner' else 'operator' end
     from public.workspace_memberships m
     where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.status = 'active'),
    case
      when exists (
        select 1
        from public.support_sessions s
        join private.platform_admins a on a.user_id = s.admin_user_id and a.is_active
        join public.workspaces w on w.id = s.workspace_id
        where s.admin_user_id = p_user_id
          and s.workspace_id = p_workspace_id
          and s.ended_at is null
          and s.expires_at > now()
          and w.status in ('active', 'closed')
      ) then 'master'
      else 'operator'
    end
  )
$$;
revoke all on function private.actor_kind_for(uuid, uuid) from public, anon, authenticated;

-- Alinha upload de mídia e RPCs da Inbox/IA que antes consultavam workspace_memberships diretamente.
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
      where c.workspace_id = private.media_object_workspace(p_name)
        and c.id::text = split_part(p_name, '/', 2)
        and private.is_workspace_member(c.workspace_id)
    )
  ) or (
    p_name ~ '^[0-9a-f-]{36}/campanhas/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and exists (
      select 1
      from public.campaign_media_folders f
      where f.workspace_id = private.media_object_workspace(p_name)
        and f.id::text = split_part(p_name, '/', 3)
        and private.is_workspace_member(f.workspace_id)
    )
  ) or (
    p_name ~ '^[0-9a-f-]{36}/catalogo/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and private.is_workspace_owner(private.media_object_workspace(p_name))
  ) or (
    p_name ~ '^[0-9a-f-]{36}/audios/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and private.is_workspace_owner(private.media_object_workspace(p_name))
  )
$$;
revoke all on function private.can_upload_media_object(text) from public, anon;
grant execute on function private.can_upload_media_object(text) to authenticated;

create or replace function public.finish_my_text_message(
  p_workspace_id uuid,
  p_message_id uuid,
  p_outcome text,
  p_provider_message_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_role := private.actor_kind_for(p_workspace_id, v_actor);
  return private.finish_outbound_message(p_workspace_id, p_message_id, p_outcome, p_provider_message_id, v_actor, v_role);
end;
$$;
revoke all on function public.finish_my_text_message(uuid, uuid, text, text) from public, anon;
grant execute on function public.finish_my_text_message(uuid, uuid, text, text) to authenticated;

create or replace function public.transition_workspace_conversation(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_row public.conversations%rowtype;
  v_action_name text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_role := private.actor_kind_for(p_workspace_id, v_actor);

  select c.* into v_row from public.conversations c where c.workspace_id = p_workspace_id and c.id = p_conversation_id for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;

  if p_action = 'claim' then
    if v_row.stage in ('resolved','archived') then raise exception 'Conversation is not active' using errcode = '22023'; end if;
    if v_row.assigned_user_id is not null and v_row.assigned_user_id <> v_actor then raise exception 'Conversation is assigned to another teammate' using errcode = '22023'; end if;
    update public.conversations set stage = 'human', automation_paused = true, ai_pause_reason = 'claimed', ai_paused_until = null, assigned_user_id = v_actor, assigned_label = 'Atendente' where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    perform private.cancel_waiting_ai_turn(p_workspace_id, p_conversation_id, 'claimed');
    v_action_name := 'conversation_claimed';
  elsif p_action = 'resolve' then
    if v_row.stage = 'archived' then raise exception 'Archived conversation cannot be resolved again' using errcode = '22023'; end if;
    update public.conversations set stage = 'resolved', automation_paused = true, unread_count = 0 where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    perform private.cancel_waiting_ai_turn(p_workspace_id, p_conversation_id, 'resolved');
    v_action_name := 'conversation_resolved';
  elsif p_action = 'reopen' then
    if v_row.stage <> 'resolved' then raise exception 'Conversation is not resolved' using errcode = '22023'; end if;
    perform 1 from public.conversations o
    where o.workspace_id = p_workspace_id and o.contact_id = v_row.contact_id and o.instance_id = v_row.instance_id
      and o.id <> v_row.id and o.stage not in ('resolved','archived');
    if found then raise exception 'another_open_conversation' using errcode = 'P0001'; end if;
    update public.conversations set stage = 'human' where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_reopened';
  elsif p_action = 'release' then
    if v_row.stage in ('resolved','archived') then raise exception 'Conversation is not active' using errcode = '22023'; end if;
    update public.conversations set automation_paused = false, ai_paused_until = null, ai_pause_reason = null, ai_handoff_at = null, ai_handoff_note = null, assigned_user_id = null, assigned_label = null where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_released';
  elsif p_action = 'mark_read' then
    if v_row.unread_count > 0 then
      update public.conversations set unread_count = 0 where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    end if;
  else raise exception 'Unsupported conversation action' using errcode = '22023';
  end if;

  if v_action_name is not null then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,v_actor,v_role,v_action_name,'conversation',p_conversation_id::text,jsonb_build_object('stage',v_row.stage,'automation_paused',v_row.automation_paused,'unread_count',v_row.unread_count));
  end if;
  return jsonb_build_object('id',v_row.id,'stage',v_row.stage,'assigned_user_id',v_row.assigned_user_id,'assigned_label',v_row.assigned_label,'automation_paused',v_row.automation_paused,'unread_count',v_row.unread_count,'updated_at',v_row.updated_at);
end;
$$;
revoke all on function public.transition_workspace_conversation(uuid, uuid, text) from public, anon;
grant execute on function public.transition_workspace_conversation(uuid, uuid, text) to authenticated;

create or replace function public.pause_my_ai(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_was_paused boolean;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_role := private.actor_kind_for(p_workspace_id, v_actor);

  select s.paused into v_was_paused from public.workspace_ai_state s where s.workspace_id = p_workspace_id for update;
  if coalesce(v_was_paused, false) then
    return jsonb_build_object('paused', true, 'changed', false);
  end if;

  insert into public.workspace_ai_state(workspace_id, paused, paused_at, paused_by)
  values (p_workspace_id, true, clock_timestamp(), v_actor)
  on conflict (workspace_id) do update set paused = true, paused_at = excluded.paused_at, paused_by = excluded.paused_by;

  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id
    and c.id in (select t.conversation_id from public.ai_turns t
                 where t.workspace_id = p_workspace_id and t.status = 'waiting')
  order by c.id
  for update;
  with cancelled as (
    update public.ai_turns
    set status = 'skipped', finished_at = clock_timestamp(), outcome_detail = 'workspace_paused'
    where workspace_id = p_workspace_id and status = 'waiting'
    returning conversation_id
  )
  update public.conversations c set stage = 'waiting_human'
  from cancelled x
  where c.workspace_id = p_workspace_id and c.id = x.conversation_id and c.stage = 'ai';

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,v_role,'ai_paused_all','workspace',p_workspace_id::text,'{}'::jsonb);

  return jsonb_build_object('paused', true, 'changed', true);
end;
$$;
revoke all on function public.pause_my_ai(uuid) from public, anon;
grant execute on function public.pause_my_ai(uuid) to authenticated;

-- =============================================================================================
-- 3. Configurações do workspace: marca white-label + exportação sanitizada dos dados
-- =============================================================================================

create or replace function public.update_my_workspace_branding(
  p_workspace_id uuid,
  p_workspace_name text,
  p_brand_name text,
  p_brand_subtitle text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := regexp_replace(btrim(coalesce(p_workspace_name, '')), '\s+', ' ', 'g');
  v_brand text := regexp_replace(btrim(coalesce(p_brand_name, '')), '\s+', ' ', 'g');
  v_sub text := regexp_replace(btrim(coalesce(p_brand_subtitle, '')), '\s+', ' ', 'g');
  v_ws public.workspaces%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if char_length(v_name) not between 2 and 120 then
    raise exception 'Invalid workspace name' using errcode = '22023';
  end if;
  if char_length(v_brand) not between 2 and 40 then
    raise exception 'Invalid brand name' using errcode = '22023';
  end if;
  if char_length(v_sub) > 60 then
    raise exception 'Invalid brand subtitle' using errcode = '22023';
  end if;

  select w.* into v_ws
  from public.workspaces w
  where w.id = p_workspace_id
  for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  if v_ws.status <> 'active' then
    raise exception 'Workspace is not active' using errcode = 'P0001';
  end if;

  update public.workspaces
  set name = v_name,
      brand_name = v_brand,
      brand_subtitle = v_sub
  where id = p_workspace_id
  returning * into v_ws;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id,
    v_actor,
    private.actor_kind_for(p_workspace_id, v_actor),
    'workspace_branding_updated',
    'workspace',
    p_workspace_id::text,
    jsonb_build_object('name', v_ws.name, 'brand_name', v_ws.brand_name, 'brand_subtitle', v_ws.brand_subtitle)
  );

  return jsonb_build_object(
    'id', v_ws.id,
    'name', v_ws.name,
    'brand_name', v_ws.brand_name,
    'brand_subtitle', v_ws.brand_subtitle
  );
end;
$$;
revoke all on function public.update_my_workspace_branding(uuid, text, text, text) from public, anon;
grant execute on function public.update_my_workspace_branding(uuid, text, text, text) to authenticated;

create or replace function public.export_my_workspace_snapshot(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_ws public.workspaces%rowtype;
  v_total_messages integer := 0;
  v_exported_messages integer := 0;
  v_snapshot jsonb;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;

  select w.* into v_ws
  from public.workspaces w
  where w.id = p_workspace_id and w.status <> 'deleted';
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  select count(*)::int into v_total_messages
  from public.messages m
  where m.workspace_id = p_workspace_id;

  v_exported_messages := least(v_total_messages, 5000);

  v_snapshot := jsonb_build_object(
    'format', 'ienvia-workspace-export-v1',
    'exported_at', now(),
    'counts', jsonb_build_object(
      'messages_total', v_total_messages,
      'messages_included', v_exported_messages,
      'messages_truncated', v_total_messages > 5000
    ),
    'workspace', jsonb_build_object(
      'id', v_ws.id,
      'name', v_ws.name,
      'brand_name', v_ws.brand_name,
      'brand_subtitle', v_ws.brand_subtitle,
      'status', v_ws.status,
      'max_instances', v_ws.max_instances,
      'created_at', v_ws.created_at
    ),
    'data_policy', (
      select to_jsonb(dp)
      from public.workspace_data_policies dp
      where dp.workspace_id = p_workspace_id
    ),
    'instances', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'display_name', i.display_name,
        'channel', i.channel,
        'engine', i.engine,
        'purpose', i.purpose,
        'status', i.status,
        'connected_phone', i.connected_phone,
        'is_enabled', i.is_enabled,
        'ai_agent_id', i.ai_agent_id,
        'created_at', i.created_at
      ) order by i.created_at asc, i.id asc)
      from public.instances i
      where i.workspace_id = p_workspace_id and i.status <> 'revoked'
    ), '[]'::jsonb),
    'ai_settings', (
      select to_jsonb(s)
      from public.workspace_ai_settings s
      where s.workspace_id = p_workspace_id
    ),
    'ai_providers_summary', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', sec.provider,
        'key_hint', sec.key_hint,
        'updated_at', sec.updated_at
      ) order by sec.provider asc)
      from private.workspace_ai_secrets sec
      where sec.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'ai_agents', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.is_default desc, a.created_at asc, a.id asc)
      from public.ai_agents a
      where a.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'ai_agent_faqs', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.agent_id, f.position asc, f.id asc)
      from public.ai_agent_faqs f
      where f.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'ai_agent_documents', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.agent_id, d.created_at asc, d.id asc)
      from public.ai_agent_documents d
      where d.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'pix_settings', (
      select to_jsonb(p)
      from public.workspace_pix_settings p
      where p.workspace_id = p_workspace_id
    ),
    'catalog_items', coalesce((
      select jsonb_agg(to_jsonb(ci) order by ci.sort_order asc, ci.created_at desc, ci.id desc)
      from public.catalog_items ci
      where ci.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'catalog_item_files', coalesce((
      select jsonb_agg(to_jsonb(cf) order by cf.item_id, cf.sort_order asc, cf.created_at asc)
      from public.catalog_item_files cf
      where cf.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'voice_library_items', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.created_at desc, v.id desc)
      from public.voice_library_items v
      where v.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'crm_tags', coalesce((
      select jsonb_agg(to_jsonb(t) order by lower(t.name), t.id)
      from public.crm_tags t
      where t.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.created_at asc, c.id asc)
      from public.contacts c
      where c.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'contact_tags', coalesce((
      select jsonb_agg(to_jsonb(ct) order by ct.contact_id, ct.tag_id)
      from public.contact_tags ct
      where ct.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'conversations', coalesce((
      select jsonb_agg(to_jsonb(cv) order by cv.activity_at desc, cv.id desc)
      from public.conversations cv
      where cv.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'conversation_notes', coalesce((
      select jsonb_agg(to_jsonb(cn) order by cn.created_at asc, cn.id asc)
      from public.conversation_notes cn
      where cn.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'quick_replies', coalesce((
      select jsonb_agg(to_jsonb(qr) order by qr.shortcut asc)
      from public.quick_replies qr
      where qr.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'scheduled_messages', coalesce((
      select jsonb_agg(to_jsonb(sm) order by sm.scheduled_for desc, sm.id desc)
      from public.scheduled_messages sm
      where sm.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(to_jsonb(sub) order by sub.occurred_at asc, sub.created_at asc, sub.id asc)
      from (
        select m.*
        from public.messages m
        where m.workspace_id = p_workspace_id
        order by m.occurred_at desc, m.created_at desc, m.id desc
        limit 5000
      ) sub
    ), '[]'::jsonb),
    'message_attachments', coalesce((
      select jsonb_agg(to_jsonb(ma) order by ma.created_at desc, ma.id desc)
      from public.message_attachments ma
      where ma.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(to_jsonb(cp) order by cp.created_at desc, cp.id desc)
      from public.campaigns cp
      where cp.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'security_ignored_numbers', coalesce((
      select jsonb_agg(to_jsonb(si) order by si.created_at desc)
      from public.security_ignored_numbers si
      where si.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'contact_erasure_requests', coalesce((
      select jsonb_agg(to_jsonb(er) order by er.received_at desc)
      from public.contact_erasure_requests er
      where er.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id,
    v_actor,
    private.actor_kind_for(p_workspace_id, v_actor),
    'workspace_data_exported',
    'workspace',
    p_workspace_id::text,
    jsonb_build_object('messages_total', v_total_messages, 'messages_included', v_exported_messages)
  );

  return v_snapshot;
end;
$$;
revoke all on function public.export_my_workspace_snapshot(uuid) from public, anon;
grant execute on function public.export_my_workspace_snapshot(uuid) to authenticated;

-- =============================================================================================
-- 4. RPCs do administrador da plataforma (Clientes SaaS + Modo Suporte + Auditoria)
-- =============================================================================================

create or replace function public.list_platform_workspaces()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', w.id,
      'name', w.name,
      'status', w.status,
      'max_instances', w.max_instances,
      'brand_name', w.brand_name,
      'brand_subtitle', w.brand_subtitle,
      'plan_label', coalesce(meta.plan_label, 'Padrão'),
      'admin_notes', coalesce(meta.admin_notes, ''),
      'created_at', w.created_at,
      'closed_at', w.closed_at,
      'last_support_at', (
        select max(ss.started_at)
        from public.support_sessions ss
        where ss.workspace_id = w.id
      ),
      'owner', (
        select jsonb_build_object(
          'user_id', own.user_id,
          'email', coalesce(own.email, ''),
          'display_name', coalesce(own.display_name, '')
        )
        from (
          select m.user_id, u.email, p.display_name
          from public.workspace_memberships m
          join auth.users u on u.id = m.user_id
          left join public.profiles p on p.id = m.user_id
          where m.workspace_id = w.id and m.status = 'active' and m.role = 'owner'
          order by m.created_at asc
          limit 1
        ) own
      ),
      'members_count', (
        select count(*)::int from public.workspace_memberships m
        where m.workspace_id = w.id and m.status = 'active'
      ),
      'instances_total', (
        select count(*)::int from public.instances i
        where i.workspace_id = w.id and i.status <> 'revoked'
      ),
      'instances_connected', (
        select count(*)::int from public.instances i
        where i.workspace_id = w.id and i.status = 'connected'
      ),
      'contacts_count', (
        select count(*)::int from public.contacts c
        where c.workspace_id = w.id and c.erased_at is null
      ),
      'conversations_count', (
        select count(*)::int from public.conversations cv
        where cv.workspace_id = w.id and cv.stage <> 'archived'
      )
    ) order by w.created_at desc, w.id desc)
    from public.workspaces w
    left join private.workspace_admin_meta meta on meta.workspace_id = w.id
    where w.status <> 'deleted'
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_platform_workspaces() from public, anon;
grant execute on function public.list_platform_workspaces() to authenticated;

create or replace function public.provision_platform_workspace(
  p_actor_user_id uuid,
  p_owner_user_id uuid,
  p_workspace_name text,
  p_max_instances integer default 1,
  p_plan_label text default 'Padrão',
  p_admin_notes text default '',
  p_brand_name text default 'Ienvia',
  p_brand_subtitle text default 'Atendente Universal',
  p_owner_display_name text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_workspace_name, '')), '\s+', ' ', 'g');
  v_plan text := coalesce(nullif(regexp_replace(btrim(coalesce(p_plan_label, '')), '\s+', ' ', 'g'), ''), 'Padrão');
  v_notes text := btrim(coalesce(p_admin_notes, ''));
  v_brand text := coalesce(nullif(regexp_replace(btrim(coalesce(p_brand_name, '')), '\s+', ' ', 'g'), ''), 'Ienvia');
  v_sub text := regexp_replace(btrim(coalesce(p_brand_subtitle, 'Atendente Universal')), '\s+', ' ', 'g');
  v_owner_name text := regexp_replace(btrim(coalesce(p_owner_display_name, '')), '\s+', ' ', 'g');
  v_ws public.workspaces%rowtype;
begin
  if p_actor_user_id is null or not exists (
    select 1 from private.platform_admins a where a.user_id = p_actor_user_id and a.is_active
  ) then
    raise exception 'Platform master required' using errcode = '42501';
  end if;
  if p_owner_user_id is null or not exists (select 1 from auth.users u where u.id = p_owner_user_id) then
    raise exception 'Owner user not found' using errcode = 'P0002';
  end if;
  if char_length(v_name) not between 2 and 120 then
    raise exception 'Invalid workspace name' using errcode = '22023';
  end if;
  if p_max_instances is null or p_max_instances not between 0 and 50 then
    raise exception 'Invalid max_instances' using errcode = '22023';
  end if;
  if char_length(v_plan) > 60 or char_length(v_notes) > 4000 then
    raise exception 'Invalid plan or notes' using errcode = '22023';
  end if;
  if char_length(v_brand) not between 2 and 40 or char_length(v_sub) > 60 then
    raise exception 'Invalid brand configuration' using errcode = '22023';
  end if;

  insert into public.workspaces (name, status, max_instances, brand_name, brand_subtitle)
  values (v_name, 'active', p_max_instances, v_brand, v_sub)
  returning * into v_ws;

  insert into public.workspace_data_policies (workspace_id)
  values (v_ws.id)
  on conflict (workspace_id) do nothing;

  insert into public.workspace_memberships (workspace_id, user_id, role, status)
  values (v_ws.id, p_owner_user_id, 'owner', 'active');

  if char_length(v_owner_name) > 0 then
    insert into public.profiles (id, display_name)
    values (p_owner_user_id, left(v_owner_name, 80))
    on conflict (id) do update set display_name = excluded.display_name;
  end if;

  insert into private.workspace_admin_meta (workspace_id, plan_label, admin_notes)
  values (v_ws.id, v_plan, v_notes);

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    v_ws.id,
    p_actor_user_id,
    'master',
    'platform_workspace_created',
    'workspace',
    v_ws.id::text,
    jsonb_build_object('name', v_ws.name, 'max_instances', v_ws.max_instances, 'plan_label', v_plan, 'owner_user_id', p_owner_user_id)
  );

  return jsonb_build_object(
    'id', v_ws.id,
    'name', v_ws.name,
    'status', v_ws.status,
    'max_instances', v_ws.max_instances,
    'brand_name', v_ws.brand_name,
    'brand_subtitle', v_ws.brand_subtitle,
    'plan_label', v_plan,
    'admin_notes', v_notes
  );
end;
$$;
revoke all on function public.provision_platform_workspace(uuid, uuid, text, integer, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.provision_platform_workspace(uuid, uuid, text, integer, text, text, text, text, text) to service_role;

create or replace function public.update_platform_workspace(
  p_workspace_id uuid,
  p_name text,
  p_status text,
  p_max_instances integer,
  p_plan_label text,
  p_admin_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_plan text := coalesce(nullif(regexp_replace(btrim(coalesce(p_plan_label, '')), '\s+', ' ', 'g'), ''), 'Padrão');
  v_notes text := btrim(coalesce(p_admin_notes, ''));
  v_ws public.workspaces%rowtype;
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;
  if char_length(v_name) not between 2 and 120 then
    raise exception 'Invalid workspace name' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'closed') then
    raise exception 'Invalid workspace status' using errcode = '22023';
  end if;
  if p_max_instances is null or p_max_instances not between 0 and 50 then
    raise exception 'Invalid max_instances' using errcode = '22023';
  end if;
  if char_length(v_plan) > 60 or char_length(v_notes) > 4000 then
    raise exception 'Invalid plan or notes' using errcode = '22023';
  end if;

  select w.* into v_ws
  from public.workspaces w
  where w.id = p_workspace_id and w.status in ('active', 'closed')
  for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  update public.workspaces
  set name = v_name,
      status = p_status,
      max_instances = p_max_instances,
      closed_at = case when p_status = 'closed' then coalesce(closed_at, now()) else null end
  where id = p_workspace_id
  returning * into v_ws;

  if p_status = 'closed' then
    update public.campaigns
    set status = 'paused'
    where workspace_id = p_workspace_id and status = 'running';
  end if;

  insert into private.workspace_admin_meta (workspace_id, plan_label, admin_notes)
  values (p_workspace_id, v_plan, v_notes)
  on conflict (workspace_id) do update
    set plan_label = excluded.plan_label,
        admin_notes = excluded.admin_notes,
        updated_at = now();

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id,
    v_actor,
    'master',
    'platform_workspace_updated',
    'workspace',
    p_workspace_id::text,
    jsonb_build_object('name', v_ws.name, 'status', v_ws.status, 'max_instances', v_ws.max_instances, 'plan_label', v_plan)
  );

  return jsonb_build_object(
    'id', v_ws.id,
    'name', v_ws.name,
    'status', v_ws.status,
    'max_instances', v_ws.max_instances,
    'plan_label', v_plan,
    'admin_notes', v_notes,
    'closed_at', v_ws.closed_at
  );
end;
$$;
revoke all on function public.update_platform_workspace(uuid, text, text, integer, text, text) from public, anon;
grant execute on function public.update_platform_workspace(uuid, text, text, integer, text, text) to authenticated;

create or replace function public.start_support_session(
  p_workspace_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g');
  v_ws public.workspaces%rowtype;
  v_session public.support_sessions%rowtype;
  v_prev public.support_sessions%rowtype;
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;
  if char_length(v_reason) > 300 then
    raise exception 'Invalid support reason' using errcode = '22023';
  end if;

  select w.* into v_ws
  from public.workspaces w
  where w.id = p_workspace_id and w.status in ('active', 'closed');
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  for v_prev in
    update public.support_sessions
    set ended_at = now()
    where admin_user_id = v_actor and ended_at is null
    returning *
  loop
    insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
    values (
      v_prev.workspace_id,
      v_actor,
      'master',
      'support_session_ended',
      'support_session',
      v_prev.id::text,
      jsonb_build_object('auto_replaced', true)
    );
  end loop;

  insert into public.support_sessions (admin_user_id, workspace_id, reason)
  values (v_actor, p_workspace_id, v_reason)
  returning * into v_session;

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id,
    v_actor,
    'master',
    'support_session_started',
    'support_session',
    v_session.id::text,
    jsonb_build_object('reason', v_reason, 'expires_at', v_session.expires_at, 'workspace_name', v_ws.name)
  );

  return jsonb_build_object(
    'session_id', v_session.id,
    'workspace_id', v_ws.id,
    'workspace_name', v_ws.name,
    'workspace_status', v_ws.status,
    'brand_name', v_ws.brand_name,
    'brand_subtitle', v_ws.brand_subtitle,
    'reason', v_session.reason,
    'started_at', v_session.started_at,
    'expires_at', v_session.expires_at
  );
end;
$$;
revoke all on function public.start_support_session(uuid, text) from public, anon;
grant execute on function public.start_support_session(uuid, text) to authenticated;

create or replace function public.end_support_session()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_closed public.support_sessions%rowtype;
  v_count integer := 0;
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;

  for v_closed in
    update public.support_sessions
    set ended_at = now()
    where admin_user_id = v_actor and ended_at is null
    returning *
  loop
    v_count := v_count + 1;
    insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
    values (
      v_closed.workspace_id,
      v_actor,
      'master',
      'support_session_ended',
      'support_session',
      v_closed.id::text,
      jsonb_build_object('auto_replaced', false)
    );
  end loop;

  return jsonb_build_object('ended', v_count);
end;
$$;
revoke all on function public.end_support_session() from public, anon;
grant execute on function public.end_support_session() to authenticated;

create or replace function public.list_platform_support_audit(p_limit integer default 40)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 40), 1), 200);
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', row_data.id,
      'workspace_id', row_data.workspace_id,
      'workspace_name', row_data.workspace_name,
      'action', row_data.action,
      'actor_email', row_data.actor_email,
      'details', row_data.details,
      'created_at', row_data.created_at
    ) order by row_data.created_at desc, row_data.id desc)
    from (
      select
        e.id,
        e.workspace_id,
        coalesce(w.name, 'Plataforma') as workspace_name,
        e.action,
        coalesce(u.email, '') as actor_email,
        e.details,
        e.created_at
      from private.audit_events e
      left join public.workspaces w on w.id = e.workspace_id
      left join auth.users u on u.id = e.actor_user_id
      where e.actor_kind = 'master'
         or e.action in ('support_session_started','support_session_ended','platform_workspace_created','platform_workspace_updated')
      order by e.created_at desc, e.id desc
      limit v_limit
    ) row_data
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_platform_support_audit(integer) from public, anon;
grant execute on function public.list_platform_support_audit(integer) to authenticated;

-- =============================================================================================
-- 5. Limpeza automática de mídias expiradas (`retention_delete_after`) — somente servidor
-- =============================================================================================

create or replace function public.claim_expired_message_attachments(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_result jsonb;
begin
  with claimed as (
    select a.id
    from public.message_attachments a
    where a.deletion_status = 'active'
      and a.retention_delete_after is not null
      and a.retention_delete_after <= now()
      and a.object_key !~ '^[0-9a-f-]{36}/(catalogo|audios)/'
    order by a.retention_delete_after asc, a.id asc
    limit v_limit
    for update skip locked
  ),
  updated as (
    update public.message_attachments a
    set deletion_status = 'pending'
    from claimed c
    where a.id = c.id
    returning a.id, a.workspace_id, a.object_key
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', u.id,
      'workspace_id', u.workspace_id,
      'object_key', u.object_key
    )),
    '[]'::jsonb
  )
  into v_result
  from updated u;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;
revoke all on function public.claim_expired_message_attachments(integer) from public, anon, authenticated;
grant execute on function public.claim_expired_message_attachments(integer) to service_role;

create or replace function public.complete_expired_message_attachments_cleanup(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_ws record;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return jsonb_build_object('deleted', 0);
  end if;

  for v_ws in
    with done as (
      update public.message_attachments a
      set deletion_status = 'deleted'
      where a.id = any(p_ids)
        and a.deletion_status = 'pending'
      returning a.workspace_id
    )
    select workspace_id, count(*)::int as qty
    from done
    group by workspace_id
  loop
    v_count := v_count + v_ws.qty;
    insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
    values (
      v_ws.workspace_id,
      null,
      'service',
      'attachment_retention_purged',
      'message_attachment',
      v_ws.workspace_id::text,
      jsonb_build_object('deleted_count', v_ws.qty)
    );
  end loop;

  return jsonb_build_object('deleted', v_count);
end;
$$;
revoke all on function public.complete_expired_message_attachments_cleanup(uuid[]) from public, anon, authenticated;
grant execute on function public.complete_expired_message_attachments_cleanup(uuid[]) to service_role;

create or replace function public.release_expired_message_attachments(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;

  update public.message_attachments
  set deletion_status = 'active'
  where id = any(p_ids)
    and deletion_status = 'pending';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.release_expired_message_attachments(uuid[]) from public, anon, authenticated;
grant execute on function public.release_expired_message_attachments(uuid[]) to service_role;

commit;
