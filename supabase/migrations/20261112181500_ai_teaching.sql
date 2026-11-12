begin;

-- Fase 2 (Atendente de IA), terceira parte: ensinar a IA sem sair da conversa.
--
--   - Na Inbox, o dono transforma uma resposta (da IA ou de uma pessoa) numa pergunta frequente ou
--     numa regra do treinamento. É o item corrigir resposta em 1 clique do plano.
--   - Cada base de treinamento ganha um número de revisão. Quem grava pela tela do Treinamento diz
--     qual revisão tinha na mão; se a base mudou nesse meio-tempo (por exemplo, por uma correção
--     feita na Inbox), o banco recusa a gravação em vez de apagar a mudança mais nova.

-- 1) A revisão da base: sobe a cada gravação dos campos ou das perguntas frequentes.
alter table public.ai_agents
  add column revision integer not null default 1 check (revision >= 1);

-- 2) A base em JSON passa a levar a revisão.
create or replace function private.ai_agent_json(p_workspace_id uuid, p_agent_id uuid, p_include_content boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'label', a.label, 'is_default', a.is_default,
    'business_name', a.business_name, 'niche', a.niche, 'assistant_name', a.assistant_name,
    'tone', a.tone, 'solo_identity', a.solo_identity,
    'company_summary', a.company_summary, 'commercial_terms', a.commercial_terms,
    'golden_rules', a.golden_rules, 'extra_instructions', a.extra_instructions,
    'lock_until_manual_resume', a.lock_until_manual_resume,
    'prompt_shield_enabled', a.prompt_shield_enabled,
    'robot_question_policy', a.robot_question_policy,
    'updated_at', a.updated_at, 'revision', a.revision,
    'faqs', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'question', f.question, 'answer', f.answer, 'source', f.source)
                       order by f.position, f.id)
      from public.ai_agent_faqs f
      where f.workspace_id = a.workspace_id and f.agent_id = a.id), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'char_count', char_length(d.content),
                         'created_at', d.created_at)
                       || case when p_include_content then jsonb_build_object('content', d.content) else '{}'::jsonb end
                       order by d.created_at, d.id)
      from public.ai_agent_documents d
      where d.workspace_id = a.workspace_id and d.agent_id = a.id), '[]'::jsonb))
  from public.ai_agents a
  where a.workspace_id = p_workspace_id and a.id = p_agent_id
$$;

-- 3) Criar (p_agent_id vazio) ou alterar uma base (só o dono). Pode mandar só o que mudou.
--    Quando a lista de perguntas frequentes vem junto, ela substitui a lista inteira.
--    Novo: 'expected_revision' (opcional) é a revisão que a tela tinha; se a base já está em outra
--    revisão, a gravação é recusada com 'agent_changed'.
create or replace function public.save_my_ai_agent(p_workspace_id uuid, p_agent_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_text_limits constant jsonb := jsonb_build_object('label', 60, 'business_name', 120, 'niche', 120,
    'assistant_name', 60, 'company_summary', 4000, 'commercial_terms', 4000, 'golden_rules', 8000,
    'extra_instructions', 4000);
  v_flags constant text[] := array['solo_identity','lock_until_manual_resume','prompt_shield_enabled'];
  v_key text;
  v_value jsonb;
  v_data jsonb := '{}'::jsonb;
  v_agent public.ai_agents%rowtype;
  v_created boolean := false;
  v_count integer;
  v_faqs jsonb;
  v_faq jsonb;
  v_position integer := 0;
  v_question text;
  v_answer text;
  v_expected integer;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Invalid agent data' using errcode = '22023';
  end if;

  -- Confere campo a campo e guarda os textos já sem espaços nas pontas.
  for v_key, v_value in select * from jsonb_each(p_data) loop
    if v_text_limits ? v_key then
      if jsonb_typeof(v_value) <> 'string'
        or char_length(private.trim_text(v_value #>> '{}')) > (v_text_limits ->> v_key)::integer then
        raise exception 'Invalid %', v_key using errcode = '22023';
      end if;
      v_data := v_data || jsonb_build_object(v_key, private.trim_text(v_value #>> '{}'));
    elsif v_key = any (v_flags) then
      if jsonb_typeof(v_value) <> 'boolean' then raise exception 'Invalid %', v_key using errcode = '22023'; end if;
      v_data := v_data || jsonb_build_object(v_key, v_value);
    elsif v_key = 'tone' then
      if jsonb_typeof(v_value) <> 'string'
        or (v_value #>> '{}') not in ('consultivo','acolhedor','descontraido','profissional','formal') then
        raise exception 'Invalid tone' using errcode = '22023';
      end if;
      v_data := v_data || jsonb_build_object(v_key, v_value);
    elsif v_key = 'robot_question_policy' then
      if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') not in ('handoff','disclose') then
        raise exception 'Invalid robot_question_policy' using errcode = '22023';
      end if;
      v_data := v_data || jsonb_build_object(v_key, v_value);
    elsif v_key = 'faqs' then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) > 100 then
        raise exception 'Invalid faqs' using errcode = '22023';
      end if;
      v_faqs := v_value;
    elsif v_key = 'expected_revision' then
      -- A revisão que a tela tinha quando abriu a base. Não é um campo da base: é só a conferência.
      if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}') !~ '^[0-9]{1,9}$' or (v_value #>> '{}')::integer < 1 then
        raise exception 'Invalid expected_revision' using errcode = '22023';
      end if;
      v_expected := (v_value #>> '{}')::integer;
    else
      raise exception 'Unknown agent field: %', left(v_key, 60) using errcode = '22023';
    end if;
  end loop;
  if v_data ? 'label' and v_data ->> 'label' = '' then
    raise exception 'Invalid label' using errcode = '22023';
  end if;

  -- Trava a empresa: duas gravações ao mesmo tempo não criam duas bases padrão nem passam do limite.
  perform 1 from public.workspaces w where w.id = p_workspace_id and w.status = 'active' for update;
  if not found then raise exception 'Workspace not active' using errcode = '42501'; end if;

  if v_data ? 'label' then
    perform 1 from public.ai_agents o
    where o.workspace_id = p_workspace_id and lower(o.label) = lower(v_data ->> 'label')
      and (p_agent_id is null or o.id <> p_agent_id);
    if found then raise exception 'agent_label_taken' using errcode = 'P0001'; end if;
  end if;

  if p_agent_id is null then
    select count(*) into v_count from public.ai_agents a where a.workspace_id = p_workspace_id;
    if v_count >= 10 then raise exception 'agent_limit_reached' using errcode = 'P0001'; end if;
    if not (v_data ? 'label') then
      if v_count > 0 then raise exception 'Invalid label' using errcode = '22023'; end if;
      v_data := v_data || jsonb_build_object('label', 'Principal');
    end if;
    -- A primeira base da empresa já nasce como a padrão.
    insert into public.ai_agents(workspace_id, label, is_default, updated_by)
    values (p_workspace_id, v_data ->> 'label', v_count = 0, v_actor)
    returning * into v_agent;
    v_created := true;
  else
    select a.* into v_agent from public.ai_agents a
    where a.workspace_id = p_workspace_id and a.id = p_agent_id
    for update;
    if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
    -- A base mudou depois que a tela foi aberta (outra aba, ou uma correção feita na Inbox):
    -- recusa, em vez de apagar a mudança mais nova com a lista antiga.
    if v_expected is not null and v_agent.revision <> v_expected then
      raise exception 'agent_changed' using errcode = 'P0001';
    end if;
  end if;

  update public.ai_agents a set
    label = coalesce(v_data ->> 'label', a.label),
    business_name = coalesce(v_data ->> 'business_name', a.business_name),
    niche = coalesce(v_data ->> 'niche', a.niche),
    assistant_name = coalesce(v_data ->> 'assistant_name', a.assistant_name),
    tone = coalesce(v_data ->> 'tone', a.tone),
    solo_identity = coalesce((v_data ->> 'solo_identity')::boolean, a.solo_identity),
    company_summary = coalesce(v_data ->> 'company_summary', a.company_summary),
    commercial_terms = coalesce(v_data ->> 'commercial_terms', a.commercial_terms),
    golden_rules = coalesce(v_data ->> 'golden_rules', a.golden_rules),
    extra_instructions = coalesce(v_data ->> 'extra_instructions', a.extra_instructions),
    lock_until_manual_resume = coalesce((v_data ->> 'lock_until_manual_resume')::boolean, a.lock_until_manual_resume),
    prompt_shield_enabled = coalesce((v_data ->> 'prompt_shield_enabled')::boolean, a.prompt_shield_enabled),
    robot_question_policy = coalesce(v_data ->> 'robot_question_policy', a.robot_question_policy),
    revision = (case when v_created then a.revision else a.revision + 1 end),
    updated_by = v_actor,
    updated_at = now()
  where a.workspace_id = p_workspace_id and a.id = v_agent.id;

  if v_faqs is not null then
    delete from public.ai_agent_faqs f where f.workspace_id = p_workspace_id and f.agent_id = v_agent.id;
    for v_faq in select * from jsonb_array_elements(v_faqs) loop
      if jsonb_typeof(v_faq) <> 'object' or jsonb_typeof(v_faq -> 'question') is distinct from 'string'
        or jsonb_typeof(v_faq -> 'answer') is distinct from 'string' then
        raise exception 'Invalid faqs' using errcode = '22023';
      end if;
      v_question := private.trim_text(v_faq ->> 'question');
      v_answer := private.trim_text(v_faq ->> 'answer');
      if char_length(v_question) not between 1 and 500 or char_length(v_answer) not between 1 and 2000 then
        raise exception 'Invalid faqs' using errcode = '22023';
      end if;
      insert into public.ai_agent_faqs(workspace_id, agent_id, position, question, answer, source)
      values (p_workspace_id, v_agent.id, v_position, v_question, v_answer,
        case when v_faq ->> 'source' in ('correction','template') then v_faq ->> 'source' else 'manual' end);
      v_position := v_position + 1;
    end loop;
  end if;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner',case when v_created then 'ai_agent_created' else 'ai_agent_updated' end,
    'ai_agent',v_agent.id::text,
    jsonb_build_object('fields', (select coalesce(jsonb_agg(t.k order by t.k), '[]'::jsonb) from jsonb_object_keys(p_data) as t(k) where t.k <> 'expected_revision'),
      'faq_count', case when v_faqs is not null then jsonb_array_length(v_faqs) end));

  return private.ai_agent_json(p_workspace_id, v_agent.id, false) || jsonb_build_object('can_edit', true);
end;
$$;

-- 4) Ensinar a IA a partir de uma mensagem da conversa (só o dono da conta).
--    A mensagem serve para achar o chip e, pelo chip, a base de treinamento que ele usa
--    (sem base própria, a padrão da empresa).
--      p_target = 'faq'  : guarda uma pergunta frequente, que passa a ser a primeira da lista. Se a
--                          mesma pergunta já existe nessa base, a resposta dela é trocada.
--      p_target = 'rule' : acrescenta uma linha nas regras de ouro (p_question não é usado).
--    Devolve em 'result': added (entrou), replaced (a pergunta já existia; trocou a resposta) ou
--    unchanged (a regra já estava lá; nada mudou).
create or replace function public.teach_my_ai_from_message(
  p_workspace_id uuid,
  p_message_id uuid,
  p_target text,
  p_question text,
  p_answer text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_question text := private.trim_text(coalesce(p_question, ''));
  v_answer text := private.trim_text(coalesce(p_answer, ''));
  v_instance_id uuid;
  v_actor_type text;
  v_agent public.ai_agents%rowtype;
  v_faq_id uuid;
  v_count integer;
  v_line text;
  v_rules text;
  v_result text := 'added';
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_target is null or p_target not in ('faq','rule') then
    raise exception 'Invalid target' using errcode = '22023';
  end if;
  if p_target = 'faq' then
    if char_length(v_question) not between 1 and 500 then
      raise exception 'Invalid question' using errcode = '22023';
    end if;
    if char_length(v_answer) not between 1 and 2000 then
      raise exception 'Invalid answer' using errcode = '22023';
    end if;
  else
    if char_length(v_answer) not between 1 and 1000 then
      raise exception 'Invalid answer' using errcode = '22023';
    end if;
  end if;

  -- A mesma ordem de travas de quem grava o treinamento: primeiro a empresa, depois a base.
  perform 1 from public.workspaces w where w.id = p_workspace_id and w.status = 'active' for update;
  if not found then raise exception 'Workspace not active' using errcode = '42501'; end if;

  select m.instance_id, m.actor_type into v_instance_id, v_actor_type
  from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id;
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;

  select a.* into v_agent
  from public.ai_agents a
  where a.workspace_id = p_workspace_id
    and a.id = coalesce(
      (select i.ai_agent_id from public.instances i
       where i.workspace_id = p_workspace_id and i.id = v_instance_id),
      (select d.id from public.ai_agents d
       where d.workspace_id = p_workspace_id and d.is_default))
  for update;
  if not found then raise exception 'ai_training_missing' using errcode = 'P0001'; end if;

  if p_target = 'faq' then
    select f.id into v_faq_id
    from public.ai_agent_faqs f
    where f.workspace_id = p_workspace_id and f.agent_id = v_agent.id and lower(f.question) = lower(v_question)
    order by f.position, f.id
    limit 1;

    if v_faq_id is not null then
      v_result := 'replaced';
      update public.ai_agent_faqs f
      set question = v_question, answer = v_answer, source = 'correction'
      where f.workspace_id = p_workspace_id and f.id = v_faq_id;
    else
      select count(*) into v_count
      from public.ai_agent_faqs f
      where f.workspace_id = p_workspace_id and f.agent_id = v_agent.id;
      if v_count >= 100 then raise exception 'faq_limit_reached' using errcode = 'P0001'; end if;
      insert into public.ai_agent_faqs(workspace_id, agent_id, position, question, answer, source)
      values (p_workspace_id, v_agent.id, 0, v_question, v_answer, 'correction')
      returning id into v_faq_id;
    end if;

    -- A pergunta ensinada passa a ser a primeira; as outras continuam na ordem em que estavam.
    update public.ai_agent_faqs f
    set position = x.new_position
    from (
      select o.id, (row_number() over (order by (o.id = v_faq_id) desc, o.position, o.id) - 1)::integer as new_position
      from public.ai_agent_faqs o
      where o.workspace_id = p_workspace_id and o.agent_id = v_agent.id
    ) x
    where f.workspace_id = p_workspace_id and f.id = x.id and f.position <> x.new_position;
    v_rules := v_agent.golden_rules;
  else
    -- Uma regra por linha, começando com hífen, do jeito que o dono escreve na tela.
    v_line := '- ' || regexp_replace(v_answer, '[[:space:]]+', ' ', 'g');
    if position(lower(v_line) in lower(v_agent.golden_rules)) > 0 then
      -- A mesma regra já está escrita: nada muda.
      return jsonb_build_object('agent_id', v_agent.id, 'agent_label', v_agent.label, 'target', p_target,
        'result', 'unchanged', 'revision', v_agent.revision);
    end if;
    v_rules := (case when v_agent.golden_rules = '' then v_line else v_agent.golden_rules || chr(10) || v_line end);
    if char_length(v_rules) > 8000 then raise exception 'rules_limit_reached' using errcode = 'P0001'; end if;
  end if;

  update public.ai_agents a
  set golden_rules = v_rules, revision = a.revision + 1, updated_by = v_actor, updated_at = now()
  where a.workspace_id = p_workspace_id and a.id = v_agent.id;

  -- O texto ensinado não vai para a auditoria: fica só no treinamento.
  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_agent_taught','ai_agent',v_agent.id::text,
    jsonb_build_object('target', p_target, 'result', v_result, 'message_id', p_message_id, 'message_actor', v_actor_type));

  return jsonb_build_object('agent_id', v_agent.id, 'agent_label', v_agent.label, 'target', p_target,
    'result', v_result, 'revision', v_agent.revision + 1);
end;
$$;

revoke all on function public.teach_my_ai_from_message(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.teach_my_ai_from_message(uuid, uuid, text, text, text) to authenticated;

commit;
