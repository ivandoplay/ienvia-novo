-- Poda de avisos antigos: sem isso, webhook_events guarda tudo para sempre.
-- 45 linhas/dia hoje é barato; com dez chips em uso vira centenas de milhares por semana.
-- 14 dias é o suficiente para investigar "por que essa mensagem não entrou?".

create or replace function public.prune_webhook_events(p_dias integer default 14)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_apagados integer;
begin
  -- trava contra chamadas simultâneas (o cron pode rodar junto com um pedido manual)
  if not pg_try_advisory_xact_lock(hashtext('prune_webhook_events')) then
    return 0;
  end if;

  if p_dias is null or p_dias < 1 or p_dias > 365 then
    raise exception 'prazo de retenção inválido: % (use de 1 a 365 dias)', p_dias;
  end if;

  delete from public.webhook_events
  where received_at < clock_timestamp() - make_interval(days => p_dias);

  get diagnostics v_apagados = row_count;
  return v_apagados;
end;
$$;

comment on function public.prune_webhook_events(integer) is
  'Apaga avisos de webhook mais antigos que p_dias (padrão 14). Chamada pelo /api/cron/retencao.';

-- Só o serviço (chave de servidor) deve chamar; nada de sessão de usuário.
revoke all on function public.prune_webhook_events(integer) from public;
revoke all on function public.prune_webhook_events(integer) from anon, authenticated;
grant execute on function public.prune_webhook_events(integer) to service_role;

-- Índice para a poda não varrer a tabela inteira quando ela crescer.
create index if not exists webhook_events_received_at_idx
  on public.webhook_events (received_at);
