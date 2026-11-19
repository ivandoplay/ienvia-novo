-- Editor assistido: conversa não altera dados; aprovação e desfazer são transações separadas.
create table public.training_ai_threads (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 agent_id uuid not null, title text not null check(char_length(title) between 1 and 100), created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(workspace_id,agent_id) references public.ai_agents(workspace_id,id) on delete cascade,
 unique(workspace_id,id)
);
create table public.training_ai_turns (
 id uuid primary key, workspace_id uuid not null, thread_id uuid not null,
 provider text not null check(provider in ('gemini','openrouter','nvidia')), user_text text not null check(char_length(user_text) between 1 and 6000),
 reply_text text not null default '' check(char_length(reply_text)<=12000),
 status text not null default 'generating' check(status in ('generating','proposed','discussed','applied','discarded','undone','failed')),
 context_snapshot jsonb not null default '{}', mutations jsonb not null default '[]', applied_snapshot jsonb,
 error_detail text, created_at timestamptz not null default now(), finished_at timestamptz,
 foreign key(workspace_id,thread_id) references public.training_ai_threads(workspace_id,id) on delete cascade
);
create index training_ai_threads_list on public.training_ai_threads(workspace_id,agent_id,updated_at desc);
create index training_ai_turns_list on public.training_ai_turns(workspace_id,thread_id,created_at,id);
alter table public.training_ai_threads enable row level security;
alter table public.training_ai_turns enable row level security;
revoke all on public.training_ai_threads,public.training_ai_turns from public,anon,authenticated;

create function private.training_ai_fields(p_resource text) returns text[] language sql immutable set search_path='' as $$
 select case p_resource
 when 'treinamento' then array['label','business_name','niche','assistant_name','tone','solo_identity','company_summary','commercial_terms','golden_rules','extra_instructions','escalation_rules','lock_until_manual_resume','prompt_shield_enabled','robot_question_policy','approved_messages','operational_skills','humanization_skills','objections','brain_pack','faqs']
 when 'catalogo' then array['name','category','price','description','payment_link','active']
 when 'audio' then array['when_to_use','linked_message_code','ai_enabled'] else array[]::text[] end
$$;
create function private.training_ai_target(p_workspace uuid,p_agent uuid,p_resource text,p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r jsonb; d jsonb;
begin
 if p_resource='treinamento' and p_id=p_agent then
  r:=private.ai_agent_json(p_workspace,p_agent,false);
 elsif p_resource='catalogo' then
  select to_jsonb(c) into r from public.catalog_items c where c.workspace_id=p_workspace and c.id=p_id;
 elsif p_resource='audio' then
  select to_jsonb(v) into r from public.voice_library_items v where v.workspace_id=p_workspace and v.id=p_id;
 end if;
 if r is null then raise exception 'editor_target_not_found' using errcode='22023';end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into d from jsonb_each(r) where key=any(private.training_ai_fields(p_resource));
 return jsonb_build_object('resource',p_resource,'id',p_id,'label',coalesce(r->>'label',r->>'name'),'data',d,'version',coalesce(r->'revision',r->'updated_at'));
end $$;
create function private.training_ai_context(p_workspace uuid,p_agent uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r jsonb;
begin
 r:=jsonb_build_object('agent',private.training_ai_target(p_workspace,p_agent,'treinamento',p_agent),'catalog',coalesce((select jsonb_agg(private.training_ai_target(p_workspace,p_agent,'catalogo',c.id) order by c.id) from public.catalog_items c where c.workspace_id=p_workspace),'[]'::jsonb),'voices',coalesce((select jsonb_agg(private.training_ai_target(p_workspace,p_agent,'audio',v.id)||jsonb_build_object('name',v.name,'transcription',v.transcription) order by v.id) from public.voice_library_items v where v.workspace_id=p_workspace),'[]'::jsonb));
 if octet_length(r::text)>500000 then raise exception 'editor_context_too_large' using errcode='22023';end if;
 return r;
end $$;

create function public.read_my_training_ai_chat(p_workspace_id uuid,p_agent_id uuid,p_thread_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 if not exists(select 1 from public.ai_agents where workspace_id=p_workspace_id and id=p_agent_id) then raise exception 'editor_target_not_found' using errcode='22023';end if;
 if p_thread_id is not null and not exists(select 1 from public.training_ai_threads where workspace_id=p_workspace_id and agent_id=p_agent_id and id=p_thread_id) then raise exception 'editor_thread_not_found' using errcode='22023';end if;
 select jsonb_build_object('threads',coalesce((select jsonb_agg(x) from (select id,title,updated_at from public.training_ai_threads where workspace_id=p_workspace_id and agent_id=p_agent_id order by updated_at desc limit 30)x),'[]'::jsonb),'turns',coalesce((select jsonb_agg(x order by x.created_at,x.id) from (select id,thread_id,provider,user_text,reply_text,status,mutations,error_detail,created_at from public.training_ai_turns where workspace_id=p_workspace_id and thread_id=p_thread_id order by created_at desc,id desc limit 50)x),'[]'::jsonb)) into result;
 return result;
end $$;

create function public.begin_my_training_ai_turn(p_workspace_id uuid,p_agent_id uuid,p_thread_id uuid,p_request_id uuid,p_provider text,p_text text) returns jsonb language plpgsql security definer set search_path='' as $$
declare tid uuid; ctx jsonb;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 if p_provider not in ('gemini','openrouter','nvidia') or p_provider is null or p_request_id is null or p_text is null or char_length(btrim(p_text)) not between 1 and 6000 then raise exception 'editor_invalid_request' using errcode='22023';end if;
 -- Serializa novas conversas, orçamento e idempotência por empresa; sem ativar IA ou tocar no WhatsApp.
 perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':training-editor',0));
 if exists(select 1 from public.training_ai_turns where id=p_request_id) then raise exception 'editor_request_already_used' using errcode='22023';end if;
 if (select count(*) from public.training_ai_turns where workspace_id=p_workspace_id and created_at>now()-interval '1 minute')>=6 or (select count(*) from public.training_ai_turns where workspace_id=p_workspace_id and created_at>now()-interval '1 day')>=100 then raise exception 'editor_rate_limit' using errcode='55000';end if;
 ctx:=private.training_ai_context(p_workspace_id,p_agent_id);
 if p_thread_id is null then
  insert into public.training_ai_threads(workspace_id,agent_id,title,created_by) values(p_workspace_id,p_agent_id,left(btrim(p_text),80),auth.uid()) returning id into tid;
 else
  select id into tid from public.training_ai_threads where workspace_id=p_workspace_id and agent_id=p_agent_id and id=p_thread_id for update;
  if tid is null then raise exception 'editor_thread_not_found' using errcode='22023';end if;
 end if;
 update public.training_ai_turns set status='failed',error_detail='A geração anterior foi interrompida. Envie novamente.',finished_at=now() where workspace_id=p_workspace_id and thread_id=tid and status='generating' and created_at<now()-interval '2 minutes';
 if exists(select 1 from public.training_ai_turns where workspace_id=p_workspace_id and thread_id=tid and status='generating') then raise exception 'editor_busy' using errcode='55000';end if;
 insert into public.training_ai_turns(id,workspace_id,thread_id,provider,user_text,context_snapshot) values(p_request_id,p_workspace_id,tid,p_provider,btrim(p_text),ctx);
 update public.training_ai_threads set updated_at=clock_timestamp() where id=tid;
 return jsonb_build_object('thread_id',tid,'context',ctx,'history',coalesce((select jsonb_agg(x order by x.created_at,x.id) from (select id,user_text,reply_text,status,mutations,created_at from public.training_ai_turns where workspace_id=p_workspace_id and thread_id=tid and id<>p_request_id and status<>'generating' order by created_at desc,id desc limit 12)x),'[]'::jsonb));
end $$;

create function public.finish_my_training_ai_turn(p_workspace_id uuid,p_turn_id uuid,p_reply text,p_changes jsonb,p_error text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.training_ai_turns%rowtype; a uuid; ch jsonb; target jsonb; targets jsonb:='[]'; v_mutations jsonb:='[]'; seen text[]:='{}'; signature text;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 select * into t from public.training_ai_turns where workspace_id=p_workspace_id and id=p_turn_id for update;
 if not found or t.status<>'generating' then raise exception 'editor_turn_changed' using errcode='55000';end if;
 if p_error is not null then
  update public.training_ai_turns set status='failed',error_detail=left(p_error,500),finished_at=now(),context_snapshot='{}' where id=t.id;
  return jsonb_build_object('ok',true);
 end if;
 if p_reply is null or char_length(btrim(p_reply)) not between 1 and 12000 or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)>30 or octet_length(p_changes::text)>300000 then raise exception 'editor_invalid_proposal' using errcode='22023';end if;
 select agent_id into a from public.training_ai_threads where id=t.thread_id;
 targets:=jsonb_build_array(t.context_snapshot->'agent')||(t.context_snapshot->'catalog')||(t.context_snapshot->'voices');
 for ch in select * from jsonb_array_elements(p_changes) loop
  if jsonb_typeof(ch) is distinct from 'object' or not ((ch->>'field')=any(private.training_ai_fields(ch->>'resource'))) or not(ch?'value') or ch->'value'='null'::jsonb then raise exception 'editor_forbidden_field' using errcode='22023';end if;
  select x into target from jsonb_array_elements(targets)x where x->>'resource'=ch->>'resource' and x->>'id'=ch->>'id';
  if target is null then raise exception 'editor_target_not_found' using errcode='22023';end if;
  signature:=(ch->>'resource')||':'||(ch->>'id')||':'||(ch->>'field');
  if signature=any(seen) then raise exception 'editor_duplicate_field' using errcode='22023';end if;
  seen:=array_append(seen,signature);
  if jsonb_typeof(target->'data'->(ch->>'field')) is distinct from jsonb_typeof(ch->'value') then raise exception 'editor_invalid_type' using errcode='22023';end if;
  if target->'data'->(ch->>'field') is distinct from ch->'value' then
   v_mutations:=v_mutations||jsonb_build_array(jsonb_build_object('resource',ch->>'resource','id',ch->>'id','label',target->>'label','field',ch->>'field','before',target->'data'->(ch->>'field'),'after',ch->'value'));
  end if;
 end loop;
 update public.training_ai_turns set reply_text=btrim(p_reply),mutations=v_mutations,status=case when jsonb_array_length(v_mutations)>0 then 'proposed' else 'discussed' end,finished_at=now() where id=t.id;
 return jsonb_build_object('ok',true);
end $$;

-- A lista de campos é explícita. SQL gerado pela IA nunca é executado.
create function private.training_ai_write(p_workspace uuid,p_agent uuid,p_resource text,p_id uuid,p_data jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from jsonb_object_keys(p_data) k where not(k=any(private.training_ai_fields(p_resource)))) then raise exception 'editor_forbidden_field' using errcode='22023';end if;
 if p_resource='treinamento' and p_id=p_agent then
  perform public.save_my_ai_agent(p_workspace,p_agent,p_data);
 elsif p_resource='catalogo' then
  update public.catalog_items c set name=coalesce(p_data->>'name',c.name),category=coalesce(p_data->>'category',c.category),price=coalesce(p_data->>'price',c.price),description=coalesce(p_data->>'description',c.description),payment_link=coalesce(p_data->>'payment_link',c.payment_link),active=coalesce((p_data->>'active')::boolean,c.active),updated_at=clock_timestamp() where c.workspace_id=p_workspace and c.id=p_id;
  if not found then raise exception 'editor_target_not_found';end if;
 elsif p_resource='audio' then
  if char_length(coalesce(p_data->>'when_to_use',''))>4000 or char_length(coalesce(p_data->>'linked_message_code',''))>500 then raise exception 'editor_invalid_voice_rule' using errcode='22023';end if;
  update public.voice_library_items v set when_to_use=coalesce(p_data->>'when_to_use',v.when_to_use),linked_message_code=coalesce(p_data->>'linked_message_code',v.linked_message_code),ai_enabled=coalesce((p_data->>'ai_enabled')::boolean,v.ai_enabled),updated_at=clock_timestamp() where v.workspace_id=p_workspace and v.id=p_id;
  if not found then raise exception 'editor_target_not_found';end if;
 else raise exception 'editor_forbidden_field' using errcode='22023';end if;
end $$;

create function public.transition_my_training_ai_proposal(p_workspace_id uuid,p_turn_id uuid,p_action text) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.training_ai_turns%rowtype; aid uuid; item record; expected jsonb; current_target jsonb; expected_targets jsonb; all_after jsonb:='[]'; patch jsonb; resource text; target_id uuid;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 if p_action is null or p_action not in ('apply','undo','discard') then raise exception 'editor_invalid_action' using errcode='22023';end if;
 -- Mesmo primeiro lock do editor manual e de save_my_ai_agent para evitar ordem inversa.
 perform 1 from public.workspaces where id=p_workspace_id and status='active' for update;
 if not found then raise exception 'Workspace not active' using errcode='42501';end if;
 select * into t from public.training_ai_turns where id=p_turn_id and workspace_id=p_workspace_id for update;
 if not found then raise exception 'editor_turn_not_found' using errcode='22023';end if;
 select agent_id into aid from public.training_ai_threads where id=t.thread_id and workspace_id=p_workspace_id;
 if p_action='discard' and t.status='proposed' then
  update public.training_ai_turns set status='discarded' where id=t.id;
  return jsonb_build_object('ok',true);
 end if;
 if (p_action='apply' and t.status<>'proposed') or (p_action='undo' and t.status<>'applied') or p_action='discard' then raise exception 'editor_turn_changed' using errcode='55000';end if;
 expected_targets:=case when p_action='undo' then t.applied_snapshot else jsonb_build_array(t.context_snapshot->'agent')||(t.context_snapshot->'catalog')||(t.context_snapshot->'voices') end;
 -- Trava os alvos em ordem estável e valida TODOS antes de qualquer escrita.
 for item in select distinct value->>'resource' as r,value->>'id' as i from jsonb_array_elements(t.mutations) order by r,i loop
  resource:=item.r;target_id:=item.i::uuid;
  if resource='treinamento' then perform 1 from public.ai_agents where workspace_id=p_workspace_id and id=target_id for update;
  elsif resource='catalogo' then perform 1 from public.catalog_items where workspace_id=p_workspace_id and id=target_id for update;
  elsif resource='audio' then perform 1 from public.voice_library_items where workspace_id=p_workspace_id and id=target_id for update;end if;
  current_target:=private.training_ai_target(p_workspace_id,aid,resource,target_id);
  select x into expected from jsonb_array_elements(expected_targets)x where x->>'resource'=resource and x->>'id'=target_id::text;
  if expected is null or current_target->'version' is distinct from expected->'version' or current_target->'data' is distinct from expected->'data' then raise exception 'editor_conflict' using errcode='55000';end if;
 end loop;
 for item in select distinct value->>'resource' as r,value->>'id' as i from jsonb_array_elements(t.mutations) order by r,i loop
  resource:=item.r;target_id:=item.i::uuid;
  select jsonb_object_agg(x->>'field',case when p_action='undo' then x->'before' else x->'after' end) into patch from jsonb_array_elements(t.mutations)x where x->>'resource'=resource and x->>'id'=target_id::text;
  perform private.training_ai_write(p_workspace_id,aid,resource,target_id,patch);
  all_after:=all_after||jsonb_build_array(private.training_ai_target(p_workspace_id,aid,resource,target_id));
 end loop;
 update public.training_ai_turns set status=case when p_action='undo' then 'undone' else 'applied' end,applied_snapshot=case when p_action='apply' then all_after else applied_snapshot end where id=t.id;
 insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details) values(p_workspace_id,auth.uid(),'owner','training_ai_'||p_action,'ai_agent',aid::text,jsonb_build_object('turn_id',t.id,'changed_fields',jsonb_array_length(t.mutations)));
 return jsonb_build_object('ok',true);
end $$;

revoke all on function private.training_ai_fields(text),private.training_ai_target(uuid,uuid,text,uuid),private.training_ai_context(uuid,uuid),private.training_ai_write(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.read_my_training_ai_chat(uuid,uuid,uuid),public.begin_my_training_ai_turn(uuid,uuid,uuid,uuid,text,text),public.finish_my_training_ai_turn(uuid,uuid,text,jsonb,text),public.transition_my_training_ai_proposal(uuid,uuid,text) from public,anon;
grant execute on function public.read_my_training_ai_chat(uuid,uuid,uuid),public.begin_my_training_ai_turn(uuid,uuid,uuid,uuid,text,text),public.finish_my_training_ai_turn(uuid,uuid,text,jsonb,text),public.transition_my_training_ai_proposal(uuid,uuid,text) to authenticated;

create function public.read_my_training_ai_proposal_agent(p_workspace_id uuid,p_turn_id uuid) returns uuid language plpgsql stable security definer set search_path='' as $$
declare aid uuid;
begin
 if auth.uid() is null or not private.is_workspace_owner(p_workspace_id) then raise exception 'Workspace owner required' using errcode='42501';end if;
 select th.agent_id into aid from public.training_ai_threads th join public.training_ai_turns t on t.thread_id=th.id and t.workspace_id=th.workspace_id where t.workspace_id=p_workspace_id and t.id=p_turn_id;
 return aid;
end $$;
revoke all on function public.read_my_training_ai_proposal_agent(uuid,uuid) from public,anon;
grant execute on function public.read_my_training_ai_proposal_agent(uuid,uuid) to authenticated;
