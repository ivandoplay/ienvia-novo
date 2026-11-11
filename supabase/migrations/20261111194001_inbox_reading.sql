begin;

-- Fase 1 (Inbox), segunda parte: ler a Inbox numa ida só ao banco e deixar o envio à prova de corridas.

create index conversations_workspace_updated_idx on public.conversations(workspace_id, updated_at desc);
create index conversations_workspace_unread_idx on public.conversations(workspace_id, activity_at desc, id desc)
  where unread_count > 0;

-- 1) Lista de conversas da Inbox, com os contadores. Roda com as permissões de quem chama:
--    as regras de isolamento (RLS) continuam valendo linha a linha.
--    p_view: open (ativas), unread (não lidas), waiting (esperando você) ou resolved (resolvidas).
--    Com busca, a etapa deixa de filtrar: procura em todas as conversas, menos as arquivadas.
create or replace function public.read_my_inbox(
  p_workspace_id uuid,
  p_view text,
  p_instance_id uuid,
  p_search text,
  p_phones text[],
  p_limit integer
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
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  if v_search is not null then
    if char_length(v_search) > 80 then
      raise exception 'Search text too long' using errcode = '22023';
    end if;
    v_condition := 'c.stage <> ''archived''';
    -- O que a pessoa digitou é procurado ao pé da letra: % e _ não viram curingas.
    v_pattern := '%' || replace(replace(replace(v_search, '!', '!!'), '%', '!%'), '_', '!_') || '%';
    -- Trechos de telefone (só dígitos). O painel manda as variações com e sem o nono dígito.
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
    end;
    if v_condition is null then
      raise exception 'Unsupported inbox view' using errcode = '22023';
    end if;
  end if;

  -- A condição da etapa vem da lista fixa acima (nunca do que a pessoa digitou); o resto entra como parâmetro.
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(f) - ''rn'' order by f.rn) filter (where f.rn <= $1), ''[]''::jsonb), count(*)::integer
     from (
       select c.id, c.stage, c.unread_count, c.last_message_at, c.last_message_preview, c.activity_at,
              c.automation_paused, c.instance_id, i.display_name as instance_name,
              c.contact_id, ct.display_name as contact_name, ct.phone_e164 as contact_phone,
              row_number() over (order by c.activity_at desc, c.id desc) as rn
       from public.conversations c
       join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
       join public.instances i on i.workspace_id = c.workspace_id and i.id = c.instance_id
       where c.workspace_id = $2
         and ($3::uuid is null or c.instance_id = $3)
         and %s
         and ($4::text is null
              or ct.display_name ilike $4 escape ''!''
              or c.last_message_preview ilike $4 escape ''!''
              or exists (select 1 from unnest($5::text[]) as p(x) where position(p.x in ct.phone_e164) > 0))
       order by c.activity_at desc, c.id desc
       limit $1 + 1
     ) f', v_condition)
  into v_rows, v_found
  using v_limit, p_workspace_id, p_instance_id, v_pattern, v_phones;

  select count(*)::integer into v_unread
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.unread_count > 0
    and c.stage in ('new','ai','waiting_human','human','waiting_customer')
    and (p_instance_id is null or c.instance_id = p_instance_id);

  select count(*)::integer into v_waiting
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.stage in ('new','waiting_human','human')
    and (p_instance_id is null or c.instance_id = p_instance_id);

  return jsonb_build_object('conversations', v_rows, 'has_more', v_found > v_limit,
    'counts', jsonb_build_object('unread', v_unread, 'waiting', v_waiting));
end;
$$;

-- 2) Uma conversa aberta: os dados dela, do contato, do chip e as últimas mensagens (da mais antiga para a mais nova).
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
  v_found integer;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', c.id, 'stage', c.stage, 'unread_count', c.unread_count, 'automation_paused', c.automation_paused,
    'created_at', c.created_at, 'last_message_at', c.last_message_at,
    'contact', jsonb_build_object('id', ct.id, 'display_name', ct.display_name, 'phone_e164', ct.phone_e164,
      'erased', ct.erased_at is not null, 'created_at', ct.created_at),
    'instance', jsonb_build_object('id', i.id, 'display_name', i.display_name, 'status', i.status, 'engine', i.engine))
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
           (m.media_object_key is not null) as has_media,
           row_number() over (order by m.occurred_at desc, m.created_at desc, m.id desc) as rn
    from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = p_conversation_id
    order by m.occurred_at desc, m.created_at desc, m.id desc
    limit v_limit + 1
  ) t;

  return jsonb_build_object('conversation', v_conversation, 'messages', v_messages, 'has_more', v_found > v_limit);
end;
$$;

-- 3) Mudou alguma coisa? Um texto curto que muda quando qualquer conversa ou chip da empresa muda.
--    A tela pergunta isto de tempos em tempos e só recarrega quando o texto é outro.
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
        where c.workspace_id = p_workspace_id and c.unread_count > 0))
  else '' end
$$;

revoke all on function public.read_my_inbox(uuid,text,uuid,text,text[],integer) from public, anon;
revoke all on function public.read_my_conversation(uuid,uuid,integer) from public, anon;
revoke all on function public.read_my_inbox_version(uuid) from public, anon;
grant execute on function public.read_my_inbox(uuid,text,uuid,text,text[],integer) to authenticated;
grant execute on function public.read_my_conversation(uuid,uuid,integer) to authenticated;
grant execute on function public.read_my_inbox_version(uuid) to authenticated;

-- 4) Começar um envio: igual ao anterior; o pedido repetido agora devolve também o texto que já estava guardado.
create or replace function public.start_my_text_message(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_body_text text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_body text := btrim(coalesce(p_body_text, ''));
  v_conversation public.conversations%rowtype;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_message public.messages%rowtype;
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

  -- Trava a conversa: dois envios ao mesmo tempo entram em fila, um depois do outro.
  select c.* into v_conversation
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id
  for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;

  -- Pedido repetido (clique duplo, formulário reenviado): devolve o que já existe. Nunca cria a segunda mensagem.
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
  if not found or v_instance.engine <> 'evolution' or v_instance.status = 'revoked'
    or v_instance.provider_instance_name is null then
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

  insert into public.messages(workspace_id,conversation_id,instance_id,idempotency_key,direction,
    source_engine,actor_type,status,body_text,occurred_at,sent_by)
  values (p_workspace_id,p_conversation_id,v_instance.id,p_idempotency_key,'outbound',
    'evolution','human','sending',v_body,now(),v_actor)
  returning * into v_message;

  return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', false,
    'provider_instance_name', v_instance.provider_instance_name,
    'recipient', v_contact.external_user_id, 'body_text', v_body);
end;
$$;

-- 5) Contar como o envio terminou. Mudanças em relação à versão anterior:
--    - trava primeiro a conversa e só depois a mensagem (a mesma ordem usada ao receber os avisos da
--      Evolution; com ordens diferentes, os dois poderiam se travar um ao outro);
--    - se outra mensagem do painel ficou com o identificador desta por engano, devolve em vez de apagar;
--    - avisa as telas abertas também quando o envio falha ou fica sem confirmação.
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
  v_conversation_id uuid;
  v_message public.messages%rowtype;
  v_other public.messages%rowtype;
  v_previous_status text;
  v_new_status text;
  v_provider_id text := p_provider_message_id;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select m.role into v_role
  from public.workspace_memberships m
  where m.workspace_id = p_workspace_id and m.user_id = v_actor and m.status = 'active';
  if v_role is null then raise exception 'Workspace membership required' using errcode = '42501'; end if;
  if p_outcome is null or p_outcome not in ('sent','failed','uncertain') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;
  if v_provider_id is not null and char_length(v_provider_id) not between 1 and 200 then
    raise exception 'Invalid provider message id' using errcode = '22023';
  end if;

  select m.conversation_id into v_conversation_id
  from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id and m.direction = 'outbound';
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_conversation_id
  for update;

  select m.* into v_message
  from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id and m.direction = 'outbound'
  for update;
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  v_previous_status := v_message.status;

  -- O identificador que a Evolution devolveu já está em outra mensagem?
  if p_outcome = 'sent' and v_provider_id is not null
    and v_previous_status in ('sending','awaiting_human_confirmation','sent')
    and v_message.provider_message_id is distinct from v_provider_id then
    select m.* into v_other
    from public.messages m
    where m.workspace_id = p_workspace_id and m.instance_id = v_message.instance_id
      and m.source_engine = 'evolution' and m.provider_message_id = v_provider_id and m.id <> v_message.id
    for update;
    if found then
      if v_other.direction <> 'outbound' then
        -- Não deveria acontecer. Na dúvida, esta mensagem fica sem o identificador.
        v_provider_id := null;
      elsif v_other.idempotency_key is null then
        -- O eco chegou antes e foi guardado como mensagem do celular: é esta mesma mensagem. Fica só uma.
        delete from public.messages d where d.workspace_id = p_workspace_id and d.id = v_other.id;
      else
        -- Outra mensagem do painel, com o mesmo texto, ficou com o eco desta por engano. Devolve o
        -- identificador e ela volta a aguardar a própria confirmação.
        update public.messages
        set provider_message_id = null,
            status = case when status = 'sent' then 'awaiting_human_confirmation' else status end
        where workspace_id = p_workspace_id and id = v_other.id;
      end if;
    end if;
  end if;

  if v_previous_status = 'sent' then
    -- Já confirmada (pelo eco ou por uma pessoa): só completa ou corrige o identificador do WhatsApp.
    if p_outcome = 'sent' and v_provider_id is not null and v_message.provider_message_id is distinct from v_provider_id then
      update public.messages set provider_message_id = v_provider_id
      where workspace_id = p_workspace_id and id = v_message.id;
    end if;
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', false);
  end if;
  -- Só mexe em mensagem que ainda está em aberto.
  if v_previous_status not in ('sending','awaiting_human_confirmation')
    or (v_previous_status = 'awaiting_human_confirmation' and p_outcome = 'uncertain') then
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', false);
  end if;

  v_new_status := case p_outcome when 'sent' then 'sent' when 'failed' then 'failed' else 'awaiting_human_confirmation' end;

  update public.messages
  set status = v_new_status,
      provider_message_id = case when p_outcome = 'sent' then coalesce(v_provider_id, provider_message_id)
                                 else provider_message_id end
  where workspace_id = p_workspace_id and id = v_message.id
  returning * into v_message;

  if v_new_status = 'sent' then
    perform private.touch_conversation_after_outbound(p_workspace_id, v_conversation_id,
      v_message.body_text, v_message.occurred_at);
  else
    -- Nada muda na conversa; é só para as telas abertas perceberem que a mensagem mudou.
    update public.conversations set updated_at = now()
    where workspace_id = p_workspace_id and id = v_conversation_id;
  end if;

  -- Envio comum que deu certo não vai para a auditoria (seria uma linha por mensagem).
  if v_new_status <> 'sent' or v_previous_status = 'awaiting_human_confirmation' then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,v_actor,v_role,'message_send_' || p_outcome,'message',v_message.id::text,
      jsonb_build_object('from',v_previous_status,'to',v_new_status));
  end if;

  return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', true);
end;
$$;

-- 6) Ações da conversa. Mudanças: resolver zera as não lidas; marcar como lida deixa de ir para a
--    auditoria (acontece toda vez que alguém abre uma conversa) e não faz nada se já estava lida.
create or replace function public.transition_workspace_conversation(p_workspace_id uuid,p_conversation_id uuid,p_action text)
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
  select m.role into v_role from public.workspace_memberships m where m.workspace_id = p_workspace_id and m.user_id = v_actor and m.status = 'active';
  if v_role is null then raise exception 'Workspace membership required' using errcode = '42501'; end if;
  select c.* into v_row from public.conversations c where c.workspace_id = p_workspace_id and c.id = p_conversation_id for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  if p_action = 'claim' then
    if v_row.stage in ('resolved','archived') then raise exception 'Conversation is not active' using errcode = '22023'; end if;
    if v_row.assigned_user_id is not null and v_row.assigned_user_id <> v_actor then raise exception 'Conversation is assigned to another teammate' using errcode = '22023'; end if;
    update public.conversations set stage = 'human', automation_paused = true, assigned_user_id = v_actor, assigned_label = 'Atendente' where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_claimed';
  elsif p_action = 'resolve' then
    if v_row.stage = 'archived' then raise exception 'Archived conversation cannot be resolved again' using errcode = '22023'; end if;
    update public.conversations set stage = 'resolved', automation_paused = true, unread_count = 0 where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_resolved';
  elsif p_action = 'reopen' then
    if v_row.stage <> 'resolved' then raise exception 'Conversation is not resolved' using errcode = '22023'; end if;
    -- Se o contato já escreveu de novo, existe uma conversa mais nova aberta: não pode haver duas.
    perform 1 from public.conversations o
    where o.workspace_id = p_workspace_id and o.contact_id = v_row.contact_id and o.instance_id = v_row.instance_id
      and o.id <> v_row.id and o.stage not in ('resolved','archived');
    if found then raise exception 'another_open_conversation' using errcode = 'P0001'; end if;
    update public.conversations set stage = 'human' where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_reopened';
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

-- 7) Receber da Evolution. Mudanças em relação à versão anterior, todas sobre mensagens enviadas pelo próprio chip:
--    - se o painel já anotou o identificador da mensagem, o aviso para ali (antes de criar qualquer coisa);
--    - o eco de um envio do painel é procurado em todas as conversas do contato naquele chip, mesmo as
--      já resolvidas, começando pelo envio mais recente que ainda está em aberto;
--    - um envio em aberto pode ser confirmado pelo eco até 2 horas depois (o chip pode ter ficado sem sinal).
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
  v_candidate_id uuid;
  v_message_id uuid;
  v_phone text;
  v_display_name text;
  v_body text;
  v_created boolean := false;
  v_adopted boolean := false;
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

  -- p_sender_jid é sempre o OUTRO lado da conversa (o contato), venha a mensagem dele ou de nós.
  if p_event_type <> 'MESSAGES_UPSERT' or p_from_me is null
    or p_sender_jid is null or p_sender_jid !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$'
    or p_body_text is null or char_length(btrim(p_body_text)) not between 1 and 8000
    or p_occurred_at is null then
    update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
    return jsonb_build_object('result','ignored');
  end if;

  v_body := btrim(p_body_text);

  -- Mensagem nossa que o painel já anotou (ele enviou e guardou o identificador): nada a fazer.
  if p_from_me then
    perform 1 from public.messages m
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id
      and m.source_engine = 'evolution' and m.provider_message_id = p_event_id;
    if found then
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      return jsonb_build_object('result','duplicate');
    end if;
  end if;

  v_phone := '+' || split_part(p_sender_jid,'@',1);
  -- Em mensagem enviada pelo próprio chip, o nome que vem junto é o do dono do chip, não o do contato.
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

  -- Um aviso por vez para o mesmo contato.
  perform 1 from public.contacts where workspace_id = v_workspace_id and id = v_contact_id for update;

  if p_from_me then
    -- É o eco de um envio do painel que ainda não tem identificador? Vale o envio em aberto mais recente
    -- com o mesmo texto; depois, um já confirmado por uma pessoa há pouco.
    select m.id, m.conversation_id into v_candidate_id, v_conversation_id
    from public.messages m
    join public.conversations c on c.workspace_id = m.workspace_id and c.id = m.conversation_id
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id and c.contact_id = v_contact_id
      and m.direction = 'outbound' and m.source_engine = 'evolution'
      and m.provider_message_id is null and m.idempotency_key is not null
      and m.status in ('sending','awaiting_human_confirmation','sent')
      and m.body_text = v_body
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
        p_occurred_at,left(v_body,300),0)
      returning id into v_conversation_id;
      v_created := true;
    end if;
  end if;

  if p_from_me then
    -- Com a conversa travada, confere de novo: o painel pode ter terminado o envio neste meio-tempo.
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
      -- É a MESMA mensagem, não outra. Isso também confirma sozinho um envio que estava sem confirmação.
      update public.messages m
      set status = 'sent', provider_message_id = p_event_id
      where m.workspace_id = v_workspace_id and m.id = v_candidate_id
        and m.provider_message_id is null and m.status in ('sending','awaiting_human_confirmation','sent')
      returning m.id into v_message_id;
      v_adopted := v_message_id is not null;
    end if;
    if not v_adopted then
      -- Enviada direto pelo celular do chip.
      insert into public.messages(workspace_id,conversation_id,instance_id,provider_message_id,direction,source_engine,actor_type,status,body_text,occurred_at)
      values (v_workspace_id,v_conversation_id,v_instance_id,p_event_id,'outbound','evolution','human','sent',v_body,p_occurred_at)
      returning id into v_message_id;
    end if;
    perform private.touch_conversation_after_outbound(v_workspace_id, v_conversation_id, v_body, p_occurred_at);
  else
    insert into public.messages(workspace_id,conversation_id,instance_id,provider_message_id,direction,source_engine,actor_type,status,body_text,occurred_at)
    values (v_workspace_id,v_conversation_id,v_instance_id,p_event_id,'inbound','evolution','contact','received',v_body,p_occurred_at)
    returning id into v_message_id;

    update public.conversations
    set last_message_preview = case when last_message_at is null or p_occurred_at >= last_message_at
                                    then left(v_body,300) else last_message_preview end,
        last_message_at = greatest(coalesce(last_message_at,p_occurred_at),p_occurred_at),
        unread_count = unread_count + 1,
        stage = case when stage = 'waiting_customer' then 'human' else stage end
    where workspace_id = v_workspace_id and id = v_conversation_id;
  end if;

  update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;

  return jsonb_build_object('result','accepted','workspace_id',v_workspace_id,
    'instance_id',v_instance_id,'contact_id',v_contact_id,'conversation_id',v_conversation_id,
    'message_id',v_message_id,'direction',case when p_from_me then 'outbound' else 'inbound' end,'adopted',v_adopted);
end;
$$;

commit;
