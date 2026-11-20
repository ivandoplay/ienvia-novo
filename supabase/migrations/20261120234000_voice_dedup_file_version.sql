-- Anti-repetição por versão do arquivo, mantendo isolamento por workspace/conversa.
CREATE OR REPLACE FUNCTION public.claim_ai_turn(p_workspace_id uuid, p_turn_id uuid, p_trigger_message_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_sent_voices jsonb;
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

  select coalesce(jsonb_agg(distinct m.sent_voice_id::text), '[]'::jsonb) into v_sent_voices
  from public.messages m
  where m.workspace_id = p_workspace_id
    and m.conversation_id = v_turn.conversation_id
    and m.sent_voice_id is not null
    and m.status not in ('failed','cancelled')
    -- Uma substituição de arquivo cria nova versão, sem apagar o histórico anterior.
    and exists (
      select 1 from public.voice_library_items v
      where v.workspace_id = m.workspace_id and v.id = m.sent_voice_id
        and v.object_key = m.media_object_key
    );

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
    'resources', jsonb_build_object(
      'pix', private.pix_settings_json(p_workspace_id),
      'catalog', private.catalog_items_json(p_workspace_id, true),
      'voices', private.voice_library_json(p_workspace_id, true),
      'sent_voice_ids', v_sent_voices
    ),
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
$function$;
