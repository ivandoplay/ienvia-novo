-- Observabilidade somente: preserva intervalos e decisões do executor.
alter table public.campaigns add column rhythm_wait_reason text, add column rhythm_delay_sec integer;

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
    set rhythm_wait_reason = case when v_rec.current_step + 1 < v_total_steps then 'block_interval' when v_next_batch = 0 then 'batch_rest' else 'contact_interval' end,
        rhythm_delay_sec = v_delay,
        next_action_at = clock_timestamp() + make_interval(secs => v_delay),
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
      'next_action_at', v_camp.next_action_at,
      'batch_sent_count', v_camp.batch_sent_count,
      'batch_target', v_camp.batch_target,
      'rhythm_wait_reason', v_camp.rhythm_wait_reason,
      'rhythm_delay_sec', v_camp.rhythm_delay_sec,
      'updated_at', v_camp.updated_at
    ),
    'stats', v_stats,
    'recipients', v_recipients,
    'attention_deliveries', v_deliveries
  );
end;
$function$
;
