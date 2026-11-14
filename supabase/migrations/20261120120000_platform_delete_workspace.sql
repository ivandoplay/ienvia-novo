-- ============================================================================================
-- Exclusão de clientes pelo administrador da plataforma (área Contas SaaS).
--
-- Regra de ouro: nada é apagado de verdade no mesmo instante. A exclusão marca o cliente como
-- "closed", tira o acesso na hora (as funções do painel só aceitam workspace com status 'active')
-- e registra o pedido de exclusão. O dono da plataforma tem 30 dias para desfazer; depois disso a
-- limpeza definitiva roda fora do banco, junto com os arquivos do depósito.
-- ============================================================================================

create or replace function public.delete_platform_workspace(
  p_workspace_id uuid,
  p_motivo text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_ws public.workspaces%rowtype;
  v_contatos integer := 0;
  v_conversas integer := 0;
  v_chips integer := 0;
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;
  -- O motivo fica no histórico: sem ele, ninguém sabe depois por que o cliente saiu.
  if char_length(v_motivo) < 3 or char_length(v_motivo) > 500 then
    raise exception 'Invalid reason' using errcode = '22023';
  end if;

  select w.* into v_ws
  from public.workspaces w
  where w.id = p_workspace_id
  for update;

  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  -- Fechar duas vezes é inofensivo: só atualiza a data se ainda não houver pedido em aberto.
  update public.workspaces
  set status = 'closed',
      closed_at = coalesce(closed_at, now()),
      deletion_started_at = coalesce(deletion_started_at, now())
  where id = p_workspace_id
  returning * into v_ws;

  -- Campanhas em andamento param; envios ativos não continuam para um cliente que saiu.
  update public.campaigns
  set status = 'paused'
  where workspace_id = p_workspace_id and status = 'running';

  update public.instances
  set is_enabled = false
  where workspace_id = p_workspace_id and is_enabled is distinct from false;

  select count(*) into v_contatos from public.contacts where workspace_id = p_workspace_id;
  select count(*) into v_conversas from public.conversations where workspace_id = p_workspace_id;
  select count(*) into v_chips from public.instances where workspace_id = p_workspace_id;

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id,
    v_actor,
    'master',
    'platform_workspace_deleted',
    'workspace',
    p_workspace_id::text,
    jsonb_build_object(
      'name', v_ws.name,
      'status', v_ws.status,
      'reason', v_motivo,
      'contacts', v_contatos,
      'conversations', v_conversas,
      'instances', v_chips,
      'desfazivel_ate', (coalesce(v_ws.deletion_started_at, now()) + interval '30 days')
    )
  );

  return jsonb_build_object(
    'id', v_ws.id,
    'name', v_ws.name,
    'status', v_ws.status,
    'closed_at', v_ws.closed_at,
    'deletion_started_at', v_ws.deletion_started_at,
    'desfazivel_ate', (coalesce(v_ws.deletion_started_at, now()) + interval '30 days'),
    'contacts', v_contatos,
    'conversations', v_conversas,
    'instances', v_chips
  );
end;
$$;

revoke all on function public.delete_platform_workspace(uuid, text) from public, anon;
grant execute on function public.delete_platform_workspace(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Desfazer: devolve o cliente ao estado ativo enquanto o prazo não venceu.
-- ---------------------------------------------------------------------------------------------

create or replace function public.restore_platform_workspace(p_workspace_id uuid)
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

  select w.* into v_ws
  from public.workspaces w
  where w.id = p_workspace_id
  for update;

  if not found then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;

  if v_ws.status = 'active' and v_ws.deletion_started_at is null then
    return jsonb_build_object('id', v_ws.id, 'status', v_ws.status, 'restored', false);
  end if;

  if v_ws.deletion_started_at is not null and v_ws.deletion_started_at < now() - interval '30 days' then
    raise exception 'Deletion window expired' using errcode = '22023';
  end if;

  update public.workspaces
  set status = 'active',
      closed_at = null,
      deletion_started_at = null
  where id = p_workspace_id
  returning * into v_ws;

  insert into private.audit_events (workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (
    p_workspace_id,
    v_actor,
    'master',
    'platform_workspace_restored',
    'workspace',
    p_workspace_id::text,
    jsonb_build_object('name', v_ws.name, 'status', v_ws.status)
  );

  return jsonb_build_object('id', v_ws.id, 'name', v_ws.name, 'status', v_ws.status, 'restored', true);
end;
$$;

revoke all on function public.restore_platform_workspace(uuid) from public, anon;
grant execute on function public.restore_platform_workspace(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- O histórico de auditoria da plataforma passa a listar exclusão e restauração.
-- ---------------------------------------------------------------------------------------------

create or replace function public.list_platform_support_audit(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if v_actor is null or not private.is_platform_master() then
    raise exception 'Platform master required' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', row_data.id,
      'workspace_id', row_data.workspace_id,
      'workspace_name', row_data.workspace_name,
      'action', row_data.action,
      'actor_email', row_data.actor_email,
      'details', row_data.details,
      'created_at', row_data.created_at
    ) order by row_data.created_at desc, row_data.id desc)
    from (
      select
        e.id,
        e.workspace_id,
        coalesce(w.name, 'Plataforma') as workspace_name,
        e.action,
        coalesce(u.email, '') as actor_email,
        e.details,
        e.created_at
      from private.audit_events e
      left join public.workspaces w on w.id = e.workspace_id
      left join auth.users u on u.id = e.actor_user_id
      where e.actor_kind = 'master'
         or e.action in (
           'support_session_started','support_session_ended','platform_workspace_created',
           'platform_workspace_updated','platform_workspace_deleted','platform_workspace_restored'
         )
      order by e.created_at desc, e.id desc
      limit v_limit
    ) row_data
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_platform_support_audit(integer) from public, anon;
grant execute on function public.list_platform_support_audit(integer) to authenticated;
