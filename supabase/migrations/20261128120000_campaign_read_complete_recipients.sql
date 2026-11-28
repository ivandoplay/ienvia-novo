-- Preserve todos os destinatários ao editar rascunhos; renderização paginada no cliente.
CREATE OR REPLACE FUNCTION public.read_my_campaign(p_workspace_id uuid, p_campaign_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    limit 5000
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
$function$
;
