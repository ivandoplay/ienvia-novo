begin;

-- Canal secreto de aviso ao vivo da Inbox (Supabase Realtime Broadcast).
-- O navegador nunca recebe o token de login (os cookies de sessão seguem httpOnly) nem conteúdo
-- de mensagens pelo Realtime: só escuta um tópico aleatório que recebe um toque vazio quando algo muda.

create table private.workspace_realtime_channels (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  channel_secret uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);

revoke all on private.workspace_realtime_channels from public, anon, authenticated;
grant all on private.workspace_realtime_channels to service_role;

insert into private.workspace_realtime_channels (workspace_id)
select w.id
from public.workspaces w
on conflict (workspace_id) do nothing;

create or replace function private.ensure_workspace_realtime_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.workspace_realtime_channels (workspace_id)
  values (new.id)
  on conflict (workspace_id) do nothing;
  return new;
end;
$$;

revoke all on function private.ensure_workspace_realtime_channel() from public, anon, authenticated;

create trigger workspaces_create_realtime_channel
  after insert on public.workspaces
  for each row
  execute function private.ensure_workspace_realtime_channel();

-- Devolve o nome do tópico ao vivo da empresa apenas para quem participa dela.
create or replace function public.read_my_inbox_channel(p_workspace_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select c.channel_secret into v_secret
  from private.workspace_realtime_channels c
  where c.workspace_id = p_workspace_id;

  if v_secret is null then
    insert into private.workspace_realtime_channels (workspace_id)
    values (p_workspace_id)
    on conflict (workspace_id) do nothing;

    select c.channel_secret into v_secret
    from private.workspace_realtime_channels c
    where c.workspace_id = p_workspace_id;
  end if;

  return case when v_secret is not null then 'inbox:' || v_secret::text else null end;
end;
$$;

revoke all on function public.read_my_inbox_channel(uuid) from public, anon;
grant execute on function public.read_my_inbox_channel(uuid) to authenticated;

-- Avisa quem está com a Inbox aberta sempre que conversas, chips ou o estado da IA mudarem.
-- Nos testes em memória (PGlite) o esquema realtime não existe: to_regprocedure devolve nulo.
create or replace function private.notify_inbox_realtime()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid := coalesce(new.workspace_id, old.workspace_id);
  v_secret uuid;
begin
  if v_workspace_id is null then
    return coalesce(new, old);
  end if;

  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    select c.channel_secret into v_secret
    from private.workspace_realtime_channels c
    where c.workspace_id = v_workspace_id;

    if v_secret is not null then
      begin
        perform realtime.send('{}'::jsonb, 'changed', 'inbox:' || v_secret::text, false);
      exception when others then
        null;
      end;
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function private.notify_inbox_realtime() from public, anon, authenticated;

create trigger conversations_notify_inbox_realtime
  after insert or update or delete on public.conversations
  for each row
  execute function private.notify_inbox_realtime();

create trigger instances_notify_inbox_realtime
  after insert or update or delete on public.instances
  for each row
  execute function private.notify_inbox_realtime();

create trigger workspace_ai_state_notify_inbox_realtime
  after insert or update or delete on public.workspace_ai_state
  for each row
  execute function private.notify_inbox_realtime();

commit;
