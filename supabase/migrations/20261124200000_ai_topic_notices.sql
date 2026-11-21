-- Avisos sem pausa: idempotência por conversa/assunto pendente, sem enviar mensagens nesta migração.
create table private.ai_topic_notices (
  workspace_id uuid not null,
  conversation_id uuid not null,
  topic text not null check (topic in ('visita_a_caminho','simulacao_parcelamento')),
  turn_id uuid not null references public.ai_turns(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, conversation_id, topic),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id,id) on delete cascade
);
revoke all on private.ai_topic_notices from public, anon, authenticated;

create function public.claim_ai_topic_notice(p_workspace_id uuid,p_conversation_id uuid,p_turn_id uuid,p_topic text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if p_topic is null or p_topic not in ('visita_a_caminho','simulacao_parcelamento') then
    raise exception 'Invalid topic' using errcode='22023';
  end if;
  if not exists(select 1 from public.ai_turns t where t.id=p_turn_id and t.workspace_id=p_workspace_id
    and t.conversation_id=p_conversation_id and t.status='answered') then
    raise exception 'Invalid answered turn' using errcode='22023';
  end if;
  insert into private.ai_topic_notices(workspace_id,conversation_id,topic,turn_id)
  values(p_workspace_id,p_conversation_id,p_topic,p_turn_id) on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count=1;
end;
$$;
revoke all on function public.claim_ai_topic_notice(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_ai_topic_notice(uuid,uuid,uuid,text) to service_role;

-- Liberação manual encerra o ciclo pendente; não altera o estado da conversa.
create function private.clear_ai_topic_notices_on_resume() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (old.automation_paused and not new.automation_paused)
     or (old.ai_pause_reason is not null and new.ai_pause_reason is null)
     or (old.ai_paused_until is not null and new.ai_paused_until is null) then
    delete from private.ai_topic_notices where workspace_id=new.workspace_id and conversation_id=new.id;
  end if;
  return new;
end;
$$;
create trigger clear_ai_topic_notices_on_resume after update on public.conversations
for each row execute function private.clear_ai_topic_notices_on_resume();
revoke all on function private.clear_ai_topic_notices_on_resume() from public,anon,authenticated;
