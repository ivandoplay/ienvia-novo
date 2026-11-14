-- Motor local: parear o aparelho com e-mail e senha da conta (sem código).
--
-- Por que existe: o dono pode ligar o motor local de duas formas na página inicial do motor:
--   1) código de pareamento IENV-XXXX-XXXX (fluxo antigo, inalterado);
--   2) e-mail + senha da conta Ienvia (este fluxo, novo).
--
-- Decisões de segurança:
--   * Diferente de create_my_local_executor_pairing, esta função NÃO gera código, então pode ser
--     chamada por `anon` (a pessoa ainda não tem sessão — é exatamente o login dela). Por isso ela
--     exige uma segunda prova: o `device_token` aleatório de 32 bytes que o próprio motor gerou.
--   * O token é guardado só como SHA-256, igual aos outros tokens do motor.
--   * Nada de senha do WhatsApp: o cliente do WhatsApp aceita apenas QR ou código de 8 dígitos;
--     esta função só liga o aparelho ao workspace. Conectar chips continua sendo no painel.
--   * Rate limit por workspace para uma senha vazada não virar torneira de aparelhos.

create or replace function public.pair_local_executor_by_password(
  p_workspace_id uuid,
  p_display_name text,
  p_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(regexp_replace(coalesce(p_display_name, ''), '\s+', ' ', 'g'));
  v_executor public.local_executors%rowtype;
  v_ativos integer;
begin
  -- Precisa de sessão válida (o servidor do painel já validou e-mail + senha no Supabase Auth)
  -- e de papel de dono no workspace escolhido.
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;
  if p_token_sha256 is null or p_token_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid device token digest' using errcode = '22023';
  end if;
  -- O mesmo token não pode ser reaproveitado por outro aparelho.
  if exists (
    select 1 from private.local_executor_tokens t
    join public.local_executors e on e.id = t.executor_id
    where t.token_sha256 = p_token_sha256 and e.status <> 'revoked'
  ) then
    raise exception 'Device token already used' using errcode = '23505';
  end if;

  -- Teto: 20 aparelhos ativos por workspace em 24h evita abuso de credencial vazada.
  select count(*) into v_ativos
  from public.local_executors e
  where e.workspace_id = p_workspace_id
    and e.status in ('pending_pair', 'active')
    and e.created_at > clock_timestamp() - interval '24 hours';
  if v_ativos >= 20 then
    raise exception 'Too many local executors created today' using errcode = '53400';
  end if;

  insert into public.local_executors(workspace_id, owner_user_id, display_name, status, paired_at, last_seen_at)
  values (p_workspace_id, v_actor, v_name, 'active', clock_timestamp(), clock_timestamp())
  returning * into v_executor;

  insert into private.local_executor_tokens(executor_id, workspace_id, token_sha256)
  values (v_executor.id, p_workspace_id, p_token_sha256);

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, 'owner', 'local_executor_paired_by_password', 'local_executor', v_executor.id::text,
    jsonb_build_object('display_name', v_name, 'method', 'password'));

  return jsonb_build_object(
    'result', 'paired',
    'executor_id', v_executor.id,
    'workspace_id', v_executor.workspace_id,
    'display_name', v_executor.display_name,
    'status', v_executor.status
  );
end;
$$;

-- A rota do painel chama esta função com o token DO USUÁRIO (Authorization: Bearer <access_token>),
-- nunca com a chave de serviço: com service_role o auth.uid() é nulo e a checagem de dono recusaria.
revoke all on function public.pair_local_executor_by_password(uuid, text, text) from public, anon;
grant execute on function public.pair_local_executor_by_password(uuid, text, text) to authenticated;

-- Consulta de workspaces para a tela inicial do motor: devolve só id e nome das contas em que a
-- pessoa é dona. Evita o motor precisar de service_role ou abrir a tabela workspaces.
create or replace function public.list_my_owner_workspaces()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name) order by w.name), '[]'::jsonb)
  from public.workspaces w
  join public.workspace_memberships m on m.workspace_id = w.id
  where m.user_id = auth.uid()
    and m.status = 'active'
    and m.role = 'owner'
    and w.status = 'active';
$$;

revoke all on function public.list_my_owner_workspaces() from public;
grant execute on function public.list_my_owner_workspaces() to authenticated;
