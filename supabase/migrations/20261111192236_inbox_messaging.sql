begin;

-- Fase 1 (Inbox): responder pelo painel, guardar o que sai pelo celular do chip e reabrir conversa.

-- Quem enviou pelo painel (para quando houver equipe). Fica vazio no que chega e no que sai pelo celular.
alter table public.messages
  add column sent_by uuid references auth.users(id) on delete set null;

-- Depois de uma mensagem nossa: atualiza a prévia, zera as não lidas e marca 'aguardando o cliente'.
create or replace function private.touch_conversation_after_outbound(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_body_text text,
  p_occurred_at timestamptz
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.conversations
  set last_message_preview = case when last_message_at is null or p_occurred_at >= last_message_at
                                  then left(p_body_text, 300) else last_message_preview end,
      last_message_at = greatest(coalesce(last_message_at, p_occurred_at), p_occurred_at),
      unread_count = 0,
      stage = case when stage in ('new','waiting_human','human') then 'waiting_customer' else stage end
  where workspace_id = p_workspace_id and id = p_conversation_id
$$;
revoke all on function private.touch_conversation_after_outbound(uuid,uuid,text,timestamptz) from public, anon, authenticated;

-- 1) Começar um envio. Qualquer participante ativo da empresa pode responder.
--    A mensagem nasce 'enviando'; o painel chama a Evolution e depois conta aqui o que aconteceu.
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
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', true);
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

-- 2) Contar como o envio terminou: 'sent' (saiu), 'failed' (não saiu) ou 'uncertain' (não deu para saber).
--    O incerto fica aguardando uma pessoa decidir; o sistema NUNCA reenvia sozinho.
--    A mesma função serve para a pessoa decidir depois: 'foi enviada' (sent) ou 'não foi' (failed).
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
  v_message public.messages%rowtype;
  v_previous_status text;
  v_new_status text;
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
  if p_provider_message_id is not null and char_length(p_provider_message_id) not between 1 and 200 then
    raise exception 'Invalid provider message id' using errcode = '22023';
  end if;

  select m.* into v_message
  from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id and m.direction = 'outbound'
  for update;
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;

  v_previous_status := v_message.status;
  -- Só mexe em mensagem que ainda está em aberto. Se o eco da Evolution já confirmou o envio, fica como está.
  if v_previous_status not in ('sending','awaiting_human_confirmation')
    or (v_previous_status = 'awaiting_human_confirmation' and p_outcome = 'uncertain') then
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', false);
  end if;

  v_new_status := case p_outcome when 'sent' then 'sent' when 'failed' then 'failed' else 'awaiting_human_confirmation' end;

  if p_outcome = 'sent' and p_provider_message_id is not null then
    -- Se o eco chegou antes e virou uma mensagem separada, fica só uma.
    delete from public.messages d
    where d.workspace_id = p_workspace_id and d.instance_id = v_message.instance_id
      and d.source_engine = 'evolution' and d.provider_message_id = p_provider_message_id
      and d.id <> v_message.id and d.direction = 'outbound';
  end if;

  update public.messages
  set status = v_new_status,
      provider_message_id = case when p_outcome = 'sent' then coalesce(p_provider_message_id, provider_message_id)
                                 else provider_message_id end
  where workspace_id = p_workspace_id and id = v_message.id
  returning * into v_message;

  if v_new_status = 'sent' then
    perform private.touch_conversation_after_outbound(p_workspace_id, v_message.conversation_id,
      v_message.body_text, v_message.occurred_at);
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

revoke all on function public.start_my_text_message(uuid,uuid,text,text) from public, anon;
revoke all on function public.finish_my_text_message(uuid,uuid,text,text) from public, anon;
grant execute on function public.start_my_text_message(uuid,uuid,text,text) to authenticated;
grant execute on function public.finish_my_text_message(uuid,uuid,text,text) to authenticated;

-- 3) Ações da conversa: ganha 'reopen' (reabrir uma conversa resolvida).
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
    update public.conversations set stage = 'resolved', automation_paused = true where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
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
    update public.conversations set unread_count = 0 where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_marked_read';
  else raise exception 'Unsupported conversation action' using errcode = '22023';
  end if;
  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,v_role,v_action_name,'conversation',p_conversation_id::text,jsonb_build_object('stage',v_row.stage,'automation_paused',v_row.automation_paused,'unread_count',v_row.unread_count));
  return jsonb_build_object('id',v_row.id,'stage',v_row.stage,'assigned_user_id',v_row.assigned_user_id,'assigned_label',v_row.assigned_label,'automation_paused',v_row.automation_paused,'unread_count',v_row.unread_count,'updated_at',v_row.updated_at);
end;
$$;

-- 4) Receber da Evolution. Muda em relação à versão anterior:
--    - mensagem enviada pelo próprio chip (pelo celular, ou o eco de um envio do painel) passa a ser guardada;
--    - quando o cliente responde uma conversa 'aguardando o cliente', ela volta para 'com você';
--    - o nome do contato só é preenchido com o nome que o próprio contato usa no WhatsApp.
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
  v_body text;
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
    values (v_workspace_id,v_contact_id,v_instance_id,case when p_from_me then 'waiting_customer' else 'new' end,
      p_occurred_at,left(v_body,300),0)
    returning id into v_conversation_id;
  end if;

  -- Já conhecemos esta mensagem? (o painel enviou e já anotou o identificador dela)
  perform 1 from public.messages m
  where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id
    and m.source_engine = 'evolution' and m.provider_message_id = p_event_id;
  if found then
    update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
    return jsonb_build_object('result','duplicate');
  end if;

  if p_from_me then
    -- Eco de um envio do painel que ainda não tem identificador: é a MESMA mensagem, não outra.
    -- Isso também confirma sozinho um envio que tinha ficado 'sem confirmação'.
    select m.id into v_message_id
    from public.messages m
    where m.workspace_id = v_workspace_id and m.conversation_id = v_conversation_id
      and m.direction = 'outbound' and m.source_engine = 'evolution' and m.provider_message_id is null
      and m.status in ('sending','awaiting_human_confirmation','sent')
      and m.body_text = v_body and m.created_at > now() - interval '15 minutes'
    order by m.created_at asc
    limit 1
    for update;
    if v_message_id is not null then
      update public.messages set status = 'sent', provider_message_id = p_event_id
      where workspace_id = v_workspace_id and id = v_message_id;
      v_adopted := true;
    else
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
