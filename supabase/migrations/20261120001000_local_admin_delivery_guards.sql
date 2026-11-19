-- Proteção geral: isolamento de caminho e confirmação real de entrega, sem IDs de clientes.
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
  left join public.local_executors ex on ex.id = i.local_executor_id and ex.workspace_id=i.workspace_id
  where i.workspace_id = p_workspace_id
    and i.status = 'connected'
    -- Dossiês não trocam de chip silenciosamente. Desconexão pode usar outro caminho.
    and (p_preferred_instance_id is null or p_kind='chip_disconnected' or i.id=p_preferred_instance_id)
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


alter table private.admin_alert_deliveries add column if not exists delivered_at timestamptz;
alter table private.admin_alert_deliveries add column if not exists read_at timestamptz;

create or replace function public.apply_local_motor_receipts(p_token_sha256 text,p_instance_id uuid,p_receipts jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a record; c public.local_motor_commands%rowtype; r jsonb; s integer; ids jsonb:='[]'; pending integer:=0; alert_id uuid;
begin
 select * into a from private.auth_local_executor(p_token_sha256);
 if not found then return jsonb_build_object('result','unauthorized');end if;
 if not exists(select 1 from public.instances i where i.id=p_instance_id and i.workspace_id=a.workspace_id and i.local_executor_id=a.executor_id and i.engine='baileys' and i.status<>'revoked') then
  return jsonb_build_object('result','unauthorized');end if;
 if p_receipts is null or jsonb_typeof(p_receipts)<>'array' then raise exception 'Invalid receipts' using errcode='22023';end if;
 if jsonb_array_length(p_receipts)>100 then raise exception 'Invalid receipts' using errcode='22023';end if;
 for r in select value from jsonb_array_elements(p_receipts) loop
  if jsonb_typeof(r->'id') is distinct from 'string' or char_length(r->>'id') not between 1 and 200
    or jsonb_typeof(r->'status') is distinct from 'number' or (r->>'status') not in ('0','3','4','5') then
   raise exception 'Invalid receipt' using errcode='22023';end if;
  s:=(r->>'status')::integer;
  select * into c from public.local_motor_commands cmd where cmd.workspace_id=a.workspace_id and cmd.executor_id=a.executor_id
    and cmd.instance_id=p_instance_id and cmd.provider_message_id=r->>'id' and cmd.command_type in ('send_text','send_media')
    and cmd.status in ('succeeded','uncertain') order by cmd.created_at desc limit 1 for update;
  if not found then pending:=pending+1;continue;end if;
  if c.message_id is not null then
   update public.messages set status=case when s>=4 then 'read' when s=3 then 'delivered' else 'failed' end
    where id=c.message_id and workspace_id=a.workspace_id and instance_id=p_instance_id and direction='outbound'
      and (status in ('sending','sent','uncertain') or (s>=4 and status='delivered'));
  end if;
  if coalesce(c.payload->>'admin_alert_delivery_id','') ~ '^[a-fA-F0-9-]{36}$' then
   alert_id:=(c.payload->>'admin_alert_delivery_id')::uuid;
   update private.admin_alert_deliveries set
    delivered_at=case when s>=3 then coalesce(delivered_at,clock_timestamp()) else delivered_at end,
    read_at=case when s>=4 then coalesce(read_at,clock_timestamp()) else read_at end,
    status=case when s>=3 then 'sent' when delivered_at is null and read_at is null then 'failed' else status end
    where id=alert_id and workspace_id=a.workspace_id and instance_id=p_instance_id and provider_message_id=r->>'id';
  end if;
  ids:=ids||jsonb_build_array(r->>'id');
 end loop;
 return jsonb_build_object('result','ok','confirmed',ids,'pending',pending);
end $$;
revoke all on function public.apply_local_motor_receipts(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.apply_local_motor_receipts(text,uuid,jsonb) to service_role;
create index if not exists local_motor_commands_receipt_match_idx on public.local_motor_commands(workspace_id,executor_id,instance_id,provider_message_id) where provider_message_id is not null;
notify pgrst,'reload schema';
