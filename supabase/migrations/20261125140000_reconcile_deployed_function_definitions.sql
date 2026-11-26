-- Reconciliacao de definicoes ja implantadas, capturadas por pg_get_functiondef.
-- Preserva a restricao de teste existente e o transporte Evolution @lid.
-- Nao altera dados, credenciais, pausas ou grants. Nao reaplicar no remoto sem diff.
begin;

CREATE OR REPLACE FUNCTION private.ai_block_reason(p_workspace_id uuid, p_conversation_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_conversation public.conversations%rowtype;
  v_instance public.instances%rowtype;
  v_executor public.local_executors%rowtype;
  v_contact public.contacts%rowtype;
  v_sec jsonb;
  v_days integer[];
begin
  -- Escopo de teste autorizado: Motor Local original e conversa Evolution exata do contato 8438 no chip 303979.
  if p_workspace_id = '9cedadf2-ebf7-4ba9-8e5c-27a20c97ede6'::uuid
    and p_conversation_id is distinct from 'f59c8df3-8fc8-425c-9ab9-7b7e7ffa9558'::uuid
    and not exists (
      select 1 from public.conversations linux_chat
      join public.instances linux_instance on linux_instance.id=linux_chat.instance_id and linux_instance.workspace_id=linux_chat.workspace_id
      join public.contacts linux_contact on linux_contact.id=linux_chat.contact_id and linux_contact.workspace_id=linux_chat.workspace_id
      where linux_chat.workspace_id=p_workspace_id and linux_chat.id=p_conversation_id
        and linux_chat.id='cdcf34fb-bdf7-4ff1-9cd3-94f660d8b1ca'::uuid
        and linux_instance.id='d1726b6e-c09a-439d-860d-e43ae7086501'::uuid
        and linux_instance.engine='baileys'
        and linux_instance.local_executor_id='083598a2-d654-41d5-80c1-6ec19c4c1b5d'::uuid
        and private.phone_core(linux_instance.connected_phone)=private.phone_core('558681303979')
        and private.phone_core(linux_contact.phone_e164)=private.phone_core('558681638438')
    )
    and not exists (
      select 1 from public.conversations scoped
      join public.instances inst on inst.id=scoped.instance_id and inst.workspace_id=scoped.workspace_id
      join public.contacts ct on ct.id=scoped.contact_id and ct.workspace_id=scoped.workspace_id
      where scoped.id=p_conversation_id and scoped.workspace_id=p_workspace_id
        and scoped.id='1a22b087-19b9-4da4-91c0-7a0457073f87'::uuid
        and inst.id='1f06885b-7f2f-4982-a712-f7bcfd74c997'::uuid
        and inst.engine='evolution'
        and private.phone_core(inst.connected_phone)=private.phone_core('558681303979')
        and private.phone_core(ct.phone_e164)=private.phone_core('558681638438')
    ) then
    return 'test_scope_restricted';
  end if;
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
$function$;

CREATE OR REPLACE FUNCTION private.training_ai_target(p_workspace uuid, p_agent uuid, p_resource text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb; d jsonb;
begin
 if p_resource='treinamento' and p_id=p_agent then r:=private.ai_agent_json(p_workspace,p_agent,false);
 elsif p_resource='catalogo' then select to_jsonb(c) into r from public.catalog_items c where c.workspace_id=p_workspace and c.id=p_id;
 elsif p_resource='audio' then select to_jsonb(v) into r from public.voice_library_items v where v.workspace_id=p_workspace and v.id=p_id;
 end if;
 if r is null then raise exception 'editor_target_not_found' using errcode='22023';end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into d from jsonb_each(r) where key=any(private.training_ai_fields(p_resource));
 return jsonb_build_object('resource',p_resource,'id',p_id,'label',coalesce(r->>'label',r->>'name'),'data',d,'version',coalesce(r->'revision',r->'updated_at'));
end $function$;

CREATE OR REPLACE FUNCTION private.training_ai_write(p_workspace uuid, p_agent uuid, p_resource text, p_id uuid, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if exists(select 1 from jsonb_object_keys(p_data) k where not(k=any(private.training_ai_fields(p_resource)))) then raise exception 'editor_forbidden_field' using errcode='22023';end if;
 if p_resource='treinamento' and p_id=p_agent then perform public.save_my_ai_agent(p_workspace,p_agent,p_data);
 elsif p_resource='catalogo' then
  update public.catalog_items c set name=coalesce(p_data->>'name',c.name),category=coalesce(p_data->>'category',c.category),price=coalesce(p_data->>'price',c.price),description=coalesce(p_data->>'description',c.description),payment_link=coalesce(p_data->>'payment_link',c.payment_link),active=coalesce((p_data->>'active')::boolean,c.active),updated_at=clock_timestamp() where c.workspace_id=p_workspace and c.id=p_id;
  if not found then raise exception 'editor_target_not_found';end if;
 elsif p_resource='audio' then
  if char_length(coalesce(p_data->>'when_to_use',''))>4000 or char_length(coalesce(p_data->>'linked_message_code',''))>500 then raise exception 'editor_invalid_voice_rule' using errcode='22023';end if;
  update public.voice_library_items v set when_to_use=coalesce(p_data->>'when_to_use',v.when_to_use),linked_message_code=coalesce(p_data->>'linked_message_code',v.linked_message_code),ai_enabled=coalesce((p_data->>'ai_enabled')::boolean,v.ai_enabled),updated_at=clock_timestamp() where v.workspace_id=p_workspace and v.id=p_id;
  if not found then raise exception 'editor_target_not_found';end if;
 else raise exception 'editor_forbidden_field' using errcode='22023';end if;
end $function$;

CREATE OR REPLACE FUNCTION private.trim_training_ai_threads(p_workspace uuid, p_agent uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_workspace::text||':training-editor',0));
 if exists (
  select 1 from public.training_ai_turns t join (
   select id,row_number() over(order by updated_at desc,created_at desc,id desc) as pos
   from public.training_ai_threads where workspace_id=p_workspace and agent_id=p_agent
  ) ranked on ranked.id=t.thread_id
  where ranked.pos>2 and t.workspace_id=p_workspace and t.status='generating'
    and t.created_at>clock_timestamp()-interval '2 minutes'
 ) then raise exception 'editor_history_busy' using errcode='55000';end if;
 delete from public.training_ai_threads th using (
  select id,row_number() over(order by updated_at desc,created_at desc,id desc) as pos
  from public.training_ai_threads where workspace_id=p_workspace and agent_id=p_agent
 ) ranked where th.id=ranked.id and th.workspace_id=p_workspace and ranked.pos>2;
end $function$;

CREATE OR REPLACE FUNCTION public.apply_local_motor_receipts(p_token_sha256 text, p_instance_id uuid, p_receipts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a record; c public.local_motor_commands%rowtype; r jsonb; s integer; ids jsonb:='[]'; pending integer:=0; alert_id uuid;
begin
 select * into a from private.auth_local_executor(p_token_sha256);
 if not found then return jsonb_build_object('result','unauthorized');end if;
 if not exists(select 1 from public.instances i where i.id=p_instance_id and i.workspace_id=a.workspace_id and i.local_executor_id=a.executor_id and i.engine='baileys' and i.status<>'revoked') then return jsonb_build_object('result','unauthorized');end if;
 if p_receipts is null or jsonb_typeof(p_receipts)<>'array' then raise exception 'Invalid receipts' using errcode='22023';end if;
 if jsonb_array_length(p_receipts)>100 then raise exception 'Invalid receipts' using errcode='22023';end if;
 for r in select value from jsonb_array_elements(p_receipts) loop
  if jsonb_typeof(r->'id') is distinct from 'string' or char_length(r->>'id') not between 1 and 200 or jsonb_typeof(r->'status') is distinct from 'number' or (r->>'status') not in ('0','3','4','5') then raise exception 'Invalid receipt' using errcode='22023';end if;
  s:=(r->>'status')::integer;
  select * into c from public.local_motor_commands cmd where cmd.workspace_id=a.workspace_id and cmd.executor_id=a.executor_id and cmd.instance_id=p_instance_id and cmd.provider_message_id=r->>'id' and cmd.command_type in ('send_text','send_media') and cmd.status in ('succeeded','uncertain') order by cmd.created_at desc limit 1 for update;
  if not found then pending:=pending+1;continue;end if;
  if c.message_id is not null then
   update public.messages set status=case when s>=4 then 'read' when s=3 then 'delivered' else 'failed' end
   where id=c.message_id and workspace_id=a.workspace_id and instance_id=p_instance_id and direction='outbound' and (status in ('sending','sent','uncertain') or (s>=4 and status='delivered'));
  end if;
  if coalesce(c.payload->>'admin_alert_delivery_id','') ~ '^[a-fA-F0-9-]{36}$' then
   alert_id:=(c.payload->>'admin_alert_delivery_id')::uuid;
   update private.admin_alert_deliveries set delivered_at=case when s>=3 then coalesce(delivered_at,clock_timestamp()) else delivered_at end,read_at=case when s>=4 then coalesce(read_at,clock_timestamp()) else read_at end,status=case when s>=3 then 'sent' when delivered_at is null and read_at is null then 'failed' else status end
   where id=alert_id and workspace_id=a.workspace_id and instance_id=p_instance_id and provider_message_id=r->>'id';
  end if;
  ids:=ids||jsonb_build_array(r->>'id');
 end loop;
 return jsonb_build_object('result','ok','confirmed',ids,'pending',pending);
end $function$;

CREATE OR REPLACE FUNCTION public.begin_my_training_ai_turn(p_workspace_id uuid, p_agent_id uuid, p_thread_id uuid, p_request_id uuid, p_provider text, p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare tid uuid; ctx jsonb;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 if p_provider not in ('gemini','openrouter','nvidia') or p_provider is null or p_request_id is null or p_text is null or char_length(btrim(p_text)) not between 1 and 6000 then raise exception 'editor_invalid_request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':training-editor',0));
 if exists(select 1 from private.training_ai_requests where id=p_request_id) then raise exception 'editor_request_already_used' using errcode='22023';end if;
 if (select count(*) from private.training_ai_requests where workspace_id=p_workspace_id and created_at>now()-interval '1 minute')>=6 or (select count(*) from private.training_ai_requests where workspace_id=p_workspace_id and created_at>now()-interval '1 day')>=100 then raise exception 'editor_rate_limit' using errcode='55000';end if;
 ctx:=private.training_ai_context(p_workspace_id,p_agent_id);
 if p_thread_id is null then
  insert into public.training_ai_threads(workspace_id,agent_id,title,created_by) values(p_workspace_id,p_agent_id,left(btrim(p_text),80),auth.uid()) returning id into tid;
 else
  select id into tid from public.training_ai_threads where workspace_id=p_workspace_id and agent_id=p_agent_id and id=p_thread_id for update;
  if tid is null then raise exception 'editor_thread_not_found' using errcode='22023';end if;
 end if;
 update public.training_ai_turns set status='failed',error_detail='A geração anterior foi interrompida. Envie novamente.',finished_at=now() where workspace_id=p_workspace_id and thread_id=tid and status='generating' and created_at<now()-interval '2 minutes';
 if exists(select 1 from public.training_ai_turns where workspace_id=p_workspace_id and thread_id=tid and status='generating') then raise exception 'editor_busy' using errcode='55000';end if;
 insert into private.training_ai_requests(id,workspace_id) values(p_request_id,p_workspace_id);
 insert into public.training_ai_turns(id,workspace_id,thread_id,provider,user_text,context_snapshot) values(p_request_id,p_workspace_id,tid,p_provider,btrim(p_text),ctx);
 update public.training_ai_threads set updated_at=clock_timestamp() where id=tid;
 perform private.trim_training_ai_threads(p_workspace_id,p_agent_id);
 return jsonb_build_object('thread_id',tid,'context',ctx,'history',coalesce((select jsonb_agg(x order by x.created_at,x.id) from (select id,user_text,reply_text,status,mutations,created_at from public.training_ai_turns where workspace_id=p_workspace_id and thread_id=tid and id<>p_request_id and status<>'generating' order by created_at desc,id desc limit 12)x),'[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.enqueue_workspace_admin_alert(p_workspace_id uuid, p_kind text, p_body_text text, p_preferred_instance_id uuid DEFAULT NULL::uuid, p_turn_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_sec jsonb;v_wa text;v_events text[];v_inst public.instances%rowtype;v_del_id uuid;v_cmd_id uuid;
begin
 if p_kind not in ('handoff','silent_handoff','uncertain_send','error','safety','chip_disconnected','campaign_uncertain','test') then raise exception 'Invalid alert kind' using errcode='22023';end if;
 v_sec:=private.security_settings_json(p_workspace_id);
 if p_kind<>'test' and not coalesce((v_sec->>'admin_alert_enabled')::boolean,false) then return jsonb_build_object('result','disabled');end if;
 v_wa:=regexp_replace(coalesce(v_sec->>'admin_alert_whatsapp',''),'[^0-9]','','g');
 if v_wa !~ '^[0-9]{10,15}$' then return jsonb_build_object('result','no_whatsapp');end if;
 if p_kind<>'test' then
  select coalesce(array_agg(e #>> '{}'),array[]::text[]) into v_events from jsonb_array_elements(coalesce(v_sec->'admin_alert_events','[]'::jsonb))e;
  if not(p_kind=any(v_events)) then return jsonb_build_object('result','event_disabled');end if;
 end if;
 select i.* into v_inst from public.instances i left join public.local_executors ex on ex.id=i.local_executor_id and ex.workspace_id=i.workspace_id
 where i.workspace_id=p_workspace_id and i.status='connected'
 and (p_preferred_instance_id is null or p_kind='chip_disconnected' or i.id=p_preferred_instance_id)
 and ((i.engine='evolution' and i.provider_instance_name is not null) or (i.engine='baileys' and ex.id is not null and ex.status='active' and ex.last_seen_at>=clock_timestamp()-interval '2 minutes'))
 order by (i.id=p_preferred_instance_id) desc,i.created_at asc limit 1;
 if not found then return jsonb_build_object('result','no_connected_chip');end if;
 insert into private.admin_alert_deliveries(workspace_id,instance_id,conversation_id,turn_id,kind,recipient_core,recipient_whatsapp,body_prefix,status)
 values(p_workspace_id,v_inst.id,p_conversation_id,p_turn_id,p_kind,private.phone_core(v_wa),v_wa,left(btrim(coalesce(p_body_text,'')),120),'sending')
 on conflict(turn_id,kind) where turn_id is not null do nothing returning id into v_del_id;
 if v_del_id is null then return jsonb_build_object('result','duplicate');end if;
 if v_inst.engine='baileys' then
  insert into public.local_motor_commands(workspace_id,executor_id,instance_id,command_type,payload,message_id)
  values(p_workspace_id,v_inst.local_executor_id,v_inst.id,'send_text',jsonb_build_object('recipient',v_wa||'@s.whatsapp.net','body_text',left(btrim(coalesce(p_body_text,'')),4096),'admin_alert_delivery_id',v_del_id),null) returning id into v_cmd_id;
  return jsonb_build_object('result','queued_local','delivery_id',v_del_id,'command_id',v_cmd_id);
 end if;
 return jsonb_build_object('result','ready_evolution','delivery_id',v_del_id,'provider_instance_name',v_inst.provider_instance_name,'recipient_whatsapp',v_wa);
end $function$;

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

CREATE OR REPLACE FUNCTION public.transition_my_training_ai_proposal(p_workspace_id uuid, p_turn_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t public.training_ai_turns%rowtype; aid uuid; item record; expected jsonb; current_target jsonb; expected_targets jsonb; all_after jsonb:='[]'; patch jsonb; resource text; target_id uuid;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 if p_action is null or p_action not in ('apply','undo','discard') then raise exception 'editor_invalid_action' using errcode='22023';end if;
 perform 1 from public.workspaces where id=p_workspace_id and status='active' for update;
 if not found then raise exception 'Workspace not active' using errcode='42501';end if;
 select * into t from public.training_ai_turns where id=p_turn_id and workspace_id=p_workspace_id for update;
 if not found then raise exception 'editor_turn_not_found' using errcode='22023';end if;
 select agent_id into aid from public.training_ai_threads where id=t.thread_id and workspace_id=p_workspace_id;
 if p_action='discard' and t.status='proposed' then
  update public.training_ai_turns set status='discarded' where id=t.id;
  return jsonb_build_object('ok',true);
 end if;
 if (p_action='apply' and t.status<>'proposed') or (p_action='undo' and t.status<>'applied') or p_action='discard' then raise exception 'editor_turn_changed' using errcode='55000';end if;
 expected_targets:=case when p_action='undo' then t.applied_snapshot else jsonb_build_array(t.context_snapshot->'agent')||(t.context_snapshot->'catalog')||(t.context_snapshot->'voices') end;
 for item in select distinct value->>'resource' as r,value->>'id' as i from jsonb_array_elements(t.mutations) order by r,i loop
  resource:=item.r;target_id:=item.i::uuid;
  if resource='treinamento' then perform 1 from public.ai_agents where workspace_id=p_workspace_id and id=target_id for update;
  elsif resource='catalogo' then perform 1 from public.catalog_items where workspace_id=p_workspace_id and id=target_id for update;
  elsif resource='audio' then perform 1 from public.voice_library_items where workspace_id=p_workspace_id and id=target_id for update;end if;
  current_target:=private.training_ai_target(p_workspace_id,aid,resource,target_id);
  select x into expected from jsonb_array_elements(expected_targets)x where x->>'resource'=resource and x->>'id'=target_id::text;
  if expected is null or current_target->'version' is distinct from expected->'version' or current_target->'data' is distinct from expected->'data' then raise exception 'editor_conflict' using errcode='55000';end if;
 end loop;
 for item in select distinct value->>'resource' as r,value->>'id' as i from jsonb_array_elements(t.mutations) order by r,i loop
  resource:=item.r;target_id:=item.i::uuid;
  select jsonb_object_agg(x->>'field',case when p_action='undo' then x->'before' else x->'after' end) into patch from jsonb_array_elements(t.mutations)x where x->>'resource'=resource and x->>'id'=target_id::text;
  perform private.training_ai_write(p_workspace_id,aid,resource,target_id,patch);
  all_after:=all_after||jsonb_build_array(private.training_ai_target(p_workspace_id,aid,resource,target_id));
 end loop;
 update public.training_ai_turns set status=case when p_action='undo' then 'undone' else 'applied' end,applied_snapshot=case when p_action='apply' then all_after else applied_snapshot end where id=t.id;
 insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details) values(p_workspace_id,auth.uid(),'owner','training_ai_'||p_action,'ai_agent',aid::text,jsonb_build_object('turn_id',t.id,'changed_fields',jsonb_array_length(t.mutations)));
 return jsonb_build_object('ok',true);
end $function$;

commit;
