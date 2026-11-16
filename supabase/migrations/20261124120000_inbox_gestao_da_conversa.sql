begin;

-- Inbox: a gestão fina da conversa (24/11/2026) — reconstrução do banco publicado.
--
-- Esta migração não existia no Git: o SQL foi aplicado direto no Supabase e o commit desta rodada se
-- perdeu. O que está aqui foi tirado do próprio banco (pg_get_functiondef), um a um, e o resultado é
-- conferido pela impressão digital do esquema (supabase/tests/esquema.test.ts) contra o banco real.
--
--   - Silenciar a conversa (is_muted): continua na lista, só não avisa mais.
--   - Transferir para uma pessoa da equipe (assign_my_conversation) ou devolver para a fila.
--   - Automação de etapa (crm_stage_automations): etiqueta + mensagem prontas por etapa do funil.
--     A automação só PLANEJA — quem envia é sempre uma pessoa.
--   - Buscar dentro das mensagens: na conversa aberta (search_my_conversation_messages) e na empresa
--     inteira (search_my_workspace_messages), com o termo escapado (o % do cliente não é curinga).
--   - Citar no envio (messages.reply_to_message_id): a citação só é aceita se a mensagem citada for da
--     mesma conversa; caso contrário o envio segue sem citação.
--   - Editar uma mensagem agendada que ainda não saiu (update_my_scheduled_message).
--   - Lembretes: a aba da Inbox é a view `reminders` de read_my_crm_inbox (retorno vencido).
--   - Contar as não lidas ignora as conversas silenciadas (count_my_unread_messages).

-- 1) Silenciar: a conversa continua na lista, só não avisa mais.
alter table public.conversations add column if not exists is_muted boolean not null default false;

-- 2) Citar: a mensagem enviada pode apontar para a que está sendo respondida.
alter table public.messages add column if not exists reply_to_message_id uuid;
alter table public.messages drop constraint if exists messages_reply_to_message_fk;
alter table public.messages
  add constraint messages_reply_to_message_fk
  foreign key (workspace_id, reply_to_message_id) references public.messages(workspace_id, id) on delete set null;
create index if not exists messages_reply_to_idx on public.messages (workspace_id, reply_to_message_id)
  where reply_to_message_id is not null;

-- 3) Automação de etapa: uma linha por etapa da empresa (o teto de 1000 letras vem do banco real).
create table if not exists public.crm_stage_automations (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  stage text not null
    check (stage in ('novo','qualificando','em_atendimento','proposta','concluido')),
  tag_id uuid,
  message_template text,
  enable_message boolean not null default false,
  enable_tag boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, stage),
  constraint crm_stage_automations_tag_fk
    foreign key (workspace_id, tag_id) references public.crm_tags(workspace_id, id) on delete set null
);
alter table public.crm_stage_automations enable row level security;
-- A leitura é da empresa toda (é só configuração); a escrita passa por save_my_stage_automation, que
-- confere se quem salva é o dono. A tela nunca escreve direto na tabela.
drop policy if exists crm_stage_automations_owner_read on public.crm_stage_automations;
create policy crm_stage_automations_owner_read on public.crm_stage_automations
  for select using (private.is_workspace_member(workspace_id));
-- No Supabase o `alter default privileges` já dá DELETE/INSERT/SELECT/UPDATE em tabela nova para
-- authenticated e service_role. Aqui a tabela nasce fechada e só a leitura é liberada.
-- No Supabase, tabela nova já nasce com INSERT/SELECT/UPDATE/DELETE para authenticated e service_role;
-- aqui a única diferença é o anon, que não pode nem ler. A tabela tem RLS ligada e só a política de
-- LEITURA, então ninguém escreve por aqui: a escrita é só pelas funções.
revoke all on public.crm_stage_automations from anon;

-- 4) As funções, do jeito que estão no banco publicado.
CREATE OR REPLACE FUNCTION public.assign_my_conversation(p_workspace_id uuid, p_conversation_id uuid, p_user_id uuid, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row public.conversations%rowtype;
  v_destino text;
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select * into v_row from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id
  for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  if v_row.stage = 'archived' then
    raise exception 'conversation_closed' using errcode = 'P0001';
  end if;

  if p_user_id is not null then
    if not exists (
      select 1 from public.workspace_memberships wm
      where wm.workspace_id = p_workspace_id and wm.user_id = p_user_id and wm.status = 'active'
    ) then
      raise exception 'Teammate not in workspace' using errcode = '22023';
    end if;
    select coalesce(nullif(btrim(p.display_name), ''), split_part(u.email, '@', 1))
    into v_destino
    from auth.users u
    left join public.profiles p on p.id = u.id
    where u.id = p_user_id;
    v_destino := coalesce(v_destino, 'Atendente');
  end if;

  update public.conversations
  set assigned_user_id = p_user_id,
      assigned_label = case
        when p_user_id is null then null
        else coalesce(v_label, v_destino, 'Atendente')
      end,
      stage = case when v_row.stage in ('new', 'ai', 'waiting_human') then 'human' else v_row.stage end,
      automation_paused = case when p_user_id is null then v_row.automation_paused else true end,
      ai_pause_reason = case when p_user_id is null then v_row.ai_pause_reason else 'claimed' end,
      updated_at = now()
  where workspace_id = p_workspace_id and id = p_conversation_id
  returning * into v_row;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id,
    v_actor,
    private.actor_kind_for(p_workspace_id, v_actor),
    case when p_user_id is null then 'conversation_released' else 'conversation_assigned' end,
    'conversation',
    p_conversation_id::text,
    jsonb_build_object('assigned_user_id', p_user_id, 'assigned_label', v_row.assigned_label)
  );

  return jsonb_build_object(
    'assigned_user_id', v_row.assigned_user_id,
    'assigned_label', v_row.assigned_label,
    'stage', v_row.stage
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.read_my_workspace_people(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me uuid := auth.uid();
  v_rows jsonb;
begin
  if v_me is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(f) order by f.name), '[]'::jsonb)
  into v_rows
  from (
    select wm.user_id as id,
           coalesce(nullif(btrim(p.display_name), ''), split_part(u.email, '@', 1)) as name,
           wm.role,
           (wm.user_id = v_me) as eu
    from public.workspace_memberships wm
    join auth.users u on u.id = wm.user_id
    left join public.profiles p on p.id = wm.user_id
    where wm.workspace_id = p_workspace_id
      and wm.status = 'active'
  ) f;

  return jsonb_build_object('people', v_rows);
end;
$function$;

CREATE OR REPLACE FUNCTION public.read_my_stage_automations(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(to_jsonb(a) order by a.stage), '[]'::jsonb)
  from public.crm_stage_automations a
  where a.workspace_id = p_workspace_id
    and private.is_workspace_member(p_workspace_id);
$function$;

CREATE OR REPLACE FUNCTION public.save_my_stage_automation(p_workspace_id uuid, p_stage text, p_enable_tag boolean, p_tag_id uuid, p_enable_message boolean, p_message_template text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_stage text := nullif(btrim(coalesce(p_stage, '')), '');
  v_text text := nullif(btrim(coalesce(p_message_template, '')), '');
  v_row public.crm_stage_automations%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Owner required' using errcode = '42501';
  end if;
  if v_stage is null or v_stage not in ('novo', 'qualificando', 'em_atendimento', 'proposta', 'concluido') then
    raise exception 'Unsupported CRM stage' using errcode = '22023';
  end if;
  if coalesce(p_enable_message, false) and (v_text is null or char_length(v_text) > 4096) then
    raise exception 'Invalid message template' using errcode = '22023';
  end if;
  if coalesce(p_enable_tag, false) and p_tag_id is null then
    raise exception 'Tag required' using errcode = '22023';
  end if;

  insert into public.crm_stage_automations as a (
    workspace_id, stage, tag_id, message_template, enable_message, enable_tag, updated_at
  )
  values (
    p_workspace_id, v_stage,
    case when coalesce(p_enable_tag, false) then p_tag_id else null end,
    case when coalesce(p_enable_message, false) then v_text else null end,
    coalesce(p_enable_message, false), coalesce(p_enable_tag, false), now()
  )
  on conflict (workspace_id, stage) do update
  set tag_id = excluded.tag_id,
      message_template = excluded.message_template,
      enable_message = excluded.enable_message,
      enable_tag = excluded.enable_tag,
      updated_at = now()
  returning * into v_row;

  return to_jsonb(v_row);
end;
$function$;

CREATE OR REPLACE FUNCTION public.plan_my_stage_automation(p_workspace_id uuid, p_conversation_id uuid, p_stage text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row public.crm_stage_automations%rowtype;
  v_nome text;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select * into v_row from public.crm_stage_automations a
  where a.workspace_id = p_workspace_id and a.stage = p_stage;
  if not found then
    return jsonb_build_object('tag_id', null, 'message', null);
  end if;

  select coalesce(nullif(btrim(ct.display_name), ''), ct.phone_e164, '')
  into v_nome
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;

  return jsonb_build_object(
    'tag_id', case when v_row.enable_tag then v_row.tag_id else null end,
    'message', case when v_row.enable_message and v_row.message_template is not null
                    then replace(v_row.message_template, '{{nome}}', coalesce(v_nome, ''))
                    else null end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.search_my_conversation_messages(p_workspace_id uuid, p_conversation_id uuid, p_term text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_term text := nullif(btrim(coalesce(p_term, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_pattern text;
  v_rows jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if v_term is null or char_length(v_term) < 2 then
    raise exception 'Search term too short' using errcode = '22023';
  end if;
  if char_length(v_term) > 80 then
    raise exception 'Search term too long' using errcode = '22023';
  end if;

  v_pattern := '%' || replace(replace(replace(v_term, '!', '!!'), '%', '!%'), '_', '!_') || '%';

  select coalesce(jsonb_agg(to_jsonb(f) order by f.occurred_at desc), '[]'::jsonb)
  into v_rows
  from (
    select m.id,
           m.direction,
           m.actor_type,
           m.body_text,
           m.occurred_at,
           m.reply_to_message_id
    from public.messages m
    join public.conversations c
      on c.workspace_id = m.workspace_id and c.id = m.conversation_id
    where m.workspace_id = p_workspace_id
      and m.conversation_id = p_conversation_id
      and coalesce(m.body_text, '') ilike v_pattern escape '!'
    order by m.occurred_at desc
    limit v_limit
  ) f;

  return jsonb_build_object('term', v_term, 'messages', v_rows);
end;
$function$;

CREATE OR REPLACE FUNCTION public.search_my_workspace_messages(p_workspace_id uuid, p_term text, p_limit integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_term text := nullif(btrim(coalesce(p_term, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 60), 1), 100);
  v_pattern text;
  v_rows jsonb;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if v_term is null or char_length(v_term) < 2 then
    raise exception 'Search term too short' using errcode = '22023';
  end if;
  if char_length(v_term) > 80 then
    raise exception 'Search term too long' using errcode = '22023';
  end if;

  v_pattern := '%' || replace(replace(replace(v_term, '!', '!!'), '%', '!%'), '_', '!_') || '%';

  select coalesce(jsonb_agg(to_jsonb(f) order by f.occurred_at desc), '[]'::jsonb)
  into v_rows
  from (
    select m.id as message_id,
           m.conversation_id,
           m.direction,
           m.actor_type,
           m.body_text,
           m.occurred_at,
           ct.id as contact_id,
           ct.display_name as contact_name,
           ct.phone_e164 as contact_phone,
           c.stage as conversation_stage
    from public.messages m
    join public.conversations c
      on c.workspace_id = m.workspace_id and c.id = m.conversation_id
    join public.contacts ct
      on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
    where m.workspace_id = p_workspace_id
      and c.stage <> 'archived'
      and coalesce(m.body_text, '') ilike v_pattern escape '!'
    order by m.occurred_at desc
    limit v_limit
  ) f;

  return jsonb_build_object('term', v_term, 'hits', v_rows);
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_my_scheduled_message(p_workspace_id uuid, p_scheduled_id uuid, p_body_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := auth.uid();
  v_body text := btrim(coalesce(p_body_text, ''));
  v_row public.scheduled_messages%rowtype;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 4096 then
    raise exception 'Invalid message text' using errcode = '22023';
  end if;

  select * into v_row from public.scheduled_messages s
  where s.workspace_id = p_workspace_id and s.id = p_scheduled_id
  for update;
  if not found then raise exception 'Scheduled message not found' using errcode = 'P0002'; end if;
  if v_row.status <> 'pending' then
    raise exception 'scheduled_not_editable' using errcode = 'P0001';
  end if;

  update public.scheduled_messages
  set body_text = v_body
  where workspace_id = p_workspace_id and id = p_scheduled_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'body_text', v_row.body_text, 'scheduled_for', v_row.scheduled_for);
end;
$function$;

CREATE OR REPLACE FUNCTION public.count_my_unread_messages(p_workspace_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(sum(c.unread_count), 0)::integer
  from public.conversations c
  where c.workspace_id = p_workspace_id
    and c.unread_count > 0
    and c.is_muted = false
    and c.stage in ('new', 'ai', 'waiting_human', 'human', 'waiting_customer')
    and private.is_workspace_member(p_workspace_id);
$function$;

CREATE OR REPLACE FUNCTION public.bulk_update_my_conversations(p_workspace_id uuid, p_conversation_ids uuid[], p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  elsif p_action = 'mute' then
    update public.conversations set is_muted = true
    where workspace_id = p_workspace_id and id = any(v_ids);
    get diagnostics v_count = row_count;
  elsif p_action = 'unmute' then
    update public.conversations set is_muted = false
    where workspace_id = p_workspace_id and id = any(v_ids);
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
$function$;

CREATE OR REPLACE FUNCTION public.read_my_crm_inbox(p_workspace_id uuid, p_view text, p_instance_id uuid, p_search text, p_phones text[], p_limit integer, p_tag_id uuid DEFAULT NULL::uuid, p_deal_status text DEFAULT NULL::text, p_crm_stage text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
  v_reminders integer;
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
      when 'reminders' then 'c.follow_up_at is not null and c.follow_up_at <= now() and c.stage not in (''resolved'',''archived'')'
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
              c.assigned_label, c.assigned_user_id, c.is_muted,
              (select max(m.occurred_at) from public.messages m
                where m.workspace_id = c.workspace_id and m.conversation_id = c.id and m.direction = ''inbound'') as last_inbound_at,
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

  select count(*)::integer into v_reminders
  from public.conversations c
  where c.workspace_id = p_workspace_id
    and c.follow_up_at is not null and c.follow_up_at <= now()
    and c.stage not in ('resolved','archived')
    and (p_instance_id is null or c.instance_id = p_instance_id);

  return jsonb_build_object(
    'conversations', v_rows,
    'has_more', v_found > v_limit,
    'counts', jsonb_build_object('unread', v_unread, 'waiting', v_waiting),
    'archived_count', v_archived,
    'reminders_count', v_reminders
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.read_my_conversation(p_workspace_id uuid, p_conversation_id uuid, p_message_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_message_limit, 200), 1), 1000);
  v_conversation jsonb;
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
    'assigned_label', c.assigned_label,
    'assigned_user_id', c.assigned_user_id,
    'is_muted', c.is_muted,
    'last_inbound_at', (select max(m.occurred_at) from public.messages m
                        where m.workspace_id = c.workspace_id and m.conversation_id = c.id and m.direction = 'inbound'),
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
      'handoff_note', c.ai_handoff_note
    )
  )
  into v_conversation
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  join public.instances i on i.workspace_id = c.workspace_id and i.id = c.instance_id
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
  get diagnostics v_found = row_count;
  if v_found = 0 then
    return jsonb_build_object('conversation', null, 'messages', '[]'::jsonb, 'notes', '[]'::jsonb, 'scheduled', '[]'::jsonb, 'has_more', false);
  end if;

  return jsonb_build_object(
    'conversation', v_conversation,
    'messages', (
      select coalesce(jsonb_agg(to_jsonb(m) order by m.occurred_at, m.created_at, m.id), '[]'::jsonb)
      from (
        select msg.id, msg.direction, msg.actor_type, msg.status, msg.body_text,
               msg.occurred_at, msg.created_at, msg.sent_by is not null as from_panel,
               (msg.sent_by = auth.uid()) as mine,
               msg.reply_to_message_id,
               case when msg.reply_to_message_id is null then null else (
                 select jsonb_build_object('id', cit.id, 'body_text', cit.body_text,
                                           'direction', cit.direction, 'actor_type', cit.actor_type)
                 from public.messages cit
                 where cit.workspace_id = msg.workspace_id and cit.id = msg.reply_to_message_id
               ) end as reply_to,
               (select jsonb_build_object(
                  'kind', att.kind, 'content_type', att.content_type, 'byte_size', att.byte_size,
                  'file_name', att.file_name, 'duration_seconds', att.duration_seconds,
                  'width', att.width, 'height', att.height, 'object_key', att.object_key, 'status', att.storage_status)
                from public.message_attachments att
                where att.workspace_id = msg.workspace_id and att.message_id = msg.id
                order by att.created_at limit 1) as attachment
        from public.messages msg
        where msg.workspace_id = p_workspace_id and msg.conversation_id = p_conversation_id
        order by msg.occurred_at desc, msg.created_at desc, msg.id desc
        limit v_limit
      ) m
    ),
    'notes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', n.id, 'body_text', n.body_text, 'created_at', n.created_at,
        'author_name', n.author_name, 'mine', n.author_user_id = auth.uid()
      ) order by n.created_at desc), '[]'::jsonb)
      from public.conversation_notes n
      where n.workspace_id = p_workspace_id and n.conversation_id = p_conversation_id
    ),
    'scheduled', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'body_text', s.body_text, 'scheduled_for', s.scheduled_for,
        'status', s.status, 'error_detail', s.error_detail
      ) order by s.scheduled_for), '[]'::jsonb)
      from public.scheduled_messages s
      where s.workspace_id = p_workspace_id and s.conversation_id = p_conversation_id
        and s.status in ('pending','processing','failed')
    ),
    'has_more', (select count(*) > v_limit from public.messages msg
                 where msg.workspace_id = p_workspace_id and msg.conversation_id = p_conversation_id)
  );
end;
$function$;

-- A versão sem citação existia em paralelo no banco publicado e deixava o envio ambíguo pelo
-- PostgREST (PGRST203). Fica só a de baixo, que aceita a citação com valor padrão nulo.
drop function if exists public.start_my_text_message(uuid, uuid, text, text);

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
    or v_contact.external_user_id !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$' then
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

-- 5) Permissões: só quem está logado chama; visitante sem login, nunca.
revoke execute on function public.assign_my_conversation(uuid, uuid, uuid, text) from anon, public;
revoke execute on function public.read_my_workspace_people(uuid) from anon, public;
revoke execute on function public.read_my_stage_automations(uuid) from anon, public;
revoke execute on function public.save_my_stage_automation(uuid, text, boolean, uuid, boolean, text) from anon, public;
revoke execute on function public.plan_my_stage_automation(uuid, uuid, text) from anon, public;
revoke execute on function public.search_my_conversation_messages(uuid, uuid, text, integer) from anon, public;
revoke execute on function public.search_my_workspace_messages(uuid, text, integer) from anon, public;
revoke execute on function public.update_my_scheduled_message(uuid, uuid, text) from anon, public;
revoke execute on function public.count_my_unread_messages(uuid) from anon, public;
revoke execute on function public.bulk_update_my_conversations(uuid, uuid[], text, jsonb) from anon, public;
revoke execute on function public.read_my_crm_inbox(uuid, text, uuid, text, text[], integer, uuid, text, text) from anon, public;
revoke execute on function public.read_my_conversation(uuid, uuid, integer) from anon, public;
revoke execute on function public.start_my_text_message(uuid, uuid, text, text, uuid) from anon, public;

grant execute on function public.assign_my_conversation(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.read_my_workspace_people(uuid) to authenticated;
grant execute on function public.read_my_stage_automations(uuid) to authenticated;
grant execute on function public.save_my_stage_automation(uuid, text, boolean, uuid, boolean, text) to authenticated;
grant execute on function public.plan_my_stage_automation(uuid, uuid, text) to authenticated;
grant execute on function public.search_my_conversation_messages(uuid, uuid, text, integer) to authenticated;
grant execute on function public.search_my_workspace_messages(uuid, text, integer) to authenticated;
grant execute on function public.update_my_scheduled_message(uuid, uuid, text) to authenticated;
grant execute on function public.count_my_unread_messages(uuid) to authenticated;
grant execute on function public.bulk_update_my_conversations(uuid, uuid[], text, jsonb) to authenticated;
grant execute on function public.read_my_crm_inbox(uuid, text, uuid, text, text[], integer, uuid, text, text) to authenticated;
grant execute on function public.read_my_conversation(uuid, uuid, integer) to authenticated;
grant execute on function public.start_my_text_message(uuid, uuid, text, text, uuid) to authenticated;

commit;
