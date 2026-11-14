-- Fase 8: o painel de Clientes SaaS vira mesa de administração de verdade.
--
-- O que entra aqui:
--   1. Cobrança: vencimento, valor, situação (em dia / tolerância / vencida) e carência.
--   2. Aviso automático ao cliente quando a conta é suspensa.
--   3. Números de uso por cliente (mensagens do mês, IA, contatos, último acesso).
--   4. Botão "Marcar como pago" e "Trocar a senha do cliente".
--   5. Zerar a conta com confirmação (para de responder, campanhas param, dados apagados).
--   6. Aviso de suspensão pendente: quem está sem acesso recebe a mensagem quando o chip voltar.
--
-- Regra de ouro: nada aqui apaga dado de cliente sem uma segunda confirmação escrita.

begin;

-- =============================================================================================
-- 1. Cobrança em private.workspace_admin_meta
-- =============================================================================================

alter table private.workspace_admin_meta
  add column if not exists due_day integer
    check (due_day is null or due_day between 1 and 31),
  add column if not exists monthly_amount_cents integer
    check (monthly_amount_cents is null or monthly_amount_cents between 0 and 100000000),
  add column if not exists grace_days integer not null default 3
    check (grace_days between 0 and 60),
  add column if not exists paid_until date,
  add column if not exists suspend_notice text not null default ''
    check (char_length(suspend_notice) <= 600),
  -- Para quem o aviso vai: o WhatsApp pessoal do responsável (só dígitos, com DDI).
  -- Vazio = o aviso sai para o próprio número do chip (a conversa "com você mesmo").
  add column if not exists owner_whatsapp text not null default ''
    check (owner_whatsapp = '' or owner_whatsapp ~ '^[0-9]{10,15}$');

-- Contas que já existem começam com a carência padrão de 3 dias (o combinado com o dono).
update private.workspace_admin_meta set grace_days = 3 where grace_days is null;

-- =============================================================================================
-- 2. Aviso de suspensão: fica na fila e sai pelo primeiro chip que voltar
-- =============================================================================================

create table if not exists public.suspension_notices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  instance_id uuid references public.instances(id) on delete set null,
  -- number_key do chip (o que a Evolution usa para enviar). Guardado como texto para não depender
  -- do formato do número na hora do bloqueio.
  number_key text not null,
  body_text text not null check (char_length(body_text) between 1 and 600),
  status text not null default 'pending'
    check (status in ('pending','sent','failed','cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 50),
  last_error text not null default '' check (char_length(last_error) <= 600),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists suspension_notices_pending_idx
  on public.suspension_notices (workspace_id, status, created_at)
  where status = 'pending';

alter table public.suspension_notices enable row level security;
revoke all on table public.suspension_notices from public, anon, authenticated;
grant all on table public.suspension_notices to service_role;

-- Aviso de quem foi bloqueado antes desta migração não existe: o texto nasce vazio.
comment on table public.suspension_notices is
  'Mensagem de "conta suspensa" que o master escreveu ao bloquear um cliente. Sai pelo primeiro chip que reconectar.';

-- =============================================================================================
-- 3. Lista de clientes com cobrança e uso
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
      -- Cobrança
      'due_day', meta.due_day,
      'monthly_amount_cents', meta.monthly_amount_cents,
      'grace_days', coalesce(meta.grace_days, 3),
      'paid_until', meta.paid_until,
      'suspend_notice', coalesce(meta.suspend_notice, ''),
      'owner_whatsapp', coalesce(meta.owner_whatsapp, ''),
      -- Uso do mês corrente (fuso do Brasil, para "mês" bater com o calendário do cliente)
      'messages_month', (
        select count(*)::int from public.messages m
        where m.workspace_id = w.id
          and m.created_at >= date_trunc('month', now() at time zone 'America/Sao_Paulo')
      ),
      'ai_replies_month', (
        select count(*)::int from public.messages m
        where m.workspace_id = w.id
          and m.actor_type = 'ai'
          and m.direction = 'outbound'
          and m.created_at >= date_trunc('month', now() at time zone 'America/Sao_Paulo')
      ),
      'last_message_at', (
        select max(m.created_at) from public.messages m where m.workspace_id = w.id
      ),
      'last_support_at', (
        select max(ss.started_at)
        from public.support_sessions ss
        where ss.workspace_id = w.id
      ),
      'owner', (
        select jsonb_build_object(
          'user_id', own.user_id,
          'email', coalesce(own.email, ''),
          'display_name', coalesce(own.display_name, ''),
          'last_sign_in_at', own.last_sign_in_at
        )
        from (
          select m.user_id, u.email, u.last_sign_in_at, p.display_name
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
        select count(*)::int from public.contacts c where c.workspace_id = w.id
      ),
      'conversations_count', (
        select count(*)::int from public.conversations c where c.workspace_id = w.id
      ),
      'pending_notices', (
        select count(*)::int from public.suspension_notices n
        where n.workspace_id = w.id and n.status = 'pending'
      )
    ) order by w.created_at desc)
    from public.workspaces w
    left join private.workspace_admin_meta meta on meta.workspace_id = w.id
    where w.status in ('active', 'closed')
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_platform_workspaces() from public, anon;
grant execute on function public.list_platform_workspaces() to authenticated;

-- =============================================================================================
-- 4. Cobrança: salvar vencimento, valor, carência e o texto do aviso
-- =============================================================================================

create or replace function public.set_workspace_billing(
  p_workspace_id uuid,
  p_due_day integer,
  p_monthly_amount_cents integer,
  p_grace_days integer,
  p_paid_until date,
  p_suspend_notice text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_ws public.workspaces%rowtype;
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;

  if p_due_day is not null and p_due_day not between 1 and 31 then
    raise exception 'Invalid due day' using errcode = '22023';
  end if;
  if p_monthly_amount_cents is not null and p_monthly_amount_cents not between 0 and 100000000 then
    raise exception 'Invalid amount' using errcode = '22023';
  end if;
  if p_grace_days is null or p_grace_days not between 0 and 60 then
    raise exception 'Invalid grace days' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_suspend_notice, ''))) > 600 then
    raise exception 'Invalid notice' using errcode = '22023';
  end if;

  select w.* into v_ws from public.workspaces w where w.id = p_workspace_id;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  insert into private.workspace_admin_meta (
    workspace_id, due_day, monthly_amount_cents, grace_days, paid_until, suspend_notice
  )
  values (
    p_workspace_id, p_due_day, p_monthly_amount_cents, p_grace_days, p_paid_until,
    btrim(coalesce(p_suspend_notice, ''))
  )
  on conflict (workspace_id) do update set
    due_day = excluded.due_day,
    monthly_amount_cents = excluded.monthly_amount_cents,
    grace_days = excluded.grace_days,
    paid_until = excluded.paid_until,
    suspend_notice = excluded.suspend_notice,
    updated_at = now();

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id, v_actor, 'master', 'platform_workspace_billing_updated', 'workspace', p_workspace_id::text,
    jsonb_build_object(
      'due_day', p_due_day,
      'monthly_amount_cents', p_monthly_amount_cents,
      'grace_days', p_grace_days,
      'paid_until', p_paid_until
    )
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.set_workspace_billing(uuid, integer, integer, integer, date, text) from public, anon;
grant execute on function public.set_workspace_billing(uuid, integer, integer, integer, date, text) to authenticated;

-- =============================================================================================
-- 5. Marcar como pago: soma um mês a partir do vencimento atual (ou de hoje, se atrasado)
-- =============================================================================================

create or replace function public.mark_workspace_paid(
  p_workspace_id uuid,
  p_paid_until date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_ws public.workspaces%rowtype;
  v_base date;
  v_ate date;
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;

  select w.* into v_ws from public.workspaces w where w.id = p_workspace_id;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  if p_paid_until is not null then
    v_ate := p_paid_until;
  else
    -- Já tem mês pago no futuro? Soma em cima dele. Está atrasado? Conta de hoje.
    select greatest(coalesce(meta.paid_until, current_date), current_date)
      into v_base
      from private.workspace_admin_meta meta
      where meta.workspace_id = p_workspace_id;
    v_base := coalesce(v_base, current_date);
    v_ate := (v_base + interval '1 month')::date;
  end if;

  insert into private.workspace_admin_meta (workspace_id, paid_until)
  values (p_workspace_id, v_ate)
  on conflict (workspace_id) do update set paid_until = excluded.paid_until, updated_at = now();

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id, v_actor, 'master', 'platform_workspace_paid', 'workspace', p_workspace_id::text,
    jsonb_build_object('paid_until', v_ate)
  );

  return jsonb_build_object('ok', true, 'paid_until', v_ate);
end;
$$;

revoke all on function public.mark_workspace_paid(uuid, date) from public, anon;
grant execute on function public.mark_workspace_paid(uuid, date) to authenticated;

-- =============================================================================================
-- 6. Suspender com aviso: fecha a conta, para campanhas, desliga chips e enfileira o recado
-- =============================================================================================

create or replace function public.suspend_platform_workspace(
  p_workspace_id uuid,
  p_reason text,
  p_notice text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_motivo text := regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g');
  v_aviso text := btrim(coalesce(p_notice, ''));
  v_ws public.workspaces%rowtype;
  v_chips int := 0;
  v_avisos int := 0;
  v_destino text := '';
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;
  if char_length(v_motivo) < 3 or char_length(v_motivo) > 300 then
    raise exception 'Invalid reason' using errcode = '22023';
  end if;
  if char_length(v_aviso) > 600 then
    raise exception 'Invalid notice' using errcode = '22023';
  end if;

  select w.* into v_ws from public.workspaces w where w.id = p_workspace_id for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  update public.workspaces
  set status = 'closed',
      closed_at = coalesce(closed_at, now())
  where id = p_workspace_id
  returning * into v_ws;

  -- Envio ativo não continua para quem está suspenso.
  update public.campaigns set status = 'paused'
  where workspace_id = p_workspace_id and status = 'running';

  update public.instances set is_enabled = false
  where workspace_id = p_workspace_id and is_enabled is distinct from false;
  get diagnostics v_chips = row_count;

  -- O aviso sai pelo primeiro chip que reconectar. Sem aviso escrito, não há o que enfileirar.
  if char_length(v_aviso) > 0 then
    select coalesce(meta.owner_whatsapp, '') into v_destino
    from private.workspace_admin_meta meta
    where meta.workspace_id = p_workspace_id;

    insert into public.suspension_notices (workspace_id, instance_id, number_key, body_text)
    select
      p_workspace_id,
      i.id,
      -- Sem o WhatsApp do responsável, o aviso vai para o próprio número do chip.
      coalesce(nullif(v_destino, ''), nullif(i.logical_number_key, ''), ''),
      v_aviso
    from public.instances i
    where i.workspace_id = p_workspace_id
      and i.status <> 'revoked'
      and (coalesce(v_destino, '') <> '' or coalesce(i.logical_number_key, '') <> '')
    order by i.created_at asc
    limit 1;
    get diagnostics v_avisos = row_count;
  end if;

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id, v_actor, 'master', 'platform_workspace_suspended', 'workspace', p_workspace_id::text,
    jsonb_build_object(
      'reason', v_motivo,
      'chips_disabled', v_chips,
      'notice_queued', v_avisos > 0
    )
  );

  return jsonb_build_object(
    'ok', true,
    'status', v_ws.status,
    'closed_at', v_ws.closed_at,
    'chips_disabled', v_chips,
    'notice_queued', v_avisos > 0
  );
end;
$$;

revoke all on function public.suspend_platform_workspace(uuid, text, text) from public, anon;
grant execute on function public.suspend_platform_workspace(uuid, text, text) to authenticated;

-- =============================================================================================
-- 7. Reativar: volta o acesso e cancela avisos que ainda não saíram
-- =============================================================================================

create or replace function public.reactivate_platform_workspace(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_ws public.workspaces%rowtype;
  v_cancelados int := 0;
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;

  select w.* into v_ws from public.workspaces w where w.id = p_workspace_id for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  if v_ws.status = 'closed' and v_ws.deletion_started_at is not null then
    raise exception 'Workspace is being deleted' using errcode = '22023';
  end if;

  update public.workspaces set status = 'active', closed_at = null
  where id = p_workspace_id
  returning * into v_ws;

  -- Cliente reativado não recebe "sua conta foi suspensa" depois. Os chips seguem desligados:
  -- quem religa é o cliente, no painel dele (o WhatsApp exige novo QR).
  update public.suspension_notices set status = 'cancelled'
  where workspace_id = p_workspace_id and status = 'pending';
  get diagnostics v_cancelados = row_count;

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id, v_actor, 'master', 'platform_workspace_reactivated', 'workspace', p_workspace_id::text,
    jsonb_build_object('notices_cancelled', v_cancelados)
  );

  return jsonb_build_object('ok', true, 'status', v_ws.status, 'notices_cancelled', v_cancelados);
end;
$$;

revoke all on function public.reactivate_platform_workspace(uuid) from public, anon;
grant execute on function public.reactivate_platform_workspace(uuid) to authenticated;

-- =============================================================================================
-- 8. Zerar a conta: para tudo e apaga contatos, conversas, mensagens e campanhas do cliente.
--    O login, os chips (desligados) e o histórico da plataforma continuam.
-- =============================================================================================

create or replace function public.reset_platform_workspace(
  p_workspace_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_confirmacao text := btrim(coalesce(p_confirmation, ''));
  v_ws public.workspaces%rowtype;
  v_contatos int := 0;
  v_conversas int := 0;
  v_mensagens int := 0;
  v_campanhas int := 0;
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;

  select w.* into v_ws from public.workspaces w where w.id = p_workspace_id for update;
  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  -- A confirmação é o nome da conta digitado. Evita zerar o cliente errado.
  if lower(v_confirmacao) <> lower(v_ws.name) then
    raise exception 'Confirmation does not match workspace name' using errcode = '22023';
  end if;

  -- Ordem importa: mensagens dependem de conversas.
  delete from public.messages where workspace_id = p_workspace_id;
  get diagnostics v_mensagens = row_count;
  delete from public.conversations where workspace_id = p_workspace_id;
  get diagnostics v_conversas = row_count;
  delete from public.contacts where workspace_id = p_workspace_id;
  get diagnostics v_contatos = row_count;
  delete from public.campaigns where workspace_id = p_workspace_id;
  get diagnostics v_campanhas = row_count;

  update public.instances set is_enabled = false
  where workspace_id = p_workspace_id and is_enabled is distinct from false;

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id, v_actor, 'master', 'platform_workspace_reset', 'workspace', p_workspace_id::text,
    jsonb_build_object(
      'contacts_deleted', v_contatos,
      'conversations_deleted', v_conversas,
      'messages_deleted', v_mensagens,
      'campaigns_deleted', v_campanhas
    )
  );

  return jsonb_build_object(
    'ok', true,
    'contacts_deleted', v_contatos,
    'conversations_deleted', v_conversas,
    'messages_deleted', v_mensagens,
    'campaigns_deleted', v_campanhas
  );
end;
$$;

revoke all on function public.reset_platform_workspace(uuid, text) from public, anon;
grant execute on function public.reset_platform_workspace(uuid, text) to authenticated;

-- =============================================================================================
-- 9. Fila do aviso de suspensão (a rotina que responde no WhatsApp lê daqui)
-- =============================================================================================

create or replace function public.claim_suspension_notices(p_limit integer default 5)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limite int := greatest(1, least(coalesce(p_limit, 5), 50));
begin
  -- Só o servidor (service_role) mexe nisto; não é chamada de navegador.
  if auth.uid() is not null or coalesce(current_setting('role', true), '') <> 'service_role' then
    -- auth.uid() nulo já indica service_role; esta checagem é só uma trava extra.
    if coalesce(current_setting('role', true), '') <> 'service_role' then
      raise exception 'Service role required' using errcode = '42501';
    end if;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', n.id,
      'workspace_id', n.workspace_id,
      'instance_id', n.instance_id,
      'number_key', n.number_key,
      'body_text', n.body_text,
      'attempts', n.attempts
    ))
    from (
      select * from public.suspension_notices
      where status = 'pending' and attempts < 5
      order by created_at asc
      limit v_limite
      for update skip locked
    ) n
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.claim_suspension_notices(integer) from public, anon, authenticated;
grant execute on function public.claim_suspension_notices(integer) to service_role;

-- =============================================================================================
-- 11. Fechamento de cada aviso: enviado, falhou ou segue na fila
-- =============================================================================================

create or replace function public.finish_suspension_notice(
  p_id uuid,
  p_outcome text,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_erro text := left(btrim(coalesce(p_error, '')), 600);
begin
  if coalesce(current_setting('role', true), '') <> 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('sent', 'failed', 'uncertain', 'pending') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;

  if p_outcome = 'pending' then
    -- Ainda não deu: devolve para a fila e conta a tentativa (para não girar para sempre).
    update public.suspension_notices
    set attempts = attempts + 1,
        last_error = v_erro
    where id = p_id and status = 'pending';
    -- Depois de 5 tentativas sem sucesso, para de tentar e deixa registrado para o master ver.
    update public.suspension_notices
    set status = 'failed', last_error = case when last_error = '' then 'chip não conectou em 5 tentativas' else last_error end
    where id = p_id and status = 'pending' and attempts >= 5;
  elsif p_outcome in ('sent', 'failed') then
    update public.suspension_notices
    set status = p_outcome,
        sent_at = case when p_outcome = 'sent' then now() else sent_at end,
        last_error = v_erro
    where id = p_id and status = 'pending';
  else
    -- "incerta": a exceção é do envio (pode ter saído). Fica como falha com o motivo, sem reenviar.
    update public.suspension_notices
    set status = 'failed', last_error = case when v_erro = '' then 'sem confirmação de envio' else v_erro end
    where id = p_id and status = 'pending';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.finish_suspension_notice(uuid, text, text) from public, anon, authenticated;
grant execute on function public.finish_suspension_notice(uuid, text, text) to service_role;

commit;


-- =============================================================================================
-- 10. Apoio às ações do painel: dono da conta, registro no histórico e ajuste de números
-- =============================================================================================

begin;

create or replace function public.owner_of_workspace(p_workspace_id uuid)
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

  return (
    select jsonb_build_object(
      'user_id', m.user_id,
      'email', u.email,
      'display_name', coalesce(p.display_name, '')
    )
    from public.workspace_memberships m
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.id = m.user_id
    where m.workspace_id = p_workspace_id and m.status = 'active' and m.role = 'owner'
    order by m.created_at asc
    limit 1
  );
end;
$$;

revoke all on function public.owner_of_workspace(uuid) from public, anon;
grant execute on function public.owner_of_workspace(uuid) to authenticated;

create or replace function public.log_platform_action(
  p_workspace_id uuid,
  p_action text,
  p_details jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_acao text := btrim(coalesce(p_action, ''));
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;
  if char_length(v_acao) < 3 or char_length(v_acao) > 80 then
    raise exception 'Invalid action' using errcode = '22023';
  end if;

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id, v_actor, 'master', v_acao, 'workspace', p_workspace_id::text,
    coalesce(p_details, '{}'::jsonb)
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.log_platform_action(uuid, text, jsonb) from public, anon;
grant execute on function public.log_platform_action(uuid, text, jsonb) to authenticated;

-- Para onde vai o aviso: WhatsApp do responsável (só dígitos, com DDI). Vazio volta a usar o chip.
create or replace function public.set_workspace_owner_whatsapp(p_workspace_id uuid, p_whatsapp text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_numero text := regexp_replace(coalesce(p_whatsapp, ''), '[^0-9]', '', 'g');
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;
  if v_numero <> '' and (char_length(v_numero) < 10 or char_length(v_numero) > 15) then
    raise exception 'Invalid whatsapp number' using errcode = '22023';
  end if;

  insert into private.workspace_admin_meta (workspace_id, owner_whatsapp)
  values (p_workspace_id, v_numero)
  on conflict (workspace_id) do update set owner_whatsapp = excluded.owner_whatsapp, updated_at = now();

  return jsonb_build_object('ok', true, 'whatsapp', v_numero);
end;
$$;

revoke all on function public.set_workspace_owner_whatsapp(uuid, text) from public, anon;
grant execute on function public.set_workspace_owner_whatsapp(uuid, text) to authenticated;

-- O texto do aviso também pode ser trocado depois (sem suspender de novo).
create or replace function public.set_workspace_notice(p_workspace_id uuid, p_notice text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_aviso text := btrim(coalesce(p_notice, ''));
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;
  if char_length(v_aviso) > 600 then
    raise exception 'Invalid notice' using errcode = '22023';
  end if;

  insert into private.workspace_admin_meta (workspace_id, suspend_notice)
  values (p_workspace_id, v_aviso)
  on conflict (workspace_id) do update set suspend_notice = excluded.suspend_notice, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.set_workspace_notice(uuid, text) from public, anon;
grant execute on function public.set_workspace_notice(uuid, text) to authenticated;

commit;
