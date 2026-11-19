-- Mantém duas conversas completas por base; não modifica treinamento, catálogo ou áudios.
-- O contador mínimo não guarda conteúdo e sobrevive à exclusão de conversas.
lock table public.training_ai_threads,public.training_ai_turns in share row exclusive mode;
create table private.training_ai_requests (
 id uuid primary key,
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 created_at timestamptz not null default now()
);
alter table private.training_ai_requests enable row level security;
revoke all on private.training_ai_requests from public,anon,authenticated;
create index training_ai_requests_budget on private.training_ai_requests(workspace_id,created_at);
insert into private.training_ai_requests(id,workspace_id,created_at)
 select id,workspace_id,created_at from public.training_ai_turns on conflict do nothing;

-- Cobre também inserções já iniciadas pela versão anterior durante a atualização.
create function private.track_training_ai_request() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into private.training_ai_requests(id,workspace_id,created_at)
 values(new.id,new.workspace_id,new.created_at) on conflict do nothing;
 return new;
end $$;
revoke all on function private.track_training_ai_request() from public,anon,authenticated;
create trigger training_ai_request_ledger after insert on public.training_ai_turns
 for each row execute function private.track_training_ai_request();


create function private.trim_training_ai_threads(p_workspace uuid,p_agent uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 -- Mesmo lock do início de geração: duas abas não podem criar a terceira conversa juntas.
 perform pg_advisory_xact_lock(hashtextextended(p_workspace::text||':training-editor',0));
 -- Não apaga o contexto de uma chamada ainda em andamento. O cliente pode tentar depois.
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
end $$;
revoke all on function private.trim_training_ai_threads(uuid,uuid) from public,anon,authenticated;

create or replace function public.begin_my_training_ai_turn(p_workspace_id uuid,p_agent_id uuid,p_thread_id uuid,p_request_id uuid,p_provider text,p_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare tid uuid; ctx jsonb;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 if p_provider not in ('gemini','openrouter','nvidia') or p_provider is null or p_request_id is null or p_text is null or char_length(btrim(p_text)) not between 1 and 6000 then raise exception 'editor_invalid_request' using errcode='22023';end if;
 -- Serializa novas conversas, orçamento e idempotência por empresa; sem ativar IA ou tocar no WhatsApp.
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
end $$;

create or replace function public.read_my_training_ai_chat(p_workspace_id uuid,p_agent_id uuid,p_thread_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 if not exists(select 1 from public.ai_agents where workspace_id=p_workspace_id and id=p_agent_id) then raise exception 'editor_target_not_found' using errcode='22023';end if;
 perform private.trim_training_ai_threads(p_workspace_id,p_agent_id);
 select jsonb_build_object('thread_expired',p_thread_id is not null and not exists(select 1 from public.training_ai_threads where workspace_id=p_workspace_id and agent_id=p_agent_id and id=p_thread_id),'threads',coalesce((select jsonb_agg(x) from (select id,title,updated_at from public.training_ai_threads where workspace_id=p_workspace_id and agent_id=p_agent_id order by updated_at desc,created_at desc,id desc limit 2)x),'[]'::jsonb),'turns',coalesce((select jsonb_agg(x order by x.created_at,x.id) from (select id,thread_id,provider,user_text,reply_text,status,mutations,error_detail,created_at from public.training_ai_turns where workspace_id=p_workspace_id and thread_id=p_thread_id and thread_id in (select id from public.training_ai_threads where workspace_id=p_workspace_id and agent_id=p_agent_id) order by created_at desc,id desc limit 50)x),'[]'::jsonb)) into result;
 return result;
end $$;


notify pgrst,'reload schema';
