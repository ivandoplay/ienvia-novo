begin;

-- Fase 3 — CRM completo na Inbox:
--   - Dados cadastrais do contato (empresa, CPF/CNPJ, cidade, origem do lead, observações fixas)
--   - Ignorar IA neste número e bloquear contato (bloqueio respeitado por private.ai_block_reason)
--   - Pipeline Kanban (conversations.crm_stage), Negociação R$ (deal_value, deal_status, deal_lost_reason)
--   - Fixar conversa no topo (is_pinned), Retorno combinado (follow_up_at), Marcar como não lida / Arquivar
--   - Etiquetas personalizadas coloridas (crm_tags + contact_tags)
--   - Notas internas da equipe (conversation_notes)
--   - Respostas rápidas "/" (quick_replies)
--   - Mensagens programadas (scheduled_messages) com envio idempotente
--   - Nova conversa manual, Ações em massa e Apagar contato e conversa com trilha de auditoria

-- =============================================================================================
-- 1. Colunas CRM em contacts e conversations
-- =============================================================================================

alter table public.contacts
  add column company text not null default '' check (char_length(company) <= 120),
  add column document_id text not null default '' check (char_length(document_id) <= 30),
  add column city text not null default '' check (char_length(city) <= 100),
  add column lead_source text not null default '' check (char_length(lead_source) <= 80),
  add column notes text not null default '' check (char_length(notes) <= 4000),
  add column ai_ignored boolean not null default false,
  add column is_blocked boolean not null default false;

alter table public.conversations
  add column crm_stage text not null default 'novo'
    check (crm_stage in ('novo','qualificando','em_atendimento','proposta','concluido')),
  add column deal_value numeric(12,2) not null default 0 check (deal_value >= 0),
  add column deal_status text not null default 'open' check (deal_status in ('open','won','lost')),
  add column deal_lost_reason text not null default '' check (char_length(deal_lost_reason) <= 300),
  add column is_pinned boolean not null default false,
  add column follow_up_at timestamptz;

create index conversations_workspace_pinned_activity_idx
  on public.conversations(workspace_id, is_pinned desc, activity_at desc, id desc);

create index conversations_workspace_crm_stage_idx
  on public.conversations(workspace_id, crm_stage, activity_at desc)
  where stage <> 'archived';

-- =============================================================================================
-- 2. Tabelas novas do CRM (todas com RLS, sem acesso anon e escrita via RPCs auditadas)
-- =============================================================================================

create table public.crm_tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  color text not null default '#10b981' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create unique index crm_tags_workspace_name_uq
  on public.crm_tags(workspace_id, lower(btrim(name)));

alter table public.crm_tags enable row level security;
revoke all on public.crm_tags from anon, authenticated;
grant select on public.crm_tags to authenticated;
grant all on public.crm_tags to service_role;
create policy crm_tags_select_member on public.crm_tags for select to authenticated
  using (private.is_workspace_member(workspace_id));

create table public.contact_tags (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null,
  tag_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, contact_id, tag_id),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, tag_id) references public.crm_tags(workspace_id, id) on delete cascade
);

create index contact_tags_tag_idx on public.contact_tags(workspace_id, tag_id, contact_id);

alter table public.contact_tags enable row level security;
revoke all on public.contact_tags from anon, authenticated;
grant select on public.contact_tags to authenticated;
grant all on public.contact_tags to service_role;
create policy contact_tags_select_member on public.contact_tags for select to authenticated
  using (private.is_workspace_member(workspace_id));

create table public.conversation_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null,
  author_user_id uuid references auth.users(id) on delete set null,
  author_name text not null default '' check (char_length(author_name) <= 120),
  body_text text not null check (char_length(btrim(body_text)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id) on delete cascade
);

create index conversation_notes_conv_idx
  on public.conversation_notes(workspace_id, conversation_id, created_at asc, id asc);

alter table public.conversation_notes enable row level security;
revoke all on public.conversation_notes from anon, authenticated;
grant select on public.conversation_notes to authenticated;
grant all on public.conversation_notes to service_role;
create policy conversation_notes_select_member on public.conversation_notes for select to authenticated
  using (private.is_workspace_member(workspace_id));

create table public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  shortcut text not null check (shortcut ~ '^[a-z0-9_-]{1,32}$'),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  body_text text not null check (char_length(btrim(body_text)) between 1 and 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, shortcut)
);

alter table public.quick_replies enable row level security;
revoke all on public.quick_replies from anon, authenticated;
grant select on public.quick_replies to authenticated;
grant all on public.quick_replies to service_role;
create policy quick_replies_select_member on public.quick_replies for select to authenticated
  using (private.is_workspace_member(workspace_id));
create trigger quick_replies_touch_updated_at before update on public.quick_replies
  for each row execute function private.touch_updated_at();

create table public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null,
  instance_id uuid not null,
  created_by uuid references auth.users(id) on delete set null,
  body_text text not null check (char_length(btrim(body_text)) between 1 and 4096),
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  message_id uuid,
  error_detail text check (error_detail is null or char_length(error_detail) <= 300),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id) on delete cascade,
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete restrict
);

create index scheduled_messages_due_idx
  on public.scheduled_messages(status, scheduled_for)
  where status = 'pending';

create index scheduled_messages_conv_idx
  on public.scheduled_messages(workspace_id, conversation_id, scheduled_for asc);

alter table public.scheduled_messages enable row level security;
revoke all on public.scheduled_messages from anon, authenticated;
grant select on public.scheduled_messages to authenticated;
grant all on public.scheduled_messages to service_role;
create policy scheduled_messages_select_member on public.scheduled_messages for select to authenticated
  using (private.is_workspace_member(workspace_id));
create trigger scheduled_messages_touch_updated_at before update on public.scheduled_messages
  for each row execute function private.touch_updated_at();

-- =============================================================================================
-- 3. Auxiliares internos e regra de bloqueio da IA por número ignorado/bloqueado
-- =============================================================================================

create or replace function private.contact_tags_json(p_workspace_id uuid, p_contact_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) order by lower(t.name), t.id),
    '[]'::jsonb
  )
  from public.contact_tags ct
  join public.crm_tags t on t.workspace_id = ct.workspace_id and t.id = ct.tag_id
  where ct.workspace_id = p_workspace_id and ct.contact_id = p_contact_id
$$;
revoke all on function private.contact_tags_json(uuid, uuid) from public, anon, authenticated;

create or replace function private.normalize_whatsapp_digits(p_raw text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_raw text := btrim(coalesce(p_raw, ''));
  v_digits text := regexp_replace(v_raw, '[^0-9]', '', 'g');
  v_has_plus boolean := left(v_raw, 1) = '+';
begin
  v_digits := regexp_replace(v_digits, '^0+', '');
  if v_digits = '' then
    return null;
  end if;
  if not v_has_plus and char_length(v_digits) in (10, 11) then
    v_digits := '55' || v_digits;
  end if;
  if char_length(v_digits) not between 8 and 15 then
    return null;
  end if;
  return v_digits;
end;
$$;
revoke all on function private.normalize_whatsapp_digits(text) from public, anon, authenticated;

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
    'operator'
  )
$$;
revoke all on function private.actor_kind_for(uuid, uuid) from public, anon, authenticated;

-- Atualiza ai_block_reason para respeitar contatos marcados como ai_ignored ou is_blocked.
create or replace function private.ai_block_reason(p_workspace_id uuid, p_conversation_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_instance public.instances%rowtype;
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
  if not found or v_instance.status = 'revoked' or v_instance.engine <> 'evolution'
    or v_instance.provider_instance_name is null then
    return 'chip_unavailable';
  end if;
  if not v_instance.is_enabled then return 'chip_ai_off'; end if;
  if v_instance.status <> 'connected' then return 'chip_not_connected'; end if;

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

-- =============================================================================================
-- 4. Leituras enriquecidas da Inbox, Conversa, Contatos, Kanban e Busca Global (Ctrl+K)
-- =============================================================================================

create or replace function public.read_my_crm_inbox(
  p_workspace_id uuid,
  p_view text,
  p_instance_id uuid,
  p_search text,
  p_phones text[],
  p_limit integer,
  p_tag_id uuid default null,
  p_deal_status text default null,
  p_crm_stage text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_phones text[] := array[]::text[];
  v_condition text;
  v_rows jsonb;
  v_found integer;
  v_unread integer;
  v_waiting integer;
  v_archived integer;
  v_deal text := nullif(btrim(coalesce(p_deal_status, '')), '');
  v_crm_stage text := nullif(btrim(coalesce(p_crm_stage, '')), '');
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  if v_deal is not null and v_deal not in ('open','won','lost','with_value') then
    raise exception 'Unsupported deal filter' using errcode = '22023';
  end if;
  if v_crm_stage is not null and v_crm_stage not in ('novo','qualificando','em_atendimento','proposta','concluido') then
    raise exception 'Unsupported CRM stage filter' using errcode = '22023';
  end if;

  if v_search is not null then
    if char_length(v_search) > 80 then
      raise exception 'Search text too long' using errcode = '22023';
    end if;
    v_condition := 'c.stage <> ''archived''';
    v_pattern := '%' || replace(replace(replace(v_search, '!', '!!'), '%', '!%'), '_', '!_') || '%';
    select coalesce(array_agg(distinct t.x), array[]::text[]) into v_phones
    from unnest(coalesce(p_phones, array[]::text[])) as t(x)
    where t.x ~ '^[0-9]{4,20}$';
    if cardinality(v_phones) > 8 then
      raise exception 'Too many phone variants' using errcode = '22023';
    end if;
  else
    v_condition := case coalesce(p_view, 'open')
      when 'open' then 'c.stage in (''new'',''ai'',''waiting_human'',''human'',''waiting_customer'')'
      when 'unread' then 'c.unread_count > 0 and c.stage in (''new'',''ai'',''waiting_human'',''human'',''waiting_customer'')'
      when 'waiting' then 'c.stage in (''new'',''waiting_human'',''human'')'
      when 'resolved' then 'c.stage = ''resolved'''
      when 'archived' then 'c.stage = ''archived'''
    end;
    if v_condition is null then
      raise exception 'Unsupported inbox view' using errcode = '22023';
    end if;
  end if;

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(f) - ''rn'' order by f.rn) filter (where f.rn <= $1), ''[]''::jsonb), count(*)::integer
     from (
       select c.id, c.stage, c.crm_stage, c.deal_value, c.deal_status, c.is_pinned, c.follow_up_at,
              c.unread_count, c.last_message_at, c.last_message_preview, c.activity_at,
              c.automation_paused, c.instance_id, i.display_name as instance_name,
              c.contact_id, ct.display_name as contact_name, ct.phone_e164 as contact_phone,
              ct.company as contact_company, ct.ai_ignored, ct.is_blocked,
              (select coalesce(jsonb_agg(jsonb_build_object(''id'', t.id, ''name'', t.name, ''color'', t.color) order by lower(t.name), t.id), ''[]''::jsonb)
               from public.contact_tags ctg
               join public.crm_tags t on t.workspace_id = ctg.workspace_id and t.id = ctg.tag_id
               where ctg.workspace_id = c.workspace_id and ctg.contact_id = c.contact_id) as tags,
              row_number() over (order by c.is_pinned desc, c.activity_at desc, c.id desc) as rn
       from public.conversations c
       join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
       join public.instances i on i.workspace_id = c.workspace_id and i.id = c.instance_id
       where c.workspace_id = $2
         and ($3::uuid is null or c.instance_id = $3)
         and %s
         and ($6::uuid is null or exists (
               select 1 from public.contact_tags t
               where t.workspace_id = c.workspace_id and t.contact_id = c.contact_id and t.tag_id = $6))
         and ($7::text is null
              or ($7 = ''with_value'' and c.deal_value > 0)
              or ($7 in (''open'',''won'',''lost'') and c.deal_status = $7))
         and ($8::text is null or c.crm_stage = $8)
         and ($4::text is null
              or ct.display_name ilike $4 escape ''!''
              or ct.company ilike $4 escape ''!''
              or ct.city ilike $4 escape ''!''
              or c.last_message_preview ilike $4 escape ''!''
              or exists (select 1 from unnest($5::text[]) as p(x) where position(p.x in ct.phone_e164) > 0))
       order by c.is_pinned desc, c.activity_at desc, c.id desc
       limit $1 + 1
     ) f', v_condition)
  into v_rows, v_found
  using v_limit, p_workspace_id, p_instance_id, v_pattern, v_phones, p_tag_id, v_deal, v_crm_stage;

  select count(*)::integer into v_unread
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.unread_count > 0
    and c.stage in ('new','ai','waiting_human','human','waiting_customer')
    and (p_instance_id is null or c.instance_id = p_instance_id);

  select count(*)::integer into v_waiting
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.stage in ('new','waiting_human','human')
    and (p_instance_id is null or c.instance_id = p_instance_id);

  select count(*)::integer into v_archived
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.stage = 'archived'
    and (p_instance_id is null or c.instance_id = p_instance_id);

  return jsonb_build_object(
    'conversations', v_rows,
    'has_more', v_found > v_limit,
    'counts', jsonb_build_object('unread', v_unread, 'waiting', v_waiting),
    'archived_count', v_archived
  );
end;
$$;

-- Mantém assinatura de 6 argumentos 100% compatível delegando para read_my_crm_inbox.
create or replace function public.read_my_inbox(
  p_workspace_id uuid,
  p_view text,
  p_instance_id uuid,
  p_search text,
  p_phones text[],
  p_limit integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select public.read_my_crm_inbox(p_workspace_id, p_view, p_instance_id, p_search, p_phones, p_limit, null, null, null)
$$;

-- Conversa aberta com dados CRM, etiquetas, notas internas e envios agendados.
create or replace function public.read_my_conversation(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_message_limit integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_message_limit, 200), 1), 1000);
  v_conversation jsonb;
  v_messages jsonb;
  v_notes jsonb;
  v_scheduled jsonb;
  v_found integer;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', c.id,
    'stage', c.stage,
    'crm_stage', c.crm_stage,
    'deal_value', c.deal_value,
    'deal_status', c.deal_status,
    'deal_lost_reason', c.deal_lost_reason,
    'is_pinned', c.is_pinned,
    'follow_up_at', c.follow_up_at,
    'unread_count', c.unread_count,
    'automation_paused', c.automation_paused,
    'created_at', c.created_at,
    'last_message_at', c.last_message_at,
    'contact', jsonb_build_object(
      'id', ct.id,
      'display_name', ct.display_name,
      'phone_e164', ct.phone_e164,
      'email', ct.email,
      'company', ct.company,
      'document_id', ct.document_id,
      'city', ct.city,
      'lead_source', ct.lead_source,
      'notes', ct.notes,
      'ai_ignored', ct.ai_ignored,
      'is_blocked', ct.is_blocked,
      'erased', ct.erased_at is not null,
      'created_at', ct.created_at,
      'tags', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) order by lower(t.name), t.id), '[]'::jsonb)
               from public.contact_tags ctg
               join public.crm_tags t on t.workspace_id = ctg.workspace_id and t.id = ctg.tag_id
               where ctg.workspace_id = c.workspace_id and ctg.contact_id = c.contact_id)
    ),
    'instance', jsonb_build_object('id', i.id, 'display_name', i.display_name, 'status', i.status, 'engine', i.engine),
    'ai', jsonb_build_object(
      'chip_enabled', i.is_enabled,
      'workspace_paused', exists (select 1 from public.workspace_ai_state s where s.workspace_id = c.workspace_id and s.paused),
      'locked', c.automation_paused,
      'paused_until', case when not c.automation_paused and c.ai_paused_until > now() then c.ai_paused_until end,
      'pause_reason', c.ai_pause_reason,
      'handoff_at', c.ai_handoff_at,
      'handoff_note', c.ai_handoff_note,
      'working', exists (
        select 1 from public.ai_turns t
        where t.workspace_id = c.workspace_id and t.conversation_id = c.id
          and ((t.status = 'waiting' and t.due_at > now() - interval '20 seconds')
            or (t.status = 'running' and t.claimed_at > now() - interval '3 minutes')))))
  into v_conversation
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  join public.instances i on i.workspace_id = c.workspace_id and i.id = c.instance_id
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
  if v_conversation is null then
    return null;
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) - 'rn' order by t.rn desc) filter (where t.rn <= v_limit), '[]'::jsonb), count(*)::integer
  into v_messages, v_found
  from (
    select m.id, m.direction, m.actor_type, m.status, m.body_text, m.occurred_at, m.created_at,
           (m.sent_by is not null) as from_panel,
           coalesce(m.sent_by = auth.uid(), false) as mine,
           (select jsonb_build_object('kind', a.kind, 'content_type', a.content_type, 'byte_size', a.byte_size,
                     'file_name', a.file_name, 'duration_seconds', a.duration_seconds, 'width', a.width,
                     'height', a.height, 'is_voice', a.is_voice, 'object_key', a.object_key,
                     'status', case when a.deletion_status in ('pending','deleted') then 'deleted'
                                    else a.storage_status end)
            from public.message_attachments a
            where a.workspace_id = m.workspace_id and a.message_id = m.id) as attachment,
           row_number() over (order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc) as rn
    from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = p_conversation_id
    order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc
    limit v_limit + 1
  ) t;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', n.id,
        'body_text', n.body_text,
        'author_name', n.author_name,
        'mine', coalesce(n.author_user_id = auth.uid(), false),
        'created_at', n.created_at
      )
      order by n.created_at asc, n.id asc
    ),
    '[]'::jsonb
  )
  into v_notes
  from public.conversation_notes n
  where n.workspace_id = p_workspace_id and n.conversation_id = p_conversation_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'body_text', s.body_text,
        'scheduled_for', s.scheduled_for,
        'status', s.status,
        'error_detail', s.error_detail,
        'sent_at', s.sent_at,
        'created_at', s.created_at
      )
      order by s.scheduled_for asc, s.id asc
    ),
    '[]'::jsonb
  )
  into v_scheduled
  from public.scheduled_messages s
  where s.workspace_id = p_workspace_id
    and s.conversation_id = p_conversation_id
    and s.status <> 'cancelled';

  return jsonb_build_object(
    'conversation', v_conversation,
    'messages', v_messages,
    'notes', v_notes,
    'scheduled_messages', v_scheduled,
    'has_more', v_found > v_limit
  );
end;
$$;

create or replace function public.read_my_inbox_version(p_workspace_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case when private.is_workspace_member(p_workspace_id) then
    concat_ws('|',
      (select extract(epoch from max(c.updated_at))::text from public.conversations c where c.workspace_id = p_workspace_id),
      (select extract(epoch from max(i.updated_at))::text from public.instances i where i.workspace_id = p_workspace_id),
      (select coalesce(sum(c.unread_count), 0)::text from public.conversations c
        where c.workspace_id = p_workspace_id and c.unread_count > 0),
      (select extract(epoch from s.updated_at)::text from public.workspace_ai_state s where s.workspace_id = p_workspace_id),
      (select extract(epoch from max(n.created_at))::text from public.conversation_notes n where n.workspace_id = p_workspace_id),
      (select extract(epoch from max(sm.updated_at))::text from public.scheduled_messages sm where sm.workspace_id = p_workspace_id))
  else '' end
$$;

-- Catálogos do CRM da empresa (etiquetas personalizadas e respostas rápidas "/").
create or replace function public.read_my_crm_catalogs(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tags jsonb;
  v_replies jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) order by lower(t.name), t.id),
    '[]'::jsonb
  ) into v_tags
  from public.crm_tags t
  where t.workspace_id = p_workspace_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', q.id, 'shortcut', q.shortcut, 'title', q.title, 'body_text', q.body_text)
      order by q.shortcut asc
    ),
    '[]'::jsonb
  ) into v_replies
  from public.quick_replies q
  where q.workspace_id = p_workspace_id;

  return jsonb_build_object('tags', v_tags, 'quick_replies', v_replies);
end;
$$;

-- Agenda de Contatos do CRM.
create or replace function public.read_my_contacts_directory(
  p_workspace_id uuid,
  p_search text default null,
  p_phones text[] default '{}',
  p_filter text default 'all',
  p_limit integer default 60,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 60), 1), 150);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_phones text[] := array[]::text[];
  v_filter text := coalesce(nullif(btrim(p_filter), ''), 'all');
  v_rows jsonb;
  v_total integer;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if v_filter not in ('all','named','ignored','blocked') then
    raise exception 'Unsupported contacts filter' using errcode = '22023';
  end if;
  if v_search is not null then
    if char_length(v_search) > 80 then raise exception 'Search text too long' using errcode = '22023'; end if;
    v_pattern := '%' || replace(replace(replace(v_search, '!', '!!'), '%', '!%'), '_', '!_') || '%';
    select coalesce(array_agg(distinct t.x), array[]::text[]) into v_phones
    from unnest(coalesce(p_phones, array[]::text[])) as t(x)
    where t.x ~ '^[0-9]{4,20}$';
  end if;

  select count(*)::integer into v_total
  from public.contacts ct
  where ct.workspace_id = p_workspace_id
    and ct.erased_at is null
    and (v_filter = 'all'
         or (v_filter = 'named' and btrim(ct.display_name) <> '')
         or (v_filter = 'ignored' and ct.ai_ignored)
         or (v_filter = 'blocked' and ct.is_blocked))
    and (v_pattern is null
         or ct.display_name ilike v_pattern escape '!'
         or ct.company ilike v_pattern escape '!'
         or ct.city ilike v_pattern escape '!'
         or ct.email ilike v_pattern escape '!'
         or ct.notes ilike v_pattern escape '!'
         or exists (select 1 from unnest(v_phones) as p(x) where position(p.x in coalesce(ct.phone_e164, '')) > 0));

  select coalesce(jsonb_agg(to_jsonb(r) order by r.updated_at desc, r.id desc), '[]'::jsonb)
  into v_rows
  from (
    select ct.id, ct.display_name, ct.phone_e164, ct.email, ct.company, ct.document_id,
           ct.city, ct.lead_source, ct.notes, ct.ai_ignored, ct.is_blocked,
           ct.channel, ct.instance_id, ct.created_at, ct.updated_at,
           i.display_name as instance_name,
           (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) order by lower(t.name), t.id), '[]'::jsonb)
            from public.contact_tags ctg
            join public.crm_tags t on t.workspace_id = ctg.workspace_id and t.id = ctg.tag_id
            where ctg.workspace_id = ct.workspace_id and ctg.contact_id = ct.id) as tags,
           (select c.id from public.conversations c
            where c.workspace_id = ct.workspace_id and c.contact_id = ct.id
            order by (c.stage <> 'archived') desc, c.activity_at desc, c.id desc limit 1) as conversation_id,
           (select c.crm_stage from public.conversations c
            where c.workspace_id = ct.workspace_id and c.contact_id = ct.id
            order by (c.stage <> 'archived') desc, c.activity_at desc, c.id desc limit 1) as crm_stage,
           (select c.deal_value from public.conversations c
            where c.workspace_id = ct.workspace_id and c.contact_id = ct.id
            order by (c.stage <> 'archived') desc, c.activity_at desc, c.id desc limit 1) as deal_value,
           (select c.deal_status from public.conversations c
            where c.workspace_id = ct.workspace_id and c.contact_id = ct.id
            order by (c.stage <> 'archived') desc, c.activity_at desc, c.id desc limit 1) as deal_status
    from public.contacts ct
    left join public.instances i on i.workspace_id = ct.workspace_id and i.id = ct.instance_id
    where ct.workspace_id = p_workspace_id
      and ct.erased_at is null
      and (v_filter = 'all'
           or (v_filter = 'named' and btrim(ct.display_name) <> '')
           or (v_filter = 'ignored' and ct.ai_ignored)
           or (v_filter = 'blocked' and ct.is_blocked))
      and (v_pattern is null
           or ct.display_name ilike v_pattern escape '!'
           or ct.company ilike v_pattern escape '!'
           or ct.city ilike v_pattern escape '!'
           or ct.email ilike v_pattern escape '!'
           or ct.notes ilike v_pattern escape '!'
           or exists (select 1 from unnest(v_phones) as p(x) where position(p.x in coalesce(ct.phone_e164, '')) > 0))
    order by ct.updated_at desc, ct.id desc
    limit v_limit offset v_offset
  ) r;

  return jsonb_build_object('contacts', v_rows, 'total', v_total, 'has_more', v_offset + v_limit < v_total);
end;
$$;

-- Quadro Kanban das conversas ativas/resolvidas (fora de arquivadas).
create or replace function public.read_my_kanban(
  p_workspace_id uuid,
  p_instance_id uuid default null,
  p_search text default null,
  p_phones text[] default '{}',
  p_tag_id uuid default null,
  p_deal_status text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_phones text[] := array[]::text[];
  v_deal text := nullif(btrim(coalesce(p_deal_status, '')), '');
  v_cards jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if v_search is not null then
    if char_length(v_search) > 80 then raise exception 'Search text too long' using errcode = '22023'; end if;
    v_pattern := '%' || replace(replace(replace(v_search, '!', '!!'), '%', '!%'), '_', '!_') || '%';
    select coalesce(array_agg(distinct t.x), array[]::text[]) into v_phones
    from unnest(coalesce(p_phones, array[]::text[])) as t(x)
    where t.x ~ '^[0-9]{4,20}$';
  end if;

  select coalesce(jsonb_agg(to_jsonb(k) order by k.is_pinned desc, k.activity_at desc, k.id desc), '[]'::jsonb)
  into v_cards
  from (
    select c.id, c.stage, c.crm_stage, c.deal_value, c.deal_status, c.is_pinned, c.follow_up_at,
           c.unread_count, c.last_message_preview, c.last_message_at, c.activity_at,
           c.instance_id, i.display_name as instance_name,
           c.contact_id, ct.display_name as contact_name, ct.phone_e164 as contact_phone,
           ct.company as contact_company,
           (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color) order by lower(t.name), t.id), '[]'::jsonb)
            from public.contact_tags ctg
            join public.crm_tags t on t.workspace_id = ctg.workspace_id and t.id = ctg.tag_id
            where ctg.workspace_id = c.workspace_id and ctg.contact_id = c.contact_id) as tags
    from public.conversations c
    join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
    join public.instances i on i.workspace_id = c.workspace_id and i.id = c.instance_id
    where c.workspace_id = p_workspace_id
      and c.stage <> 'archived'
      and ct.erased_at is null
      and (p_instance_id is null or c.instance_id = p_instance_id)
      and (p_tag_id is null or exists (
            select 1 from public.contact_tags t
            where t.workspace_id = c.workspace_id and t.contact_id = c.contact_id and t.tag_id = p_tag_id))
      and (v_deal is null
           or (v_deal = 'with_value' and c.deal_value > 0)
           or (v_deal in ('open','won','lost') and c.deal_status = v_deal))
      and (v_pattern is null
           or ct.display_name ilike v_pattern escape '!'
           or ct.company ilike v_pattern escape '!'
           or c.last_message_preview ilike v_pattern escape '!'
           or exists (select 1 from unnest(v_phones) as p(x) where position(p.x in coalesce(ct.phone_e164, '')) > 0))
    order by c.is_pinned desc, c.activity_at desc, c.id desc
    limit 200
  ) k;

  return jsonb_build_object('cards', v_cards);
end;
$$;

-- Busca global rápida (Ctrl+K) na empresa atual.
create or replace function public.global_search_my_workspace(
  p_workspace_id uuid,
  p_query text,
  p_phones text[] default '{}'
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
  v_phones text[] := array[]::text[];
  v_conversations jsonb;
  v_contacts jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if v_q is null then
    return jsonb_build_object('conversations', '[]'::jsonb, 'contacts', '[]'::jsonb);
  end if;
  if char_length(v_q) > 80 then raise exception 'Search text too long' using errcode = '22023'; end if;

  v_pattern := '%' || replace(replace(replace(v_q, '!', '!!'), '%', '!%'), '_', '!_') || '%';
  select coalesce(array_agg(distinct t.x), array[]::text[]) into v_phones
  from unnest(coalesce(p_phones, array[]::text[])) as t(x)
  where t.x ~ '^[0-9]{4,20}$';

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_conversations
  from (
    select c.id, c.stage, c.crm_stage, c.last_message_preview, c.activity_at,
           ct.display_name as contact_name, ct.phone_e164 as contact_phone,
           i.display_name as instance_name
    from public.conversations c
    join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
    join public.instances i on i.workspace_id = c.workspace_id and i.id = c.instance_id
    where c.workspace_id = p_workspace_id
      and ct.erased_at is null
      and (ct.display_name ilike v_pattern escape '!'
           or ct.company ilike v_pattern escape '!'
           or c.last_message_preview ilike v_pattern escape '!'
           or exists (select 1 from unnest(v_phones) as p(x) where position(p.x in coalesce(ct.phone_e164, '')) > 0))
    order by c.activity_at desc, c.id desc
    limit 10
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_contacts
  from (
    select ct.id, ct.display_name, ct.phone_e164, ct.company, ct.city,
           (select c.id from public.conversations c
            where c.workspace_id = ct.workspace_id and c.contact_id = ct.id
            order by c.activity_at desc, c.id desc limit 1) as conversation_id
    from public.contacts ct
    where ct.workspace_id = p_workspace_id
      and ct.erased_at is null
      and (ct.display_name ilike v_pattern escape '!'
           or ct.company ilike v_pattern escape '!'
           or ct.city ilike v_pattern escape '!'
           or ct.email ilike v_pattern escape '!'
           or exists (select 1 from unnest(v_phones) as p(x) where position(p.x in coalesce(ct.phone_e164, '')) > 0))
    order by ct.updated_at desc, ct.id desc
    limit 10
  ) r;

  return jsonb_build_object('conversations', v_conversations, 'contacts', v_contacts);
end;
$$;

-- =============================================================================================
-- 5. Escritas seguras do CRM (todas validam vínculo ativo e gravam private.audit_events)
-- =============================================================================================

create or replace function public.save_my_contact(
  p_workspace_id uuid,
  p_contact_id uuid default null,
  p_data jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_name text := btrim(coalesce(p_data ->> 'display_name', ''));
  v_phone_raw text := btrim(coalesce(p_data ->> 'phone', ''));
  v_digits text := private.normalize_whatsapp_digits(v_phone_raw);
  v_phone_e164 text := case when v_digits is not null then '+' || v_digits end;
  v_jid text := case when v_digits is not null then v_digits || '@s.whatsapp.net' end;
  v_email text := nullif(btrim(coalesce(p_data ->> 'email', '')), '');
  v_company text := left(btrim(coalesce(p_data ->> 'company', '')), 120);
  v_document text := left(btrim(coalesce(p_data ->> 'document_id', '')), 30);
  v_city text := left(btrim(coalesce(p_data ->> 'city', '')), 100);
  v_source text := left(btrim(coalesce(p_data ->> 'lead_source', '')), 80);
  v_notes text := left(btrim(coalesce(p_data ->> 'notes', '')), 4000);
  v_row public.contacts%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  if v_name = '' and v_phone_e164 is null then
    raise exception 'contact_name_or_phone_required' using errcode = '22023';
  end if;
  if v_phone_raw <> '' and v_digits is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  if char_length(v_name) > 160 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  if p_contact_id is not null then
    select * into v_row
    from public.contacts c
    where c.workspace_id = p_workspace_id and c.id = p_contact_id and c.erased_at is null
    for update;
    if not found then
      raise exception 'Contact not found' using errcode = 'P0002';
    end if;

    update public.contacts
    set display_name = v_name,
        phone_e164 = coalesce(v_phone_e164, phone_e164),
        external_user_id = case when v_row.channel = 'whatsapp' and v_jid is not null and v_row.external_user_id is null
                                then v_jid else external_user_id end,
        email = v_email,
        company = v_company,
        document_id = v_document,
        city = v_city,
        lead_source = v_source,
        notes = v_notes
    where workspace_id = p_workspace_id and id = p_contact_id
    returning * into v_row;

    update public.conversations set updated_at = now()
    where workspace_id = p_workspace_id and contact_id = p_contact_id;
  else
    insert into public.contacts(
      workspace_id, channel, display_name, phone_e164, email,
      company, document_id, city, lead_source, notes
    )
    values (
      p_workspace_id, 'manual', v_name, v_phone_e164, v_email,
      v_company, v_document, v_city, v_source, v_notes
    )
    returning * into v_row;
  end if;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind,
    case when p_contact_id is null then 'contact_created' else 'contact_updated' end,
    'contact', v_row.id::text, jsonb_build_object('display_name', v_row.display_name));

  return jsonb_build_object('id', v_row.id, 'display_name', v_row.display_name, 'phone_e164', v_row.phone_e164);
end;
$$;

create or replace function public.update_my_contact_flags(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_ai_ignored boolean default null,
  p_is_blocked boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_row public.contacts%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  select * into v_row
  from public.contacts c
  where c.workspace_id = p_workspace_id and c.id = p_contact_id and c.erased_at is null
  for update;
  if not found then raise exception 'Contact not found' using errcode = 'P0002'; end if;

  update public.contacts
  set ai_ignored = coalesce(p_ai_ignored, ai_ignored),
      is_blocked = coalesce(p_is_blocked, is_blocked)
  where workspace_id = p_workspace_id and id = p_contact_id
  returning * into v_row;

  if v_row.ai_ignored or v_row.is_blocked then
    update public.ai_turns t
    set status = 'skipped', finished_at = clock_timestamp(), outcome_detail = 'contact_ignored'
    from public.conversations c
    where c.workspace_id = p_workspace_id and c.contact_id = p_contact_id
      and t.workspace_id = p_workspace_id and t.conversation_id = c.id and t.status = 'waiting';
  end if;

  update public.conversations set updated_at = now()
  where workspace_id = p_workspace_id and contact_id = p_contact_id;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'contact_flags_updated', 'contact', p_contact_id::text,
    jsonb_build_object('ai_ignored', v_row.ai_ignored, 'is_blocked', v_row.is_blocked));

  return jsonb_build_object('id', v_row.id, 'ai_ignored', v_row.ai_ignored, 'is_blocked', v_row.is_blocked);
end;
$$;

-- Abre ou cria uma conversa de WhatsApp para iniciar contato ativo pela Inbox ou Agenda.
create or replace function public.start_or_open_my_conversation(
  p_workspace_id uuid,
  p_instance_id uuid,
  p_phone_raw text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_digits text := private.normalize_whatsapp_digits(p_phone_raw);
  v_jid text;
  v_phone_e164 text;
  v_name text := left(btrim(coalesce(p_display_name, '')), 160);
  v_instance public.instances%rowtype;
  v_contact_id uuid;
  v_conv_id uuid;
  v_created boolean := false;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if v_digits is null then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);
  v_jid := v_digits || '@s.whatsapp.net';
  v_phone_e164 := '+' || v_digits;

  select * into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = p_instance_id and i.status <> 'revoked';
  if not found or v_instance.engine <> 'evolution' then
    raise exception 'instance_unavailable' using errcode = 'P0001';
  end if;

  select ct.id into v_contact_id
  from public.contacts ct
  where ct.workspace_id = p_workspace_id
    and ct.erased_at is null
    and ct.channel = 'whatsapp'
    and ct.instance_id = p_instance_id
    and (ct.external_user_id = v_jid or private.phone_core(coalesce(ct.phone_e164, ct.external_user_id)) = private.phone_core(v_digits))
  order by (ct.external_user_id = v_jid) desc, ct.created_at asc
  limit 1;

  if v_contact_id is null then
    -- Se existir contato manual salvo na Agenda com o mesmo número, vincula ao chip em vez de duplicar.
    select ct.id into v_contact_id
    from public.contacts ct
    where ct.workspace_id = p_workspace_id
      and ct.erased_at is null
      and ct.channel = 'manual'
      and ct.instance_id is null
      and ct.phone_e164 is not null
      and private.phone_core(ct.phone_e164) = private.phone_core(v_digits)
    order by ct.created_at asc
    limit 1;

    if v_contact_id is not null then
      update public.contacts
      set channel = 'whatsapp',
          instance_id = p_instance_id,
          external_user_id = v_jid,
          display_name = case when display_name = '' and v_name <> '' then v_name else display_name end
      where workspace_id = p_workspace_id and id = v_contact_id;
    else
      insert into public.contacts(workspace_id, instance_id, channel, external_user_id, display_name, phone_e164)
      values (p_workspace_id, p_instance_id, 'whatsapp', v_jid, v_name, v_phone_e164)
      returning id into v_contact_id;
    end if;
  elsif v_name <> '' then
    update public.contacts
    set display_name = case when display_name in ('','Contato') then v_name else display_name end
    where workspace_id = p_workspace_id and id = v_contact_id;
  end if;

  select c.id into v_conv_id
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.contact_id = v_contact_id and c.instance_id = p_instance_id
  order by (c.stage <> 'archived') desc, c.activity_at desc, c.id desc
  limit 1;

  if v_conv_id is null then
    v_created := true;
    insert into public.conversations(
      workspace_id, contact_id, instance_id, stage, crm_stage,
      assigned_user_id, assigned_label, automation_paused, unread_count
    )
    values (
      p_workspace_id, v_contact_id, p_instance_id, 'human', 'novo',
      v_actor, 'Atendente', true, 0
    )
    returning id into v_conv_id;
  else
    update public.conversations
    set stage = case when stage in ('resolved','archived') then 'human' else stage end,
        unread_count = 0,
        updated_at = now()
    where workspace_id = p_workspace_id and id = v_conv_id;
  end if;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'conversation_opened_manual', 'conversation', v_conv_id::text,
    jsonb_build_object('contact_id', v_contact_id, 'created', v_created));

  return jsonb_build_object('conversation_id', v_conv_id, 'contact_id', v_contact_id, 'created', v_created);
end;
$$;

create or replace function public.update_my_conversation_crm(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_row public.conversations%rowtype;
  v_crm_stage text;
  v_deal_value numeric(12,2);
  v_deal_status text;
  v_lost_reason text;
  v_follow_up timestamptz;
  v_stage text;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  select * into v_row
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id
  for update;
  if not found then
    raise exception 'Conversation not found' using errcode = 'P0002';
  end if;

  v_crm_stage := coalesce(nullif(btrim(coalesce(p_patch ->> 'crm_stage', '')), ''), v_row.crm_stage);
  if v_crm_stage not in ('novo','qualificando','em_atendimento','proposta','concluido') then
    raise exception 'Invalid crm_stage' using errcode = '22023';
  end if;

  if p_patch ? 'deal_value' then
    v_deal_value := (p_patch ->> 'deal_value')::numeric(12,2);
    if v_deal_value is null or v_deal_value < 0 or v_deal_value > 999999999.99 then
      raise exception 'Invalid deal_value' using errcode = '22023';
    end if;
  else
    v_deal_value := v_row.deal_value;
  end if;

  v_deal_status := coalesce(nullif(btrim(coalesce(p_patch ->> 'deal_status', '')), ''), v_row.deal_status);
  if v_deal_status not in ('open','won','lost') then
    raise exception 'Invalid deal_status' using errcode = '22023';
  end if;

  if p_patch ? 'deal_lost_reason' then
    v_lost_reason := left(btrim(coalesce(p_patch ->> 'deal_lost_reason', '')), 300);
  else
    v_lost_reason := v_row.deal_lost_reason;
  end if;
  if v_deal_status <> 'lost' then
    v_lost_reason := '';
  end if;

  if coalesce((p_patch ->> 'clear_follow_up')::boolean, false) then
    v_follow_up := null;
  elsif p_patch ? 'follow_up_at' then
    v_follow_up := nullif(btrim(coalesce(p_patch ->> 'follow_up_at', '')), '')::timestamptz;
  else
    v_follow_up := v_row.follow_up_at;
  end if;

  v_stage := v_row.stage;
  if coalesce((p_patch ->> 'archive')::boolean, false) then
    v_stage := 'archived';
  elsif coalesce((p_patch ->> 'unarchive')::boolean, false) and v_row.stage = 'archived' then
    v_stage := 'human';
  end if;

  update public.conversations
  set crm_stage = v_crm_stage,
      deal_value = v_deal_value,
      deal_status = v_deal_status,
      deal_lost_reason = v_lost_reason,
      is_pinned = case when p_patch ? 'is_pinned' then coalesce((p_patch ->> 'is_pinned')::boolean, is_pinned) else is_pinned end,
      follow_up_at = v_follow_up,
      unread_count = case when coalesce((p_patch ->> 'mark_unread')::boolean, false) then greatest(unread_count, 1) else unread_count end,
      stage = v_stage,
      automation_paused = case when v_stage = 'archived' then true else automation_paused end
  where workspace_id = p_workspace_id and id = p_conversation_id
  returning * into v_row;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'conversation_crm_updated', 'conversation', p_conversation_id::text, p_patch);

  return jsonb_build_object(
    'id', v_row.id,
    'stage', v_row.stage,
    'crm_stage', v_row.crm_stage,
    'deal_value', v_row.deal_value,
    'deal_status', v_row.deal_status,
    'is_pinned', v_row.is_pinned,
    'follow_up_at', v_row.follow_up_at,
    'unread_count', v_row.unread_count
  );
end;
$$;

-- Ações em massa na lista de conversas (até 100 por chamada).
create or replace function public.bulk_update_my_conversations(
  p_workspace_id uuid,
  p_conversation_ids uuid[],
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_ids uuid[];
  v_count integer := 0;
  v_crm_stage text;
  v_tag_id uuid;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  select coalesce(array_agg(distinct x), array[]::uuid[]) into v_ids
  from unnest(coalesce(p_conversation_ids, array[]::uuid[])) as t(x)
  where x is not null;

  if cardinality(v_ids) = 0 then
    return jsonb_build_object('updated', 0);
  end if;
  if cardinality(v_ids) > 100 then
    raise exception 'Too many conversations in bulk action' using errcode = '22023';
  end if;

  if p_action = 'mark_read' then
    update public.conversations set unread_count = 0
    where workspace_id = p_workspace_id and id = any(v_ids);
    get diagnostics v_count = row_count;
  elsif p_action = 'mark_unread' then
    update public.conversations set unread_count = greatest(unread_count, 1)
    where workspace_id = p_workspace_id and id = any(v_ids);
    get diagnostics v_count = row_count;
  elsif p_action = 'archive' then
    update public.conversations set stage = 'archived', automation_paused = true
    where workspace_id = p_workspace_id and id = any(v_ids);
    get diagnostics v_count = row_count;
  elsif p_action = 'resolve' then
    update public.conversations set stage = 'resolved', automation_paused = true
    where workspace_id = p_workspace_id and id = any(v_ids) and stage <> 'archived';
    get diagnostics v_count = row_count;
  elsif p_action = 'reopen' then
    update public.conversations set stage = 'human'
    where workspace_id = p_workspace_id and id = any(v_ids) and stage in ('resolved','archived');
    get diagnostics v_count = row_count;
  elsif p_action = 'pause_ai' then
    update public.conversations set automation_paused = true, ai_pause_reason = 'claimed'
    where workspace_id = p_workspace_id and id = any(v_ids);
    get diagnostics v_count = row_count;
  elsif p_action = 'resume_ai' then
    update public.conversations set automation_paused = false, ai_paused_until = null, ai_pause_reason = null, ai_handoff_note = null
    where workspace_id = p_workspace_id and id = any(v_ids) and stage not in ('resolved','archived');
    get diagnostics v_count = row_count;
  elsif p_action = 'set_crm_stage' then
    v_crm_stage := btrim(coalesce(p_payload ->> 'crm_stage', ''));
    if v_crm_stage not in ('novo','qualificando','em_atendimento','proposta','concluido') then
      raise exception 'Invalid crm_stage' using errcode = '22023';
    end if;
    update public.conversations set crm_stage = v_crm_stage
    where workspace_id = p_workspace_id and id = any(v_ids);
    get diagnostics v_count = row_count;
  elsif p_action = 'add_tag' then
    v_tag_id := nullif(btrim(coalesce(p_payload ->> 'tag_id', '')), '')::uuid;
    perform 1 from public.crm_tags t where t.workspace_id = p_workspace_id and t.id = v_tag_id;
    if not found then raise exception 'Tag not found' using errcode = 'P0002'; end if;
    insert into public.contact_tags(workspace_id, contact_id, tag_id)
    select distinct c.workspace_id, c.contact_id, v_tag_id
    from public.conversations c
    where c.workspace_id = p_workspace_id and c.id = any(v_ids)
    on conflict do nothing;
    get diagnostics v_count = row_count;
    update public.conversations set updated_at = now()
    where workspace_id = p_workspace_id and id = any(v_ids);
  else
    raise exception 'Unsupported bulk action' using errcode = '22023';
  end if;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'conversations_bulk_' || p_action, 'workspace', p_workspace_id::text,
    jsonb_build_object('count', v_count, 'conversation_ids', v_ids, 'payload', p_payload));

  return jsonb_build_object('updated', v_count);
end;
$$;

-- Notas internas da equipe (ficam apenas no painel).
create or replace function public.add_my_conversation_note(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_body_text text
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
  v_author_name text;
  v_note public.conversation_notes%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 4000 then
    raise exception 'Invalid note text' using errcode = '22023';
  end if;
  perform 1 from public.conversations c where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;

  v_kind := private.actor_kind_for(p_workspace_id, v_actor);
  select coalesce(nullif(btrim(p.display_name), ''), 'Equipe') into v_author_name
  from public.profiles p where p.id = v_actor;
  v_author_name := left(coalesce(v_author_name, 'Equipe'), 120);

  insert into public.conversation_notes(workspace_id, conversation_id, author_user_id, author_name, body_text)
  values (p_workspace_id, p_conversation_id, v_actor, v_author_name, v_body)
  returning * into v_note;

  update public.conversations set updated_at = now()
  where workspace_id = p_workspace_id and id = p_conversation_id;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'conversation_note_added', 'conversation', p_conversation_id::text,
    jsonb_build_object('note_id', v_note.id));

  return jsonb_build_object(
    'id', v_note.id,
    'body_text', v_note.body_text,
    'author_name', v_note.author_name,
    'mine', true,
    'created_at', v_note.created_at
  );
end;
$$;

-- Etiquetas personalizadas e vínculo com contatos.
create or replace function public.save_my_crm_tag(
  p_workspace_id uuid,
  p_tag_id uuid,
  p_name text,
  p_color text default '#10b981'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_name text := btrim(coalesce(p_name, ''));
  v_color text := coalesce(nullif(btrim(coalesce(p_color, '')), ''), '#10b981');
  v_row public.crm_tags%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 40 then
    raise exception 'invalid_tag_name' using errcode = '22023';
  end if;
  if v_color !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'invalid_tag_color' using errcode = '22023';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  if p_tag_id is not null then
    update public.crm_tags
    set name = v_name, color = v_color
    where workspace_id = p_workspace_id and id = p_tag_id
    returning * into v_row;
    if not found then raise exception 'Tag not found' using errcode = 'P0002'; end if;
  else
    insert into public.crm_tags(workspace_id, name, color)
    values (p_workspace_id, v_name, v_color)
    returning * into v_row;
  end if;

  update public.conversations c set updated_at = now()
  where c.workspace_id = p_workspace_id
    and exists (select 1 from public.contact_tags ct
                where ct.workspace_id = p_workspace_id and ct.contact_id = c.contact_id and ct.tag_id = v_row.id);

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'crm_tag_saved', 'crm_tag', v_row.id::text,
    jsonb_build_object('name', v_row.name, 'color', v_row.color));

  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'color', v_row.color);
end;
$$;

create or replace function public.delete_my_crm_tag(p_workspace_id uuid, p_tag_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_deleted integer := 0;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  update public.conversations c set updated_at = now()
  where c.workspace_id = p_workspace_id
    and exists (select 1 from public.contact_tags ct
                where ct.workspace_id = p_workspace_id and ct.contact_id = c.contact_id and ct.tag_id = p_tag_id);

  delete from public.crm_tags where workspace_id = p_workspace_id and id = p_tag_id;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
    values (p_workspace_id, v_actor, v_kind, 'crm_tag_deleted', 'crm_tag', p_tag_id::text, '{}'::jsonb);
  end if;
  return v_deleted > 0;
end;
$$;

create or replace function public.toggle_my_contact_tag(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_tag_id uuid,
  p_attached boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  perform 1 from public.contacts c where c.workspace_id = p_workspace_id and c.id = p_contact_id and c.erased_at is null;
  if not found then raise exception 'Contact not found' using errcode = 'P0002'; end if;
  perform 1 from public.crm_tags t where t.workspace_id = p_workspace_id and t.id = p_tag_id;
  if not found then raise exception 'Tag not found' using errcode = 'P0002'; end if;

  if coalesce(p_attached, true) then
    insert into public.contact_tags(workspace_id, contact_id, tag_id)
    values (p_workspace_id, p_contact_id, p_tag_id)
    on conflict do nothing;
  else
    delete from public.contact_tags
    where workspace_id = p_workspace_id and contact_id = p_contact_id and tag_id = p_tag_id;
  end if;

  update public.conversations set updated_at = now()
  where workspace_id = p_workspace_id and contact_id = p_contact_id;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind,
    case when coalesce(p_attached, true) then 'contact_tag_added' else 'contact_tag_removed' end,
    'contact', p_contact_id::text, jsonb_build_object('tag_id', p_tag_id));

  return private.contact_tags_json(p_workspace_id, p_contact_id);
end;
$$;

-- Respostas rápidas "/".
create or replace function public.save_my_quick_reply(
  p_workspace_id uuid,
  p_reply_id uuid,
  p_shortcut text,
  p_title text,
  p_body_text text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_shortcut text := lower(regexp_replace(btrim(coalesce(p_shortcut, '')), '^/+', ''));
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := btrim(coalesce(p_body_text, ''));
  v_row public.quick_replies%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if v_shortcut !~ '^[a-z0-9_-]{1,32}$' then
    raise exception 'invalid_shortcut' using errcode = '22023';
  end if;
  if char_length(v_title) not between 1 and 80 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  if char_length(v_body) not between 1 and 4096 then
    raise exception 'invalid_body' using errcode = '22023';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  if p_reply_id is not null then
    update public.quick_replies
    set shortcut = v_shortcut, title = v_title, body_text = v_body
    where workspace_id = p_workspace_id and id = p_reply_id
    returning * into v_row;
    if not found then raise exception 'Quick reply not found' using errcode = 'P0002'; end if;
  else
    insert into public.quick_replies(workspace_id, shortcut, title, body_text)
    values (p_workspace_id, v_shortcut, v_title, v_body)
    returning * into v_row;
  end if;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'quick_reply_saved', 'quick_reply', v_row.id::text,
    jsonb_build_object('shortcut', v_row.shortcut));

  return jsonb_build_object('id', v_row.id, 'shortcut', v_row.shortcut, 'title', v_row.title, 'body_text', v_row.body_text);
end;
$$;

create or replace function public.delete_my_quick_reply(p_workspace_id uuid, p_reply_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_deleted integer := 0;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  delete from public.quick_replies where workspace_id = p_workspace_id and id = p_reply_id;
  get diagnostics v_deleted = row_count;
  if v_deleted > 0 then
    insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
    values (p_workspace_id, v_actor, v_kind, 'quick_reply_deleted', 'quick_reply', p_reply_id::text, '{}'::jsonb);
  end if;
  return v_deleted > 0;
end;
$$;

-- Agendamento de mensagens na conversa.
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
  if not found or v_instance.status = 'revoked' or v_instance.engine <> 'evolution' then
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

create or replace function public.cancel_my_scheduled_message(
  p_workspace_id uuid,
  p_scheduled_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_row public.scheduled_messages%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  update public.scheduled_messages
  set status = 'cancelled'
  where workspace_id = p_workspace_id and id = p_scheduled_id and status = 'pending'
  returning * into v_row;
  if not found then return false; end if;

  update public.conversations set updated_at = now()
  where workspace_id = p_workspace_id and id = v_row.conversation_id;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, v_kind, 'scheduled_message_cancelled', 'scheduled_message', p_scheduled_id::text, '{}'::jsonb);
  return true;
end;
$$;

-- Despacho seguro dos agendamentos vencidos (exclusivo service_role).
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
    if v_inst.id is null or v_inst.status <> 'connected' or v_inst.engine <> 'evolution' or v_inst.provider_instance_name is null then
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
      v_msg_id, v_rec.workspace_id, v_rec.conversation_id, v_rec.instance_id, 'outbound', 'evolution', 'human',
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

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'scheduled_id', v_rec.id,
      'workspace_id', v_rec.workspace_id,
      'conversation_id', v_rec.conversation_id,
      'message_id', v_msg_id,
      'provider_instance_name', v_inst.provider_instance_name,
      'recipient', v_contact.external_user_id,
      'body_text', v_rec.body_text
    ));
  end loop;

  return v_items;
end;
$$;

create or replace function public.finish_scheduled_message(
  p_workspace_id uuid,
  p_scheduled_id uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error_detail text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.scheduled_messages%rowtype;
begin
  if p_outcome not in ('sent','failed','uncertain') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;

  select * into v_row
  from public.scheduled_messages s
  where s.workspace_id = p_workspace_id and s.id = p_scheduled_id
  for update;
  if not found then return; end if;

  if v_row.message_id is not null then
    perform private.finish_outbound_message(p_workspace_id, v_row.message_id, p_outcome, p_provider_message_id, v_row.created_by, 'service');
  end if;

  update public.scheduled_messages
  set status = case when p_outcome = 'sent' then 'sent' else 'failed' end,
      sent_at = case when p_outcome = 'sent' then coalesce(sent_at, clock_timestamp()) else sent_at end,
      error_detail = case when p_outcome = 'sent' then null
                          else nullif(left(btrim(coalesce(p_error_detail, p_outcome)), 300), '') end
  where workspace_id = p_workspace_id and id = p_scheduled_id;

  update public.conversations set updated_at = now()
  where workspace_id = p_workspace_id and id = v_row.conversation_id;
end;
$$;

-- Exclusão confirmada e auditada de contato + conversas + mensagens.
create or replace function public.delete_my_contact_and_conversation(
  p_workspace_id uuid,
  p_contact_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_kind text;
  v_contact public.contacts%rowtype;
  v_conv_ids uuid[];
  v_msg_ids uuid[];
  v_object_keys text[];
  v_conv_count integer := 0;
  v_msg_count integer := 0;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_kind := private.actor_kind_for(p_workspace_id, v_actor);

  select * into v_contact
  from public.contacts c
  where c.workspace_id = p_workspace_id and c.id = p_contact_id
  for update;
  if not found then
    raise exception 'Contact not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(c.id), array[]::uuid[]) into v_conv_ids
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.contact_id = p_contact_id;
  v_conv_count := cardinality(v_conv_ids);

  select coalesce(array_agg(m.id), array[]::uuid[]) into v_msg_ids
  from public.messages m
  where m.workspace_id = p_workspace_id and m.conversation_id = any(v_conv_ids);
  v_msg_count := cardinality(v_msg_ids);

  select coalesce(array_agg(distinct a.object_key), array[]::text[]) into v_object_keys
  from public.message_attachments a
  where a.workspace_id = p_workspace_id and a.message_id = any(v_msg_ids);

  update public.contact_erasure_requests
  set contact_id = null
  where workspace_id = p_workspace_id and contact_id = p_contact_id;

  delete from public.campaign_recipients
  where workspace_id = p_workspace_id and (contact_id = p_contact_id or message_id = any(v_msg_ids));

  delete from public.outbox_jobs
  where workspace_id = p_workspace_id and conversation_id = any(v_conv_ids);

  delete from public.message_attachments
  where workspace_id = p_workspace_id and message_id = any(v_msg_ids);

  delete from public.scheduled_messages
  where workspace_id = p_workspace_id and conversation_id = any(v_conv_ids);

  delete from public.conversation_notes
  where workspace_id = p_workspace_id and conversation_id = any(v_conv_ids);

  delete from public.ai_turns
  where workspace_id = p_workspace_id and conversation_id = any(v_conv_ids);

  delete from public.messages
  where workspace_id = p_workspace_id and conversation_id = any(v_conv_ids);

  delete from public.conversations
  where workspace_id = p_workspace_id and contact_id = p_contact_id;

  delete from public.contact_consent_state
  where workspace_id = p_workspace_id and contact_id = p_contact_id;

  delete from public.contact_consent_events
  where workspace_id = p_workspace_id and contact_id = p_contact_id;

  delete from public.contact_links
  where workspace_id = p_workspace_id and (contact_id_low = p_contact_id or contact_id_high = p_contact_id);

  delete from public.contact_tags
  where workspace_id = p_workspace_id and contact_id = p_contact_id;

  delete from public.contacts
  where workspace_id = p_workspace_id and id = p_contact_id;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id, v_actor, v_kind,
    'contact_and_conversation_deleted', 'contact', p_contact_id::text,
    jsonb_build_object(
      'display_name', v_contact.display_name,
      'phone_e164', v_contact.phone_e164,
      'conversations_deleted', v_conv_count,
      'messages_deleted', v_msg_count
    )
  );

  return jsonb_build_object(
    'deleted', true,
    'conversations_deleted', v_conv_count,
    'messages_deleted', v_msg_count,
    'object_keys', to_jsonb(v_object_keys)
  );
end;
$$;

-- =============================================================================================
-- 6. Permissões explícitas
-- =============================================================================================

revoke all on function public.read_my_crm_inbox(uuid,text,uuid,text,text[],integer,uuid,text,text) from public, anon;
revoke all on function public.read_my_crm_catalogs(uuid) from public, anon;
revoke all on function public.read_my_contacts_directory(uuid,text,text[],text,integer,integer) from public, anon;
revoke all on function public.read_my_kanban(uuid,uuid,text,text[],uuid,text) from public, anon;
revoke all on function public.global_search_my_workspace(uuid,text,text[]) from public, anon;
revoke all on function public.save_my_contact(uuid,uuid,jsonb) from public, anon;
revoke all on function public.update_my_contact_flags(uuid,uuid,boolean,boolean) from public, anon;
revoke all on function public.start_or_open_my_conversation(uuid,uuid,text,text) from public, anon;
revoke all on function public.update_my_conversation_crm(uuid,uuid,jsonb) from public, anon;
revoke all on function public.bulk_update_my_conversations(uuid,uuid[],text,jsonb) from public, anon;
revoke all on function public.add_my_conversation_note(uuid,uuid,text) from public, anon;
revoke all on function public.save_my_crm_tag(uuid,uuid,text,text) from public, anon;
revoke all on function public.delete_my_crm_tag(uuid,uuid) from public, anon;
revoke all on function public.toggle_my_contact_tag(uuid,uuid,uuid,boolean) from public, anon;
revoke all on function public.save_my_quick_reply(uuid,uuid,text,text,text) from public, anon;
revoke all on function public.delete_my_quick_reply(uuid,uuid) from public, anon;
revoke all on function public.schedule_my_message(uuid,uuid,text,timestamptz) from public, anon;
revoke all on function public.cancel_my_scheduled_message(uuid,uuid) from public, anon;
revoke all on function public.delete_my_contact_and_conversation(uuid,uuid) from public, anon;

grant execute on function public.read_my_crm_inbox(uuid,text,uuid,text,text[],integer,uuid,text,text) to authenticated;
grant execute on function public.read_my_crm_catalogs(uuid) to authenticated;
grant execute on function public.read_my_contacts_directory(uuid,text,text[],text,integer,integer) to authenticated;
grant execute on function public.read_my_kanban(uuid,uuid,text,text[],uuid,text) to authenticated;
grant execute on function public.global_search_my_workspace(uuid,text,text[]) to authenticated;
grant execute on function public.save_my_contact(uuid,uuid,jsonb) to authenticated;
grant execute on function public.update_my_contact_flags(uuid,uuid,boolean,boolean) to authenticated;
grant execute on function public.start_or_open_my_conversation(uuid,uuid,text,text) to authenticated;
grant execute on function public.update_my_conversation_crm(uuid,uuid,jsonb) to authenticated;
grant execute on function public.bulk_update_my_conversations(uuid,uuid[],text,jsonb) to authenticated;
grant execute on function public.add_my_conversation_note(uuid,uuid,text) to authenticated;
grant execute on function public.save_my_crm_tag(uuid,uuid,text,text) to authenticated;
grant execute on function public.delete_my_crm_tag(uuid,uuid) to authenticated;
grant execute on function public.toggle_my_contact_tag(uuid,uuid,uuid,boolean) to authenticated;
grant execute on function public.save_my_quick_reply(uuid,uuid,text,text,text) to authenticated;
grant execute on function public.delete_my_quick_reply(uuid,uuid) to authenticated;
grant execute on function public.schedule_my_message(uuid,uuid,text,timestamptz) to authenticated;
grant execute on function public.cancel_my_scheduled_message(uuid,uuid) to authenticated;
grant execute on function public.delete_my_contact_and_conversation(uuid,uuid) to authenticated;

revoke all on function public.claim_due_scheduled_messages(integer) from public, anon, authenticated;
revoke all on function public.finish_scheduled_message(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_due_scheduled_messages(integer) to service_role;
grant execute on function public.finish_scheduled_message(uuid,uuid,text,text,text) to service_role;

commit;
