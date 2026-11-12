begin;

-- Fase 2 (Atendente de IA), segunda parte: a IA passa a responder no WhatsApp.
--
--   - Liga/desliga da IA em cada chip (instances.is_enabled) e o botão de emergência Pausar tudo.
--   - A vez da IA em cada conversa (ai_turns): ela espera o cliente terminar de escrever, responde uma
--     vez só, passa a conversa para uma pessoa quando precisa e NUNCA reenvia sozinha.
--   - A IA para numa conversa quando uma pessoa responde (pelo painel ou pelo celular do chip).
--   - Na Inbox: assumir a conversa e devolver para a IA.
--
-- Quem movimenta a vez da IA é só o servidor do painel (service_role). As pessoas ligam, desligam,
-- pausam, assumem e devolvem pelas funções feitas para isso.

-- 1) As conversas passam a mudar somente pelas funções do banco. Até aqui uma pessoa da empresa
--    podia alterar direto a etapa e a pausa da automação; o painel nunca usou esse caminho, e com
--    a IA respondendo ele deixaria a conversa num estado que nenhuma regra previu.
revoke update on public.conversations from authenticated;
drop policy if exists conversations_update_member on public.conversations;

-- 2) Esperar o cliente terminar de escrever: de 1 a 20 segundos (era até 60). A espera, a resposta
--    da IA e o envio precisam caber no tempo de um único pedido ao servidor.
update public.workspace_ai_settings set debounce_seconds = 20 where debounce_seconds > 20;
alter table public.workspace_ai_settings drop constraint workspace_ai_settings_debounce_seconds_check;
alter table public.workspace_ai_settings
  add constraint workspace_ai_settings_debounce_seconds_check check (debounce_seconds between 1 and 20);

-- 3) Pausar tudo: uma linha por empresa. Sem linha = não está pausada.
create table public.workspace_ai_state (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  paused boolean not null default false,
  paused_at timestamptz,
  paused_by uuid references auth.users(id) on delete set null,
  resumed_at timestamptz,
  resumed_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.workspace_ai_state enable row level security;
revoke all on public.workspace_ai_state from anon, authenticated;
grant select on public.workspace_ai_state to authenticated;
grant all on public.workspace_ai_state to service_role;
create policy workspace_ai_state_select_member on public.workspace_ai_state for select to authenticated
  using (private.is_workspace_member(workspace_id));
create trigger workspace_ai_state_touch_updated_at before update on public.workspace_ai_state
  for each row execute function private.touch_updated_at();

-- 4) A IA em cada conversa.
--    automation_paused (já existia) = a IA não responde aqui até alguém devolver a conversa para ela.
--    ai_paused_until = a IA não responde aqui até esta hora (depois volta sozinha).
--    ai_pause_reason = por que parou; ai_handoff_note = o recado que ela deixou ao passar a conversa.
alter table public.conversations
  add column ai_paused_until timestamptz,
  add column ai_pause_reason text
    check (ai_pause_reason is null or ai_pause_reason in
      ('handoff','silent_handoff','uncertain_send','error','safety','human_reply','claimed','closed','opt_out')),
  add column ai_handoff_at timestamptz,
  add column ai_handoff_note text check (ai_handoff_note is null or char_length(ai_handoff_note) <= 600);

-- A ordem das mensagens de uma conversa. O WhatsApp informa a hora de cada mensagem só até o segundo;
-- quando duas caem no mesmo segundo (o cliente responde logo depois de nós), quem desempata é a hora em
-- que cada uma chegou ao painel. Para isso valer sempre, a hora de chegada passa a ser a do relógio
-- (e não a do começo do pedido, que seria igual para tudo o que o mesmo pedido grava).
alter table public.messages alter column created_at set default clock_timestamp();

-- 5) A vez da IA. Cada linha é uma resposta que a IA deve (ou devia) dar numa conversa:
--      waiting    — esperando o cliente terminar de escrever (due_at é quando a espera acaba);
--      running    — o servidor pegou a vez e está pedindo a resposta ao provedor ou enviando;
--      answered   — respondeu;
--      silent     — entendeu que não havia o que responder (um ok, obrigado final);
--      handed_off — passou a conversa para uma pessoa;
--      closed     — despediu-se e encerrou a conversa (recusa ou pedido para parar);
--      failed     — não conseguiu (a conversa foi para uma pessoa);
--      skipped    — não era mais para responder (uma pessoa respondeu antes, a IA foi pausada, chegou
--                   mensagem mais nova e outra vez assumiu).
--    Fica guardado também qual provedor e qual modelo responderam, para o dono entender o que houve.
create table public.ai_turns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null,
  instance_id uuid not null,
  -- A última mensagem do cliente que esta resposta leva em conta.
  trigger_message_id uuid not null,
  status text not null default 'waiting'
    check (status in ('waiting','running','answered','silent','handed_off','closed','failed','skipped')),
  due_at timestamptz not null,
  claimed_at timestamptz,
  finished_at timestamptz,
  outcome_detail text check (outcome_detail is null or char_length(outcome_detail) <= 300),
  provider text check (provider is null or provider in ('gemini','openrouter','nvidia')),
  model text check (model is null or char_length(model) <= 160),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  tokens_in integer check (tokens_in is null or tokens_in >= 0),
  tokens_out integer check (tokens_out is null or tokens_out >= 0),
  -- Provedores que falharam antes de um responder: [{provider, model, error}]. Nunca guarda chave nem texto de erro cru.
  attempts jsonb not null default '[]'::jsonb check (jsonb_typeof(attempts) = 'array'),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id) on delete cascade,
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete restrict,
  foreign key (workspace_id, trigger_message_id) references public.messages(workspace_id, id) on delete cascade
);
-- Em cada conversa: no máximo uma vez esperando e uma em andamento.
create unique index ai_turns_one_waiting_uq on public.ai_turns(workspace_id, conversation_id) where status = 'waiting';
create unique index ai_turns_one_running_uq on public.ai_turns(workspace_id, conversation_id) where status = 'running';
create index ai_turns_open_idx on public.ai_turns(workspace_id, due_at) where status in ('waiting','running');
create index ai_turns_conversation_idx on public.ai_turns(workspace_id, conversation_id, created_at desc);
create index ai_turns_trigger_message_idx on public.ai_turns(workspace_id, trigger_message_id);
create index ai_turns_instance_idx on public.ai_turns(workspace_id, instance_id);
alter table public.ai_turns enable row level security;
revoke all on public.ai_turns from anon, authenticated;
grant select on public.ai_turns to authenticated;
grant all on public.ai_turns to service_role;
create policy ai_turns_select_member on public.ai_turns for select to authenticated
  using (private.is_workspace_member(workspace_id));

-- 6) Peças usadas pelas funções abaixo.

-- O miolo de um telefone, para comparar dois números: só os dígitos e, no celular brasileiro,
-- sem o nono dígito (o WhatsApp entrega o mesmo número das duas formas).
create or replace function private.phone_core(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when d ~ '^55[1-9][0-9]9[0-9]{8}$' then substr(d, 1, 4) || substr(d, 6)
    else d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d) t
$$;
revoke all on function private.phone_core(text) from public, anon, authenticated;

-- O que falta para a IA poder ser ligada num chip: a chave do provedor principal e uma base de treinamento.
-- Devolve vazio quando não falta nada.
create or replace function private.ai_missing_setup(p_workspace_id uuid, p_instance_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1 from private.workspace_ai_secrets k
      where k.workspace_id = p_workspace_id
        and k.provider = (private.ai_settings_json(p_workspace_id) ->> 'provider')) then 'ai_key_missing'
    when not exists (
      select 1 from public.ai_agents a
      where a.workspace_id = p_workspace_id
        and (a.is_default or a.id = (select i.ai_agent_id from public.instances i
                                      where i.workspace_id = p_workspace_id and i.id = p_instance_id))) then 'ai_training_missing'
  end
$$;
revoke all on function private.ai_missing_setup(uuid, uuid) from public, anon, authenticated;

-- Por que a IA NÃO pode responder nesta conversa agora. Vazio = pode.
create or replace function private.ai_block_reason(p_workspace_id uuid, p_conversation_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation public.conversations%rowtype;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
begin
  select c.* into v_conversation
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
  if not found then return 'conversation_missing'; end if;

  if exists (select 1 from public.workspace_ai_state s where s.workspace_id = p_workspace_id and s.paused) then
    return 'workspace_paused';
  end if;

  select i.* into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_conversation.instance_id;
  if not found or v_instance.status = 'revoked' or v_instance.engine <> 'evolution'
    or v_instance.provider_instance_name is null then
    return 'chip_unavailable';
  end if;
  if not v_instance.is_enabled then return 'chip_ai_off'; end if;
  if v_instance.status <> 'connected' then return 'chip_not_connected'; end if;

  if v_conversation.stage in ('resolved','archived') then return 'conversation_closed'; end if;
  if v_conversation.automation_paused
    or (v_conversation.ai_paused_until is not null and v_conversation.ai_paused_until > clock_timestamp()) then
    return 'conversation_paused';
  end if;

  select ct.* into v_contact
  from public.contacts ct
  where ct.workspace_id = p_workspace_id and ct.id = v_conversation.contact_id;
  if not found or v_contact.erased_at is not null or v_contact.external_user_id is null
    or v_contact.external_user_id !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$' then
    return 'contact_unreachable';
  end if;

  -- Um chip da própria empresa escrevendo para outro: se a IA respondesse, dois robôs conversariam sem parar.
  if exists (
    select 1 from public.instances o
    where o.workspace_id = p_workspace_id and o.status <> 'revoked' and o.connected_phone is not null
      and private.phone_core(o.connected_phone) = private.phone_core(v_contact.external_user_id)) then
    return 'own_chip';
  end if;

  return null;
end;
$$;
revoke all on function private.ai_block_reason(uuid, uuid) from public, anon, authenticated;

-- Desfaz a vez que estava esperando numa conversa (quem chama já está com a conversa travada).
create or replace function private.cancel_waiting_ai_turn(p_workspace_id uuid, p_conversation_id uuid, p_detail text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ai_turns
  set status = 'skipped', finished_at = clock_timestamp(), outcome_detail = left(p_detail, 300)
  where workspace_id = p_workspace_id and conversation_id = p_conversation_id and status = 'waiting'
$$;
revoke all on function private.cancel_waiting_ai_turn(uuid, uuid, text) from public, anon, authenticated;

-- Passa a conversa para uma pessoa: ela aparece em Esperando você, com o recado e o motivo, e a IA
-- para de responder ali. p_lock = só volta quando alguém devolver a conversa; sem isso, volta sozinha
-- depois do tempo de pausa configurado no Motor de IA.
create or replace function private.hand_conversation_to_human(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_kind text,
  p_note text,
  p_lock boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minutes integer := coalesce((private.ai_settings_json(p_workspace_id) ->> 'human_pause_minutes')::integer, 60);
  v_until timestamptz := clock_timestamp() + make_interval(mins => v_minutes);
begin
  update public.conversations
  set stage = case when stage in ('resolved','archived') then stage else 'waiting_human' end,
      unread_count = greatest(unread_count, 1),
      ai_handoff_at = clock_timestamp(),
      ai_handoff_note = nullif(left(private.trim_text(coalesce(p_note, '')), 600), ''),
      ai_pause_reason = p_kind,
      automation_paused = automation_paused or coalesce(p_lock, false),
      ai_paused_until = case when coalesce(p_lock, false) then ai_paused_until
                             else greatest(coalesce(ai_paused_until, v_until), v_until) end
  where workspace_id = p_workspace_id and id = p_conversation_id;
end;
$$;
revoke all on function private.hand_conversation_to_human(uuid, uuid, text, text, boolean) from public, anon, authenticated;

-- Uma pessoa respondeu nesta conversa (pelo painel ou pelo celular do chip), no momento p_at.
--   - a vez que a IA estava esperando é desfeita (a pessoa já respondeu);
--   - o recado que a IA tinha deixado ao passar a conversa sai: já foi atendido;
--   - se o Motor de IA manda pausar quando uma pessoa responde, a IA fica parada ali pelo tempo configurado
--     (ou até alguém devolver, quando a base de treinamento tem a trava permanente);
--   - se o Motor de IA manda NÃO pausar, a pausa com hora marcada que houvesse também sai.
-- Mensagem antiga que só chegou agora (o chip ficou sem sinal) não muda nada.
create or replace function private.note_human_reply(p_workspace_id uuid, p_conversation_id uuid, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings jsonb := private.ai_settings_json(p_workspace_id);
  v_at timestamptz := coalesce(p_at, clock_timestamp());
  v_pause boolean := coalesce((v_settings ->> 'pause_on_human_reply')::boolean, true);
  v_until timestamptz;
  v_lock boolean := false;
begin
  if v_at <= clock_timestamp() - interval '5 minutes' then
    return;
  end if;
  perform private.cancel_waiting_ai_turn(p_workspace_id, p_conversation_id, 'human_replied');

  if v_pause then
    select coalesce(a.lock_until_manual_resume, false) into v_lock
    from public.conversations c
    join public.instances i on i.workspace_id = c.workspace_id and i.id = c.instance_id
    left join public.ai_agents a on a.workspace_id = c.workspace_id
      and (a.id = i.ai_agent_id or (i.ai_agent_id is null and a.is_default))
    where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
    v_lock := coalesce(v_lock, false);
    v_until := v_at + make_interval(mins => coalesce((v_settings ->> 'human_pause_minutes')::integer, 60));
  end if;

  update public.conversations c
  set automation_paused = c.automation_paused or v_lock,
      ai_paused_until = case
        when c.automation_paused or v_lock then c.ai_paused_until
        when v_pause then greatest(coalesce(c.ai_paused_until, v_until), v_until)
        else null end,
      ai_handoff_at = null,
      ai_handoff_note = null,
      ai_pause_reason = case
        when c.automation_paused and c.ai_pause_reason = 'claimed' then 'claimed'
        when c.automation_paused or v_lock or v_pause then 'human_reply'
        else null end
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
end;
$$;
revoke all on function private.note_human_reply(uuid, uuid, timestamptz) from public, anon, authenticated;

-- Depois de uma resposta da IA que saiu:
--   - a IA não está parada nesta conversa (o caso comum): a conversa fica Com a IA, sem pendência, e o que
--     restava de um repasse antigo (motivo, recado, pausa já vencida) sai;
--   - a IA está parada ali (uma pessoa assumiu ou respondeu no meio do envio, ou a conversa já tinha sido
--     passada para alguém): só a prévia muda; a etapa e as não lidas ficam como a pessoa as vê.
create or replace function private.touch_conversation_after_ai_reply(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_body_text text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations c
  set last_message_preview = case when c.last_message_at is null or p_occurred_at >= c.last_message_at
                                  then left(p_body_text, 300) else c.last_message_preview end,
      last_message_at = greatest(coalesce(c.last_message_at, p_occurred_at), p_occurred_at),
      unread_count = case when x.stopped then c.unread_count else 0 end,
      stage = case when x.stopped or c.stage in ('resolved','archived') then c.stage else 'ai' end,
      ai_pause_reason = case when x.stopped then c.ai_pause_reason end,
      ai_paused_until = case when x.stopped then c.ai_paused_until end,
      ai_handoff_at = case when x.stopped then c.ai_handoff_at end,
      ai_handoff_note = case when x.stopped then c.ai_handoff_note end
  from (
    select o.id,
           (o.automation_paused or (o.ai_paused_until is not null and o.ai_paused_until > clock_timestamp())) as stopped
    from public.conversations o
    where o.workspace_id = p_workspace_id and o.id = p_conversation_id
  ) x
  where c.workspace_id = p_workspace_id and c.id = x.id;
end;
$$;
revoke all on function private.touch_conversation_after_ai_reply(uuid, uuid, text, timestamptz) from public, anon, authenticated;

-- Depois de uma mensagem de uma pessoa: igual a antes, e agora a conversa que estava Com a IA também
-- passa a Aguardando o cliente (foi uma pessoa quem respondeu por último).
create or replace function private.touch_conversation_after_outbound(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_body_text text,
  p_occurred_at timestamptz
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.conversations
  set last_message_preview = case when last_message_at is null or p_occurred_at >= last_message_at
                                  then left(p_body_text, 300) else last_message_preview end,
      last_message_at = greatest(coalesce(last_message_at, p_occurred_at), p_occurred_at),
      unread_count = 0,
      stage = case when stage in ('new','ai','waiting_human','human') then 'waiting_customer' else stage end
  where workspace_id = p_workspace_id and id = p_conversation_id
$$;
revoke all on function private.touch_conversation_after_outbound(uuid,uuid,text,timestamptz) from public, anon, authenticated;

-- Chegou uma mensagem do cliente: a IA responde? Quem chama (o recebimento do aviso) já está com a conversa travada.
--   Pode  -> marca (ou adia) a vez dela e a conversa fica Com a IA.
--   Não pode -> se a conversa estava Com a IA, passa a esperar uma pessoa.
create or replace function private.schedule_ai_turn(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_instance_id uuid,
  p_message_id uuid,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_wait integer;
  v_turn_id uuid;
begin
  -- Mensagem antiga que só chegou agora (o chip ficou sem sinal): responder horas depois não ajuda ninguém.
  if p_occurred_at is null or p_occurred_at < clock_timestamp() - interval '5 minutes' then
    v_reason := 'old_message';
  else
    v_reason := private.ai_block_reason(p_workspace_id, p_conversation_id);
  end if;

  if v_reason is not null then
    perform private.cancel_waiting_ai_turn(p_workspace_id, p_conversation_id, v_reason);
    update public.conversations set stage = 'waiting_human'
    where workspace_id = p_workspace_id and id = p_conversation_id and stage = 'ai';
    return jsonb_build_object('scheduled', false, 'reason', v_reason);
  end if;

  v_wait := least(greatest(coalesce((private.ai_settings_json(p_workspace_id) ->> 'debounce_seconds')::integer, 6), 1), 20);

  -- Já havia uma vez esperando: o cliente ainda está escrevendo. A espera recomeça a partir desta mensagem.
  update public.ai_turns
  set trigger_message_id = p_message_id, due_at = clock_timestamp() + make_interval(secs => v_wait)
  where workspace_id = p_workspace_id and conversation_id = p_conversation_id and status = 'waiting'
  returning id into v_turn_id;

  if v_turn_id is null then
    insert into public.ai_turns(workspace_id, conversation_id, instance_id, trigger_message_id, due_at)
    values (p_workspace_id, p_conversation_id, p_instance_id, p_message_id, clock_timestamp() + make_interval(secs => v_wait))
    returning id into v_turn_id;
  end if;

  update public.conversations set stage = 'ai'
  where workspace_id = p_workspace_id and id = p_conversation_id and stage <> 'ai';

  return jsonb_build_object('scheduled', true, 'turn_id', v_turn_id, 'wait_ms', v_wait * 1000);
end;
$$;
revoke all on function private.schedule_ai_turn(uuid, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;

-- Vezes da IA que ficaram para trás (o servidor reiniciou no meio, por exemplo):
--   em andamento há mais de 3 minutos -> considerada interrompida; a conversa vai para uma pessoa;
--   esperando há mais de 5 minutos    -> tarde demais para responder; a conversa vai para uma pessoa.
-- Trava a conversa antes da vez (a mesma ordem das outras funções); o que estiver travado por outro pedido fica para a próxima.
create or replace function private.reap_ai_turns(p_workspace_id uuid, p_conversation_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_changed integer := 0;
begin
  for v_candidate in
    select t.id, t.conversation_id, t.status
    from public.ai_turns t
    where t.workspace_id = p_workspace_id
      and (p_conversation_id is null or t.conversation_id = p_conversation_id)
      and ((t.status = 'running' and t.claimed_at < clock_timestamp() - interval '3 minutes')
        or (t.status = 'waiting' and t.due_at < clock_timestamp() - interval '5 minutes'))
    order by t.due_at
    limit 50
  loop
    perform 1 from public.conversations c
    where c.workspace_id = p_workspace_id and c.id = v_candidate.conversation_id
    for update skip locked;
    if not found then continue; end if;

    update public.ai_turns
    set status = case when status = 'running' then 'failed' else 'skipped' end,
        finished_at = clock_timestamp(),
        outcome_detail = case when status = 'running' then 'interrupted' else 'expired' end
    where workspace_id = p_workspace_id and id = v_candidate.id
      and ((status = 'running' and claimed_at < clock_timestamp() - interval '3 minutes')
        or (status = 'waiting' and due_at < clock_timestamp() - interval '5 minutes'));
    if not found then continue; end if;

    perform private.hand_conversation_to_human(p_workspace_id, v_candidate.conversation_id, 'error',
      case when v_candidate.status = 'running'
           then 'A IA foi interrompida no meio de uma resposta. Confira a conversa antes de responder.'
           else 'A IA não respondeu esta conversa a tempo.' end,
      false);
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,null,'service','ai_turn_abandoned','conversation',v_candidate.conversation_id::text,
      jsonb_build_object('turn',v_candidate.id,'was',v_candidate.status));
    v_changed := v_changed + 1;
  end loop;
  return v_changed;
end;
$$;
revoke all on function private.reap_ai_turns(uuid, uuid) from public, anon, authenticated;

-- 7) Receber um aviso da Evolution. Igual à versão anterior, com três acréscimos:
--    - mensagem do cliente: marca a vez da IA (schedule_ai_turn) e devolve isso em ai;
--    - mensagem nossa que não é da IA: a IA para naquela conversa (note_human_reply);
--    - o eco de uma resposta da IA mantém a conversa Com a IA.
create or replace function private.ingest_evolution_message(
  p_instance_name text,
  p_token_sha256 text,
  p_event_id text,
  p_event_type text,
  p_sender_jid text,
  p_push_name text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_from_me boolean,
  p_media jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_instance_id uuid;
  v_webhook_event_id uuid;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_candidate_id uuid;
  v_message_id uuid;
  v_phone text;
  v_display_name text;
  v_body text := nullif(btrim(coalesce(p_body_text, '')), '');
  v_created boolean := false;
  v_adopted boolean := false;
  v_kind text;
  v_mime text;
  v_size bigint;
  v_file_name text;
  v_duration integer;
  v_width integer;
  v_height integer;
  v_voice boolean := false;
  v_object_key text;
  v_media_status text;
  v_keep_until timestamptz;
  v_preview text;
  v_adopted_actor text;
  v_ai jsonb;
  -- Só vale como ficha de arquivo um objeto JSON; qualquer outra coisa é tratada como mensagem sem arquivo.
  v_media jsonb := case when jsonb_typeof(p_media) = 'object' then p_media end;
begin
  if p_instance_name is null or char_length(p_instance_name) > 100
    or p_token_sha256 is null or p_token_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('result','unauthorized');
  end if;

  select a.workspace_id, a.instance_id
  into v_workspace_id, v_instance_id
  from private.evolution_webhook_auth a
  join public.instances i on i.workspace_id = a.workspace_id and i.id = a.instance_id
  where i.provider_instance_name = p_instance_name
    and i.channel = 'whatsapp' and i.engine = 'evolution' and i.status <> 'revoked'
    and a.token_sha256 = p_token_sha256;
  if not found then return jsonb_build_object('result','unauthorized'); end if;

  if p_event_id is null or char_length(p_event_id) not between 1 and 200 then
    raise exception 'Invalid event id' using errcode = '22023';
  end if;
  if p_event_type is null or char_length(p_event_type) not between 1 and 80 then
    raise exception 'Invalid event type' using errcode = '22023';
  end if;

  insert into public.webhook_events(workspace_id,instance_id,engine,provider_event_id,event_type,processing_status)
  values (v_workspace_id,v_instance_id,'evolution',p_event_id,p_event_type,'received')
  on conflict (workspace_id,instance_id,engine,provider_event_id) do nothing
  returning id into v_webhook_event_id;
  if v_webhook_event_id is null then return jsonb_build_object('result','duplicate'); end if;

  -- Ficha do arquivo, quando a mensagem traz um.
  if v_media is not null then
    v_kind := v_media ->> 'kind';
    if v_kind is null or v_kind not in ('image','audio','video','document','sticker') then
      v_kind := 'document';
    end if;
    v_mime := lower(btrim(split_part(left(coalesce(v_media ->> 'mime', ''), 200), ';', 1)));
    if v_mime !~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' or char_length(v_mime) > 120 then
      v_mime := 'application/octet-stream';
    end if;
    v_file_name := nullif(left(btrim(coalesce(v_media ->> 'file_name', '')), 200), '');
    v_voice := coalesce(v_media ->> 'voice', '') = 'true';
    if (v_media ->> 'size') ~ '^[0-9]{1,15}$' then v_size := (v_media ->> 'size')::bigint; end if;
    if (v_media ->> 'duration') ~ '^[0-9]{1,5}$' then v_duration := least((v_media ->> 'duration')::integer, 86400); end if;
    if (v_media ->> 'width') ~ '^[0-9]{1,5}$' and (v_media ->> 'width')::integer between 1 and 20000 then
      v_width := (v_media ->> 'width')::integer;
    end if;
    if (v_media ->> 'height') ~ '^[0-9]{1,5}$' and (v_media ->> 'height')::integer between 1 and 20000 then
      v_height := (v_media ->> 'height')::integer;
    end if;
  end if;

  -- p_sender_jid é sempre o OUTRO lado da conversa (o contato), venha a mensagem dele ou de nós.
  if p_event_type <> 'MESSAGES_UPSERT' or p_from_me is null
    or p_sender_jid is null or p_sender_jid !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$'
    or p_occurred_at is null
    or coalesce(char_length(v_body), 0) > 8000
    or (v_media is null and v_body is null) then
    update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
    return jsonb_build_object('result','ignored');
  end if;

  v_preview := private.message_preview(v_body, v_kind, v_voice, v_file_name);

  -- Mensagem nossa que o painel já anotou (ele enviou e guardou o identificador): nada a fazer.
  if p_from_me then
    perform 1 from public.messages m
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id
      and m.source_engine = 'evolution' and m.provider_message_id = p_event_id;
    if found then
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      return jsonb_build_object('result','duplicate');
    end if;
  end if;

  v_phone := '+' || split_part(p_sender_jid,'@',1);
  -- Em mensagem enviada pelo próprio chip, o nome que vem junto é o do dono do chip, não o do contato.
  v_display_name := case when p_from_me then '' else coalesce(nullif(left(btrim(p_push_name),160),''),'') end;

  insert into public.contacts(workspace_id,instance_id,channel,external_user_id,display_name,phone_e164)
  values (v_workspace_id,v_instance_id,'whatsapp',p_sender_jid,v_display_name,v_phone)
  on conflict (workspace_id,channel,instance_id,external_user_id)
    where external_user_id is not null and erased_at is null
  do update set
    display_name = case when public.contacts.display_name in ('','Contato') and excluded.display_name <> ''
                        then excluded.display_name else public.contacts.display_name end,
    phone_e164 = coalesce(public.contacts.phone_e164,excluded.phone_e164),
    updated_at = now()
  returning id into v_contact_id;

  -- Um aviso por vez para o mesmo contato.
  perform 1 from public.contacts where workspace_id = v_workspace_id and id = v_contact_id for update;

  if p_from_me then
    -- É o eco de um envio do painel que ainda não tem identificador? Vale o envio em aberto mais recente
    -- igual a este (mesmo texto; ou, com arquivo, mesmo tipo e mesma legenda); depois, um já confirmado
    -- por uma pessoa há pouco.
    select m.id, m.conversation_id into v_candidate_id, v_conversation_id
    from public.messages m
    join public.conversations c on c.workspace_id = m.workspace_id and c.id = m.conversation_id
    left join public.message_attachments a on a.workspace_id = m.workspace_id and a.message_id = m.id
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id and c.contact_id = v_contact_id
      and m.direction = 'outbound' and m.source_engine = 'evolution'
      and m.provider_message_id is null and m.idempotency_key is not null
      and m.status in ('sending','awaiting_human_confirmation','sent')
      and ((v_kind is null and a.id is null and m.body_text = v_body)
        or (v_kind is not null and a.kind = v_kind and m.body_text is not distinct from v_body))
      and m.created_at > now() - case when m.status = 'sent' then interval '15 minutes' else interval '2 hours' end
    order by (m.status = 'sent'), m.created_at desc, m.id
    limit 1;
  end if;

  if v_conversation_id is not null then
    perform 1 from public.conversations c
    where c.workspace_id = v_workspace_id and c.id = v_conversation_id
    for update;
  else
    select c.id into v_conversation_id
    from public.conversations c
    where c.workspace_id = v_workspace_id and c.contact_id = v_contact_id and c.instance_id = v_instance_id
      and c.stage not in ('resolved','archived')
    order by c.activity_at desc, c.id desc
    limit 1
    for update;
    if v_conversation_id is null then
      insert into public.conversations(workspace_id,contact_id,instance_id,stage,last_message_at,last_message_preview,unread_count)
      values (v_workspace_id,v_contact_id,v_instance_id,case when p_from_me then 'waiting_customer' else 'new' end,
        p_occurred_at,v_preview,0)
      returning id into v_conversation_id;
      v_created := true;
    end if;
  end if;

  if p_from_me then
    -- Com a conversa travada, confere de novo: o painel pode ter terminado o envio neste meio-tempo.
    perform 1 from public.messages m
    where m.workspace_id = v_workspace_id and m.instance_id = v_instance_id
      and m.source_engine = 'evolution' and m.provider_message_id = p_event_id;
    if found then
      if v_created then
        delete from public.conversations where workspace_id = v_workspace_id and id = v_conversation_id;
      end if;
      update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;
      return jsonb_build_object('result','duplicate');
    end if;

    if v_candidate_id is not null then
      -- É a MESMA mensagem, não outra. Isso também confirma sozinho um envio que estava sem confirmação.
      update public.messages m
      set status = 'sent', provider_message_id = p_event_id
      where m.workspace_id = v_workspace_id and m.id = v_candidate_id
        and m.provider_message_id is null and m.status in ('sending','awaiting_human_confirmation','sent')
      returning m.id, m.actor_type into v_message_id, v_adopted_actor;
      v_adopted := v_message_id is not null;
    end if;
  end if;

  if not v_adopted then
    v_message_id := gen_random_uuid();
    if v_kind is not null then
      v_object_key := v_workspace_id::text || '/' || v_conversation_id::text || '/' || v_message_id::text
        || '/' || private.safe_object_name(v_file_name, v_kind);
      v_media_status := case when coalesce(v_size, 0) > 26214400 then 'too_large' else 'pending' end;
      v_keep_until := private.media_keep_until(v_workspace_id);
    end if;

    -- Recebida do contato, ou enviada direto pelo celular do chip.
    insert into public.messages(id,workspace_id,conversation_id,instance_id,provider_message_id,direction,
      source_engine,actor_type,status,body_text,media_object_key,occurred_at)
    values (v_message_id,v_workspace_id,v_conversation_id,v_instance_id,p_event_id,
      case when p_from_me then 'outbound' else 'inbound' end,'evolution',
      case when p_from_me then 'human' else 'contact' end,
      case when p_from_me then 'sent' else 'received' end,
      v_body,v_object_key,p_occurred_at);

    if v_kind is not null then
      insert into public.message_attachments(workspace_id,message_id,object_key,content_type,byte_size,kind,
        file_name,duration_seconds,width,height,is_voice,storage_status,retention_delete_after)
      values (v_workspace_id,v_message_id,v_object_key,v_mime,coalesce(v_size,0),v_kind,
        v_file_name,v_duration,v_width,v_height,v_voice,v_media_status,v_keep_until);
    end if;
  end if;

  if p_from_me then
    if v_adopted and v_adopted_actor = 'ai' then
      -- É o eco de uma resposta da IA: a conversa continua com ela.
      perform private.touch_conversation_after_ai_reply(v_workspace_id, v_conversation_id, v_preview, p_occurred_at);
    else
      perform private.touch_conversation_after_outbound(v_workspace_id, v_conversation_id, v_preview, p_occurred_at);
      -- Uma pessoa respondeu (pelo painel ou direto no celular do chip): a IA para nesta conversa.
      -- Exceção: se a IA está enviando agora nesta conversa, este aviso pode ser o eco dela chegando com
      -- o texto um pouco diferente; aí a mensagem é guardada, mas não conta como resposta de uma pessoa.
      if v_adopted or not exists (
        select 1 from public.messages m
        where m.workspace_id = v_workspace_id and m.conversation_id = v_conversation_id
          and m.direction = 'outbound' and m.actor_type = 'ai' and m.status = 'sending'
          and m.provider_message_id is null and m.created_at > clock_timestamp() - interval '2 minutes') then
        perform private.note_human_reply(v_workspace_id, v_conversation_id, p_occurred_at);
      end if;
    end if;
  else
    update public.conversations
    set last_message_preview = case when last_message_at is null or p_occurred_at >= last_message_at
                                    then v_preview else last_message_preview end,
        last_message_at = greatest(coalesce(last_message_at,p_occurred_at),p_occurred_at),
        unread_count = unread_count + 1,
        stage = case when stage = 'waiting_customer' then 'human' else stage end
    where workspace_id = v_workspace_id and id = v_conversation_id;
    -- A IA responde esta mensagem? Se sim, fica marcada a vez dela (depois de esperar o cliente terminar de escrever).
    v_ai := private.schedule_ai_turn(v_workspace_id, v_conversation_id, v_instance_id, v_message_id, p_occurred_at);
  end if;

  update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;

  return jsonb_build_object('result','accepted','workspace_id',v_workspace_id,
    'instance_id',v_instance_id,'contact_id',v_contact_id,'conversation_id',v_conversation_id,
    'message_id',v_message_id,'direction',case when p_from_me then 'outbound' else 'inbound' end,'adopted',v_adopted,
    'media',case when v_media_status is not null
                 then jsonb_build_object('object_key',v_object_key,'status',v_media_status) end,
    'ai',v_ai,
    -- Ficou alguma vez da IA para trás nesta empresa (servidor reiniciado no meio, por exemplo)?
    'ai_stale',exists (
      select 1 from public.ai_turns t
      where t.workspace_id = v_workspace_id
        and ((t.status = 'waiting' and t.due_at < clock_timestamp() - interval '20 seconds')
          or (t.status = 'running' and t.claimed_at < clock_timestamp() - interval '3 minutes'))));
end;
$$;

-- 8) Terminar um envio. O miolo é o mesmo de antes e agora serve para as pessoas e para a IA.
create or replace function private.finish_outbound_message(
  p_workspace_id uuid,
  p_message_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_actor uuid,
  p_actor_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_message public.messages%rowtype;
  v_other public.messages%rowtype;
  v_attachment public.message_attachments%rowtype;
  v_previous_status text;
  v_new_status text;
  v_provider_id text := p_provider_message_id;
begin
  if p_outcome is null or p_outcome not in ('sent','failed','uncertain') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;
  if v_provider_id is not null and char_length(v_provider_id) not between 1 and 200 then
    raise exception 'Invalid provider message id' using errcode = '22023';
  end if;

  select m.conversation_id into v_conversation_id
  from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id and m.direction = 'outbound';
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_conversation_id
  for update;

  select m.* into v_message
  from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id and m.direction = 'outbound'
  for update;
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  v_previous_status := v_message.status;

  -- O identificador que a Evolution devolveu já está em outra mensagem?
  if p_outcome = 'sent' and v_provider_id is not null
    and v_previous_status in ('sending','awaiting_human_confirmation','sent')
    and v_message.provider_message_id is distinct from v_provider_id then
    select m.* into v_other
    from public.messages m
    where m.workspace_id = p_workspace_id and m.instance_id = v_message.instance_id
      and m.source_engine = 'evolution' and m.provider_message_id = v_provider_id and m.id <> v_message.id
    for update;
    if found then
      if v_other.direction <> 'outbound' then
        -- Não deveria acontecer. Na dúvida, esta mensagem fica sem o identificador.
        v_provider_id := null;
      elsif v_other.idempotency_key is null then
        -- O eco chegou antes e foi guardado como mensagem do celular: é esta mesma mensagem. Fica só uma.
        delete from public.message_attachments d where d.workspace_id = p_workspace_id and d.message_id = v_other.id;
        delete from public.messages d where d.workspace_id = p_workspace_id and d.id = v_other.id;
      else
        -- Outra mensagem do painel, igual a esta, ficou com o eco desta por engano. Devolve o
        -- identificador e ela volta a aguardar a própria confirmação.
        update public.messages
        set provider_message_id = null,
            status = case when status = 'sent' then 'awaiting_human_confirmation' else status end
        where workspace_id = p_workspace_id and id = v_other.id;
      end if;
    end if;
  end if;

  if v_previous_status = 'sent' then
    -- Já confirmada (pelo eco ou por uma pessoa): só completa ou corrige o identificador do WhatsApp.
    if p_outcome = 'sent' and v_provider_id is not null and v_message.provider_message_id is distinct from v_provider_id then
      update public.messages set provider_message_id = v_provider_id
      where workspace_id = p_workspace_id and id = v_message.id;
    end if;
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', false);
  end if;
  -- Só mexe em mensagem que ainda está em aberto.
  if v_previous_status not in ('sending','awaiting_human_confirmation')
    or (v_previous_status = 'awaiting_human_confirmation' and p_outcome = 'uncertain') then
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', false);
  end if;

  v_new_status := case p_outcome when 'sent' then 'sent' when 'failed' then 'failed' else 'awaiting_human_confirmation' end;

  update public.messages
  set status = v_new_status,
      provider_message_id = case when p_outcome = 'sent' then coalesce(v_provider_id, provider_message_id)
                                 else provider_message_id end
  where workspace_id = p_workspace_id and id = v_message.id
  returning * into v_message;

  if v_new_status = 'sent' then
    select a.* into v_attachment
    from public.message_attachments a
    where a.workspace_id = p_workspace_id and a.message_id = v_message.id;
    if v_message.actor_type = 'ai' then
      perform private.touch_conversation_after_ai_reply(p_workspace_id, v_conversation_id,
        private.message_preview(v_message.body_text, v_attachment.kind, v_attachment.is_voice, v_attachment.file_name),
        v_message.occurred_at);
    else
      perform private.touch_conversation_after_outbound(p_workspace_id, v_conversation_id,
        private.message_preview(v_message.body_text, v_attachment.kind, v_attachment.is_voice, v_attachment.file_name),
        v_message.occurred_at);
    end if;
  else
    -- Nada muda na conversa; é só para as telas abertas perceberem que a mensagem mudou.
    update public.conversations set updated_at = now()
    where workspace_id = p_workspace_id and id = v_conversation_id;
  end if;

  -- A conversa tinha ido para uma pessoa porque não deu para confirmar o envio da IA, e a pessoa conferiu no
  -- WhatsApp que a mensagem chegou: o motivo do repasse acabou. A IA volta a valer ali; e, se o cliente não
  -- escreveu mais nada depois, a conversa volta a ficar com ela, sem pendência.
  if v_message.actor_type = 'ai' and p_actor is not null
    and v_previous_status = 'awaiting_human_confirmation' and v_new_status = 'sent' then
    update public.conversations c
    set ai_paused_until = null, ai_pause_reason = null, ai_handoff_at = null, ai_handoff_note = null,
        stage = case when x.answered and c.stage = 'waiting_human' then 'ai' else c.stage end,
        unread_count = case when x.answered then 0 else c.unread_count end
    from (
      select not exists (
        select 1 from public.messages n
        where n.workspace_id = p_workspace_id and n.conversation_id = v_conversation_id
          and n.direction = 'inbound' and n.created_at > v_message.created_at) as answered
    ) x
    where c.workspace_id = p_workspace_id and c.id = v_conversation_id
      and c.ai_pause_reason = 'uncertain_send' and not c.automation_paused;
  end if;

  -- Uma pessoa respondeu pelo painel (tenha a mensagem saído ou não): a IA para nesta conversa.
  if v_message.actor_type = 'human' then
    perform private.note_human_reply(p_workspace_id, v_conversation_id, clock_timestamp());
  end if;

  -- Envio comum que deu certo não vai para a auditoria (seria uma linha por mensagem).
  if v_new_status <> 'sent' or v_previous_status = 'awaiting_human_confirmation' then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,p_actor,p_actor_kind,'message_send_' || p_outcome,'message',v_message.id::text,
      jsonb_build_object('from',v_previous_status,'to',v_new_status));
  end if;

  return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', true);
end;
$$;
revoke all on function private.finish_outbound_message(uuid, uuid, text, text, uuid, text) from public, anon, authenticated;

-- Para as pessoas, nada muda: a função confere quem está chamando e usa o miolo acima.
create or replace function public.finish_my_text_message(
  p_workspace_id uuid,
  p_message_id uuid,
  p_outcome text,
  p_provider_message_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select m.role into v_role
  from public.workspace_memberships m
  where m.workspace_id = p_workspace_id and m.user_id = v_actor and m.status = 'active';
  if v_role is null then raise exception 'Workspace membership required' using errcode = '42501'; end if;
  return private.finish_outbound_message(p_workspace_id, p_message_id, p_outcome, p_provider_message_id, v_actor, v_role);
end;
$$;
revoke all on function public.finish_my_text_message(uuid, uuid, text, text) from public, anon;
grant execute on function public.finish_my_text_message(uuid, uuid, text, text) to authenticated;

-- 9) Mudar uma conversa: assumir e resolver desfazem a vez que a IA estava esperando; entra devolver para a IA (release).
create or replace function public.transition_workspace_conversation(p_workspace_id uuid,p_conversation_id uuid,p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_row public.conversations%rowtype;
  v_action_name text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select m.role into v_role from public.workspace_memberships m where m.workspace_id = p_workspace_id and m.user_id = v_actor and m.status = 'active';
  if v_role is null then raise exception 'Workspace membership required' using errcode = '42501'; end if;
  select c.* into v_row from public.conversations c where c.workspace_id = p_workspace_id and c.id = p_conversation_id for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;
  if p_action = 'claim' then
    if v_row.stage in ('resolved','archived') then raise exception 'Conversation is not active' using errcode = '22023'; end if;
    if v_row.assigned_user_id is not null and v_row.assigned_user_id <> v_actor then raise exception 'Conversation is assigned to another teammate' using errcode = '22023'; end if;
    update public.conversations set stage = 'human', automation_paused = true, ai_pause_reason = 'claimed', ai_paused_until = null, assigned_user_id = v_actor, assigned_label = 'Atendente' where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    -- A IA não responde mais aqui até alguém devolver a conversa para ela.
    perform private.cancel_waiting_ai_turn(p_workspace_id, p_conversation_id, 'claimed');
    v_action_name := 'conversation_claimed';
  elsif p_action = 'resolve' then
    if v_row.stage = 'archived' then raise exception 'Archived conversation cannot be resolved again' using errcode = '22023'; end if;
    update public.conversations set stage = 'resolved', automation_paused = true, unread_count = 0 where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    perform private.cancel_waiting_ai_turn(p_workspace_id, p_conversation_id, 'resolved');
    v_action_name := 'conversation_resolved';
  elsif p_action = 'reopen' then
    if v_row.stage <> 'resolved' then raise exception 'Conversation is not resolved' using errcode = '22023'; end if;
    -- Se o contato já escreveu de novo, existe uma conversa mais nova aberta: não pode haver duas.
    perform 1 from public.conversations o
    where o.workspace_id = p_workspace_id and o.contact_id = v_row.contact_id and o.instance_id = v_row.instance_id
      and o.id <> v_row.id and o.stage not in ('resolved','archived');
    if found then raise exception 'another_open_conversation' using errcode = 'P0001'; end if;
    update public.conversations set stage = 'human' where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_reopened';
  elsif p_action = 'release' then
    -- Devolver para a IA: ela volta a responder a partir da próxima mensagem do contato.
    if v_row.stage in ('resolved','archived') then raise exception 'Conversation is not active' using errcode = '22023'; end if;
    update public.conversations set automation_paused = false, ai_paused_until = null, ai_pause_reason = null, ai_handoff_at = null, ai_handoff_note = null, assigned_user_id = null, assigned_label = null where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_released';
  elsif p_action = 'mark_read' then
    if v_row.unread_count > 0 then
      update public.conversations set unread_count = 0 where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    end if;
  else raise exception 'Unsupported conversation action' using errcode = '22023';
  end if;
  if v_action_name is not null then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,v_actor,v_role,v_action_name,'conversation',p_conversation_id::text,jsonb_build_object('stage',v_row.stage,'automation_paused',v_row.automation_paused,'unread_count',v_row.unread_count));
  end if;
  return jsonb_build_object('id',v_row.id,'stage',v_row.stage,'assigned_user_id',v_row.assigned_user_id,'assigned_label',v_row.assigned_label,'automation_paused',v_row.automation_paused,'unread_count',v_row.unread_count,'updated_at',v_row.updated_at);
end;
$$;

-- 10) Gravar o Motor de IA: igual, com a espera de 1 a 20 segundos.
create or replace function public.save_my_ai_settings(p_workspace_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_allowed constant text[] := array['provider','fallback_provider','second_fallback_provider',
    'gemini_model','openrouter_model','nvidia_model',
    'temperature','max_history_messages','debounce_seconds','simulate_typing','split_long_messages',
    'pause_on_human_reply','human_pause_minutes'];
  v_key text;
  v_new jsonb;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Invalid settings' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_settings) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Unknown setting: %', left(v_key, 60) using errcode = '22023';
    end if;
  end loop;

  v_new := (private.ai_settings_json(p_workspace_id) - 'updated_at') || p_settings;

  if jsonb_typeof(v_new -> 'provider') <> 'string'
    or (v_new ->> 'provider') not in ('gemini','openrouter','nvidia') then
    raise exception 'Invalid provider' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'fallback_provider') <> 'string'
    or (v_new ->> 'fallback_provider') not in ('gemini','openrouter','nvidia','none') then
    raise exception 'Invalid fallback_provider' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'second_fallback_provider') <> 'string'
    or (v_new ->> 'second_fallback_provider') not in ('gemini','openrouter','nvidia','none') then
    raise exception 'Invalid second_fallback_provider' using errcode = '22023';
  end if;
  -- A ordem não repete provedor, e só existe segunda reserva quando existe a primeira.
  if (v_new ->> 'fallback_provider') = (v_new ->> 'provider')
    or (v_new ->> 'second_fallback_provider') = (v_new ->> 'provider')
    or ((v_new ->> 'second_fallback_provider') <> 'none'
      and ((v_new ->> 'fallback_provider') = 'none'
        or (v_new ->> 'second_fallback_provider') = (v_new ->> 'fallback_provider'))) then
    raise exception 'Invalid provider order' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'gemini_model') <> 'string'
    or (v_new ->> 'gemini_model') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$' then
    raise exception 'Invalid gemini_model' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'openrouter_model') <> 'string'
    or (v_new ->> 'openrouter_model') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$' then
    raise exception 'Invalid openrouter_model' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'nvidia_model') <> 'string'
    or (v_new ->> 'nvidia_model') !~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$' then
    raise exception 'Invalid nvidia_model' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'temperature') <> 'number' or (v_new ->> 'temperature')::numeric not between 0 and 1 then
    raise exception 'Invalid temperature' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'max_history_messages') <> 'number' or (v_new ->> 'max_history_messages') !~ '^[0-9]{1,3}$'
    or (v_new ->> 'max_history_messages')::integer not between 4 and 60 then
    raise exception 'Invalid max_history_messages' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'debounce_seconds') <> 'number' or (v_new ->> 'debounce_seconds') !~ '^[0-9]{1,3}$'
    or (v_new ->> 'debounce_seconds')::integer not between 1 and 20 then
    raise exception 'Invalid debounce_seconds' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'human_pause_minutes') <> 'number' or (v_new ->> 'human_pause_minutes') !~ '^[0-9]{1,4}$'
    or (v_new ->> 'human_pause_minutes')::integer not between 5 and 1440 then
    raise exception 'Invalid human_pause_minutes' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'simulate_typing') <> 'boolean' then
    raise exception 'Invalid simulate_typing' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'split_long_messages') <> 'boolean' then
    raise exception 'Invalid split_long_messages' using errcode = '22023';
  end if;
  if jsonb_typeof(v_new -> 'pause_on_human_reply') <> 'boolean' then
    raise exception 'Invalid pause_on_human_reply' using errcode = '22023';
  end if;

  insert into public.workspace_ai_settings as s (workspace_id, provider, fallback_provider,
    second_fallback_provider, gemini_model, openrouter_model, nvidia_model, temperature,
    max_history_messages, debounce_seconds, simulate_typing,
    split_long_messages, pause_on_human_reply, human_pause_minutes, updated_by)
  values (p_workspace_id, v_new ->> 'provider', v_new ->> 'fallback_provider',
    v_new ->> 'second_fallback_provider', v_new ->> 'gemini_model', v_new ->> 'openrouter_model',
    v_new ->> 'nvidia_model', round((v_new ->> 'temperature')::numeric, 2),
    (v_new ->> 'max_history_messages')::integer, (v_new ->> 'debounce_seconds')::integer,
    (v_new ->> 'simulate_typing')::boolean, (v_new ->> 'split_long_messages')::boolean,
    (v_new ->> 'pause_on_human_reply')::boolean, (v_new ->> 'human_pause_minutes')::integer, v_actor)
  on conflict (workspace_id) do update set
    provider = excluded.provider, fallback_provider = excluded.fallback_provider,
    second_fallback_provider = excluded.second_fallback_provider, gemini_model = excluded.gemini_model,
    openrouter_model = excluded.openrouter_model, nvidia_model = excluded.nvidia_model,
    temperature = excluded.temperature,
    max_history_messages = excluded.max_history_messages, debounce_seconds = excluded.debounce_seconds,
    simulate_typing = excluded.simulate_typing, split_long_messages = excluded.split_long_messages,
    pause_on_human_reply = excluded.pause_on_human_reply, human_pause_minutes = excluded.human_pause_minutes,
    updated_by = excluded.updated_by;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_settings_updated','workspace',p_workspace_id::text,
    jsonb_build_object('changed', p_settings));

  return public.read_my_ai_settings(p_workspace_id);
end;
$$;

-- 11) Ler uma conversa: vem junto como a IA está nela. E as mensagens do mesmo segundo ficam na ordem em que chegaram.
create or replace function public.read_my_conversation(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_message_limit integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_message_limit, 200), 1), 1000);
  v_conversation jsonb;
  v_messages jsonb;
  v_found integer;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', c.id, 'stage', c.stage, 'unread_count', c.unread_count, 'automation_paused', c.automation_paused,
    'created_at', c.created_at, 'last_message_at', c.last_message_at,
    'contact', jsonb_build_object('id', ct.id, 'display_name', ct.display_name, 'phone_e164', ct.phone_e164,
      'erased', ct.erased_at is not null, 'created_at', ct.created_at),
    'instance', jsonb_build_object('id', i.id, 'display_name', i.display_name, 'status', i.status, 'engine', i.engine),
    -- Como a IA está nesta conversa.
    'ai', jsonb_build_object(
      'chip_enabled', i.is_enabled,
      'workspace_paused', exists (select 1 from public.workspace_ai_state s where s.workspace_id = c.workspace_id and s.paused),
      'locked', c.automation_paused,
      'paused_until', case when not c.automation_paused and c.ai_paused_until > now() then c.ai_paused_until end,
      -- Por que a IA parou aqui da última vez (continua valendo como explicação mesmo depois de a pausa vencer).
      'pause_reason', c.ai_pause_reason,
      'handoff_at', c.ai_handoff_at,
      'handoff_note', c.ai_handoff_note,
      -- A IA está esperando o cliente terminar de escrever, ou escrevendo a resposta.
      'working', exists (
        select 1 from public.ai_turns t
        where t.workspace_id = c.workspace_id and t.conversation_id = c.id
          and ((t.status = 'waiting' and t.due_at > now() - interval '20 seconds')
            or (t.status = 'running' and t.claimed_at > now() - interval '3 minutes')))))
  into v_conversation
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  join public.instances i on i.workspace_id = c.workspace_id and i.id = c.instance_id
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id;
  if v_conversation is null then
    return null;
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) - 'rn' order by t.rn desc) filter (where t.rn <= v_limit), '[]'::jsonb), count(*)::integer
  into v_messages, v_found
  from (
    select m.id, m.direction, m.actor_type, m.status, m.body_text, m.occurred_at, m.created_at,
           (m.sent_by is not null) as from_panel,
           coalesce(m.sent_by = auth.uid(), false) as mine,
           (select jsonb_build_object('kind', a.kind, 'content_type', a.content_type, 'byte_size', a.byte_size,
                     'file_name', a.file_name, 'duration_seconds', a.duration_seconds, 'width', a.width,
                     'height', a.height, 'is_voice', a.is_voice, 'object_key', a.object_key,
                     'status', case when a.deletion_status in ('pending','deleted') then 'deleted'
                                    else a.storage_status end)
            from public.message_attachments a
            where a.workspace_id = m.workspace_id and a.message_id = m.id) as attachment,
           row_number() over (order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc) as rn
    from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = p_conversation_id
    order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc
    limit v_limit + 1
  ) t;

  return jsonb_build_object('conversation', v_conversation, 'messages', v_messages, 'has_more', v_found > v_limit);
end;
$$;

-- 12) Mudou alguma coisa? Agora o texto também muda quando a IA da empresa é pausada ou retomada.
create or replace function public.read_my_inbox_version(p_workspace_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case when private.is_workspace_member(p_workspace_id) then
    concat_ws('|',
      (select extract(epoch from max(c.updated_at))::text from public.conversations c where c.workspace_id = p_workspace_id),
      (select extract(epoch from max(i.updated_at))::text from public.instances i where i.workspace_id = p_workspace_id),
      (select coalesce(sum(c.unread_count), 0)::text from public.conversations c
        where c.workspace_id = p_workspace_id and c.unread_count > 0),
      (select extract(epoch from s.updated_at)::text from public.workspace_ai_state s where s.workspace_id = p_workspace_id))
  else '' end
$$;

-- 13) O que o servidor do painel usa para a IA responder. Nada disto é chamado por pessoas.

-- Pegar a vez. Só dá certo uma vez por vez: dois pedidos ao mesmo tempo, um ganha e o outro para.
--   claimed    -> a vez é deste pedido; vem junto tudo de que ele precisa para responder
--                 (configuração, chaves cifradas, base de treinamento e as últimas mensagens);
--   early      -> a espera ainda não acabou (falta wait_ms);
--   superseded -> chegou mensagem mais nova; quem cuida é o pedido dela;
--   busy       -> outra resposta desta conversa ainda está sendo enviada;
--   skipped    -> a IA não pode mais responder aqui (pausada, desligada, uma pessoa assumiu...);
--   handed_off -> limite de segurança: respostas demais em pouco tempo;
--   gone       -> a vez já foi tratada.
create or replace function public.claim_ai_turn(p_workspace_id uuid, p_turn_id uuid, p_trigger_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_turns%rowtype;
  v_reason text;
  v_settings jsonb;
  v_history integer;
  v_last_minute integer;
  v_last_hour integer;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_agent_id uuid;
  v_messages jsonb;
begin
  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id;
  if not found then return jsonb_build_object('result','gone'); end if;

  -- Trava primeiro a conversa e só depois a vez (a mesma ordem de quem recebe avisos e de quem envia).
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id
  for update;
  perform private.reap_ai_turns(p_workspace_id, v_turn.conversation_id);

  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id for update;
  if v_turn.status <> 'waiting' then
    return jsonb_build_object('result','gone','status',v_turn.status);
  end if;
  if p_trigger_message_id is not null and v_turn.trigger_message_id <> p_trigger_message_id then
    return jsonb_build_object('result','superseded');
  end if;
  if v_turn.due_at > clock_timestamp() then
    return jsonb_build_object('result','early',
      'wait_ms', greatest(ceil(extract(epoch from (v_turn.due_at - clock_timestamp())) * 1000)::integer, 1));
  end if;
  if exists (
    select 1 from public.ai_turns r
    where r.workspace_id = p_workspace_id and r.conversation_id = v_turn.conversation_id and r.status = 'running') then
    return jsonb_build_object('result','busy');
  end if;

  v_reason := private.ai_block_reason(p_workspace_id, v_turn.conversation_id);
  if v_reason is not null then
    update public.ai_turns set status = 'skipped', finished_at = clock_timestamp(), outcome_detail = v_reason
    where workspace_id = p_workspace_id and id = v_turn.id;
    update public.conversations set stage = 'waiting_human'
    where workspace_id = p_workspace_id and id = v_turn.conversation_id and stage = 'ai';
    return jsonb_build_object('result','skipped','reason',v_reason);
  end if;

  -- Limite de segurança: 6 respostas em um minuto ou 60 em uma hora na mesma conversa. Passou disso,
  -- provavelmente há um robô do outro lado; a IA para e uma pessoa olha.
  select count(*) filter (where t.claimed_at > clock_timestamp() - interval '1 minute'), count(*)
  into v_last_minute, v_last_hour
  from public.ai_turns t
  where t.workspace_id = p_workspace_id and t.conversation_id = v_turn.conversation_id
    and t.claimed_at > clock_timestamp() - interval '1 hour';
  if v_last_minute >= 6 or v_last_hour >= 60 then
    update public.ai_turns set status = 'handed_off', finished_at = clock_timestamp(), outcome_detail = 'rate_limit'
    where workspace_id = p_workspace_id and id = v_turn.id;
    perform private.hand_conversation_to_human(p_workspace_id, v_turn.conversation_id, 'safety',
      'A IA respondeu muitas vezes em pouco tempo nesta conversa e parou por segurança. Pode haver um robô do outro lado.',
      false);
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,null,'service','ai_safety_stop','conversation',v_turn.conversation_id::text,
      jsonb_build_object('turn',v_turn.id,'last_minute',v_last_minute,'last_hour',v_last_hour));
    return jsonb_build_object('result','handed_off','reason','rate_limit');
  end if;

  update public.ai_turns set status = 'running', claimed_at = clock_timestamp()
  where workspace_id = p_workspace_id and id = v_turn.id;

  v_settings := private.ai_settings_json(p_workspace_id);
  v_history := least(greatest(coalesce((v_settings ->> 'max_history_messages')::integer, 20), 4), 60);

  select i.* into v_instance from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_turn.instance_id;
  select ct.* into v_contact
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id;

  -- A base de treinamento do chip; sem uma própria, a padrão da empresa.
  select a.id into v_agent_id
  from public.ai_agents a
  where a.workspace_id = p_workspace_id
    and (a.id = v_instance.ai_agent_id or (v_instance.ai_agent_id is null and a.is_default));

  -- As últimas mensagens da conversa, da mais antiga para a mais nova. O que com certeza não saiu fica de fora.
  select coalesce(jsonb_agg(to_jsonb(t) - 'rn' order by t.rn desc), '[]'::jsonb) into v_messages
  from (
    select m.id, m.direction, m.actor_type, m.status, m.body_text, m.occurred_at,
           (select jsonb_build_object('kind', a.kind, 'content_type', a.content_type, 'byte_size', a.byte_size,
                     'file_name', a.file_name, 'is_voice', a.is_voice, 'object_key', a.object_key,
                     'status', case when a.deletion_status in ('pending','deleted') then 'deleted'
                                    else a.storage_status end)
            from public.message_attachments a
            where a.workspace_id = m.workspace_id and a.message_id = m.id) as attachment,
           row_number() over (order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc) as rn
    from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = v_turn.conversation_id
      and m.status not in ('failed','cancelled')
    order by date_trunc('second', m.occurred_at) desc, m.created_at desc, m.id desc
    limit v_history
  ) t;

  return jsonb_build_object(
    'result', 'claimed',
    'turn', jsonb_build_object('id', v_turn.id, 'conversation_id', v_turn.conversation_id,
      'trigger_message_id', v_turn.trigger_message_id),
    'settings', v_settings,
    -- As chaves seguem cifradas: quem abre é o servidor do painel, com o segredo que só ele tem.
    'keys', coalesce((select jsonb_object_agg(k.provider, k.ciphertext)
                      from private.workspace_ai_secrets k where k.workspace_id = p_workspace_id), '{}'::jsonb),
    'agent', case when v_agent_id is not null then private.ai_agent_json(p_workspace_id, v_agent_id, true) end,
    'conversation', jsonb_build_object('id', v_turn.conversation_id, 'contact_name', v_contact.display_name,
      'recipient', v_contact.external_user_id, 'provider_instance_name', v_instance.provider_instance_name),
    'messages', v_messages);
end;
$$;

-- Como está o arquivo de uma mensagem (a IA espera um pouco quando ele ainda está sendo trazido do WhatsApp).
create or replace function public.read_ai_attachment(p_workspace_id uuid, p_message_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('kind', a.kind, 'content_type', a.content_type, 'byte_size', a.byte_size,
    'file_name', a.file_name, 'is_voice', a.is_voice, 'object_key', a.object_key,
    'status', case when a.deletion_status in ('pending','deleted') then 'deleted' else a.storage_status end)
  from public.message_attachments a
  where a.workspace_id = p_workspace_id and a.message_id = p_message_id
$$;

-- Começar o envio de uma parte da resposta. Antes de gravar, confere de novo se a IA ainda pode responder:
-- uma pessoa pode ter respondido ou assumido, a IA pode ter sido pausada, ou o cliente pode ter escrito mais
-- (na primeira parte; aí esta resposta é abandonada e a vez mais nova responde tudo junto).
--   started        -> a mensagem está gravada como enviando; pode chamar a Evolution;
--   already_exists -> esta parte já tinha sido começada (nunca envia duas vezes);
--   aborted        -> não é mais para enviar; reason diz por quê (e next traz a vez mais nova, se houver).
create or replace function public.start_ai_message(p_workspace_id uuid, p_turn_id uuid, p_part integer, p_body_text text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_turns%rowtype;
  v_body text := private.trim_text(coalesce(p_body_text, ''));
  v_key text;
  v_message public.messages%rowtype;
  v_reason text;
  v_next public.ai_turns%rowtype;
  v_instance public.instances%rowtype;
  v_recipient text;
begin
  if p_part is null or p_part not between 1 and 5 then
    raise exception 'Invalid part' using errcode = '22023';
  end if;
  if char_length(v_body) not between 1 and 4096 then
    raise exception 'Invalid message text' using errcode = '22023';
  end if;

  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id;
  if not found then raise exception 'Turn not found' using errcode = 'P0002'; end if;
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id
  for update;
  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id for update;

  -- Uma chave por parte de cada vez: pedido repetido devolve o que já existe.
  v_key := 'ia-' || replace(v_turn.id::text, '-', '') || '-' || p_part::text;
  select m.* into v_message from public.messages m
  where m.workspace_id = p_workspace_id and m.idempotency_key = v_key;
  if found then
    return jsonb_build_object('result','already_exists','message_id',v_message.id,'status',v_message.status);
  end if;

  if v_turn.status <> 'running' then
    return jsonb_build_object('result','aborted','reason','turn_' || v_turn.status);
  end if;

  v_reason := private.ai_block_reason(p_workspace_id, v_turn.conversation_id);
  -- Uma pessoa está enviando uma resposta neste instante.
  if v_reason is null and exists (
    select 1 from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = v_turn.conversation_id
      and m.direction = 'outbound' and m.actor_type = 'human' and m.status = 'sending'
      and m.created_at > clock_timestamp() - interval '90 seconds') then
    v_reason := 'human_replying';
  end if;
  -- O cliente escreveu de novo enquanto a IA preparava a resposta.
  if v_reason is null and p_part = 1 then
    select w.* into v_next from public.ai_turns w
    where w.workspace_id = p_workspace_id and w.conversation_id = v_turn.conversation_id and w.status = 'waiting';
    if found then v_reason := 'superseded'; end if;
  end if;

  if v_reason is not null then
    update public.ai_turns
    set status = case when p_part = 1 then 'skipped' else 'answered' end,
        finished_at = clock_timestamp(),
        outcome_detail = left(case when p_part = 1 then v_reason
                                   else 'stopped_after_part_' || (p_part - 1)::text || ':' || v_reason end, 300)
    where workspace_id = p_workspace_id and id = v_turn.id;
    -- A IA não vai responder e ninguém respondeu: a conversa passa a esperar uma pessoa.
    if p_part = 1 and v_reason <> 'superseded' then
      update public.conversations set stage = 'waiting_human'
      where workspace_id = p_workspace_id and id = v_turn.conversation_id and stage = 'ai' and unread_count > 0;
    end if;
    return jsonb_build_object('result','aborted','reason',v_reason,
      'next', case when v_reason = 'superseded' then jsonb_build_object('turn_id', v_next.id,
        'trigger_message_id', v_next.trigger_message_id,
        'wait_ms', greatest(ceil(extract(epoch from (v_next.due_at - clock_timestamp())) * 1000)::integer, 0)) end);
  end if;

  select i.* into v_instance from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_turn.instance_id;
  select ct.external_user_id into v_recipient
  from public.conversations c
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id;

  insert into public.messages(workspace_id,conversation_id,instance_id,idempotency_key,direction,
    source_engine,actor_type,status,body_text,occurred_at)
  values (p_workspace_id,v_turn.conversation_id,v_turn.instance_id,v_key,'outbound',
    'evolution','ai','sending',v_body,clock_timestamp())
  returning * into v_message;

  return jsonb_build_object('result','started','message_id',v_message.id,
    'provider_instance_name',v_instance.provider_instance_name,'recipient',v_recipient);
end;
$$;

-- Contar como o envio de uma parte terminou (sent, failed ou uncertain). Usa o mesmo miolo dos envios das pessoas.
create or replace function public.finish_ai_message(
  p_workspace_id uuid,
  p_message_id uuid,
  p_outcome text,
  p_provider_message_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.messages m
  where m.workspace_id = p_workspace_id and m.id = p_message_id and m.direction = 'outbound' and m.actor_type = 'ai';
  if not found then raise exception 'Message not found' using errcode = 'P0002'; end if;
  return private.finish_outbound_message(p_workspace_id, p_message_id, p_outcome, p_provider_message_id, null, 'service');
end;
$$;

-- Fechar a vez, dizendo como terminou:
--   answered       -> respondeu;
--   silent         -> não havia o que responder;
--   handoff        -> a IA pediu para uma pessoa assumir (p_note é o recado dela);
--   silent_handoff -> a IA não entendeu a mensagem com segurança e não enviou nada;
--   uncertain_send -> não deu para confirmar se a resposta chegou (nunca reenvia);
--   failed         -> não conseguiu responder (p_note explica para a pessoa);
--   closed         -> despediu-se e encerrou a conversa;
--   opt_out        -> o contato pediu para parar: fica registrado que ele não quer mais mensagens.
-- p_lock = a IA só volta nesta conversa quando alguém devolver.
-- p_meta = {provider, model, duration_ms, tokens_in, tokens_out, attempts}.
create or replace function public.finish_ai_turn(
  p_workspace_id uuid,
  p_turn_id uuid,
  p_outcome text,
  p_detail text,
  p_note text,
  p_lock boolean,
  p_meta jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_turns%rowtype;
  v_meta jsonb := case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}'::jsonb end;
  v_status text;
  v_contact_id uuid;
  v_number text;
begin
  if p_outcome is null or p_outcome not in
    ('answered','silent','handoff','silent_handoff','uncertain_send','failed','closed','opt_out') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;

  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id;
  if not found then raise exception 'Turn not found' using errcode = 'P0002'; end if;
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id
  for update;
  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id for update;
  if v_turn.status <> 'running' then
    return jsonb_build_object('result','ignored','status',v_turn.status);
  end if;

  v_status := case p_outcome
    when 'answered' then 'answered'
    when 'silent' then 'silent'
    when 'failed' then 'failed'
    when 'closed' then 'closed'
    when 'opt_out' then 'closed'
    else 'handed_off' end;

  update public.ai_turns
  set status = v_status,
      finished_at = clock_timestamp(),
      outcome_detail = nullif(left(private.trim_text(coalesce(p_detail, '')), 300), ''),
      provider = case when v_meta ->> 'provider' in ('gemini','openrouter','nvidia') then v_meta ->> 'provider' end,
      model = nullif(left(coalesce(v_meta ->> 'model', ''), 160), ''),
      duration_ms = case when (v_meta ->> 'duration_ms') ~ '^[0-9]{1,9}$' then (v_meta ->> 'duration_ms')::integer end,
      tokens_in = case when (v_meta ->> 'tokens_in') ~ '^[0-9]{1,9}$' then (v_meta ->> 'tokens_in')::integer end,
      tokens_out = case when (v_meta ->> 'tokens_out') ~ '^[0-9]{1,9}$' then (v_meta ->> 'tokens_out')::integer end,
      attempts = case when jsonb_typeof(v_meta -> 'attempts') = 'array' and jsonb_array_length(v_meta -> 'attempts') <= 6
                      then v_meta -> 'attempts' else '[]'::jsonb end
  where workspace_id = p_workspace_id and id = v_turn.id;

  if p_outcome = 'silent' then
    -- A IA leu e não havia o que responder: a conversa não fica como pendente.
    update public.conversations set unread_count = 0
    where workspace_id = p_workspace_id and id = v_turn.conversation_id and stage = 'ai' and unread_count > 0;
  elsif p_outcome in ('handoff','silent_handoff','uncertain_send') then
    perform private.hand_conversation_to_human(p_workspace_id, v_turn.conversation_id, p_outcome, p_note,
      coalesce(p_lock, false) or p_outcome = 'silent_handoff');
  elsif p_outcome = 'failed' then
    perform private.hand_conversation_to_human(p_workspace_id, v_turn.conversation_id, 'error', p_note, false);
  elsif p_outcome in ('closed','opt_out') then
    update public.conversations
    set stage = 'resolved', automation_paused = true, unread_count = 0,
        ai_pause_reason = p_outcome, ai_paused_until = null,
        ai_handoff_at = clock_timestamp(),
        ai_handoff_note = nullif(left(private.trim_text(coalesce(p_note, '')), 600), '')
    where workspace_id = p_workspace_id and id = v_turn.conversation_id
    returning contact_id into v_contact_id;

    if p_outcome = 'opt_out' and v_contact_id is not null then
      -- O contato pediu para parar: isso vale para qualquer mensagem comercial futura (campanhas inclusive).
      insert into public.contact_consent_events(workspace_id,contact_id,purpose,action,source,evidence_reference,recorded_by,occurred_at)
      values (p_workspace_id,v_contact_id,'global','opted_out','ai_attendant',
        'message:' || v_turn.trigger_message_id::text,null,clock_timestamp());
      insert into public.contact_consent_state(workspace_id,contact_id,purpose,status,source,evidence_reference,occurred_at,updated_at)
      values (p_workspace_id,v_contact_id,'global','opted_out','ai_attendant',
        'message:' || v_turn.trigger_message_id::text,clock_timestamp(),clock_timestamp())
      on conflict (workspace_id,contact_id,purpose) do update
        set status = excluded.status, source = excluded.source, evidence_reference = excluded.evidence_reference,
            occurred_at = excluded.occurred_at, updated_at = excluded.updated_at;
      update public.contacts set consent_status = 'opted_out', consent_updated_at = clock_timestamp()
      where workspace_id = p_workspace_id and id = v_contact_id;
    end if;
  end if;

  -- Resposta comum não vai para a auditoria (seria uma linha por resposta); o que foge do comum, vai.
  if p_outcome not in ('answered','silent') then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,null,'service','ai_' || p_outcome,'conversation',v_turn.conversation_id::text,
      jsonb_build_object('turn',v_turn.id,'detail',nullif(left(coalesce(p_detail, ''), 300), '')));
  end if;

  return jsonb_build_object('result','finished','status',v_status);
end;
$$;

-- Arrumar o que ficou para trás na empresa e dizer quais vezes estão esperando sem dono
-- (a espera acabou há mais de 20 segundos e ninguém pegou), para o servidor responder agora.
create or replace function public.sweep_ai_turns(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reaped integer;
begin
  v_reaped := private.reap_ai_turns(p_workspace_id, null);
  return jsonb_build_object(
    'reaped', v_reaped,
    'orphans', coalesce((
      select jsonb_agg(jsonb_build_object('turn_id', t.id, 'trigger_message_id', t.trigger_message_id) order by t.due_at)
      from (
        select o.id, o.trigger_message_id, o.due_at
        from public.ai_turns o
        where o.workspace_id = p_workspace_id and o.status = 'waiting'
          and o.due_at < clock_timestamp() - interval '20 seconds'
        order by o.due_at
        limit 3
      ) t), '[]'::jsonb));
end;
$$;

revoke all on function public.claim_ai_turn(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.read_ai_attachment(uuid, uuid) from public, anon, authenticated;
revoke all on function public.start_ai_message(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.finish_ai_message(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.finish_ai_turn(uuid, uuid, text, text, text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.sweep_ai_turns(uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_turn(uuid, uuid, uuid) to service_role;
grant execute on function public.read_ai_attachment(uuid, uuid) to service_role;
grant execute on function public.start_ai_message(uuid, uuid, integer, text) to service_role;
grant execute on function public.finish_ai_message(uuid, uuid, text, text) to service_role;
grant execute on function public.finish_ai_turn(uuid, uuid, text, text, text, boolean, jsonb) to service_role;
grant execute on function public.sweep_ai_turns(uuid) to service_role;

-- 14) O que as pessoas usam.

-- Ligar ou desligar a IA num chip (só o dono). Para ligar, a empresa precisa ter a chave do provedor
-- principal e uma base de treinamento: sem isso a IA não teria como responder.
create or replace function public.set_my_instance_ai(p_workspace_id uuid, p_instance_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_instance public.instances%rowtype;
  v_missing text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'Invalid value' using errcode = '22023';
  end if;

  select i.* into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = p_instance_id and i.status <> 'revoked'
  for update;
  if not found then raise exception 'Instance not found' using errcode = 'P0002'; end if;

  if v_instance.is_enabled = p_enabled then
    return jsonb_build_object('id', v_instance.id, 'is_enabled', v_instance.is_enabled, 'changed', false);
  end if;

  if p_enabled then
    if v_instance.engine <> 'evolution' then
      raise exception 'instance_unavailable' using errcode = 'P0001';
    end if;
    v_missing := private.ai_missing_setup(p_workspace_id, p_instance_id);
    if v_missing is not null then
      raise exception '%', v_missing using errcode = 'P0001';
    end if;
  else
    -- As conversas que a IA ia responder agora neste chip passam a esperar uma pessoa.
    perform 1 from public.conversations c
    where c.workspace_id = p_workspace_id
      and c.id in (select t.conversation_id from public.ai_turns t
                   where t.workspace_id = p_workspace_id and t.instance_id = p_instance_id and t.status = 'waiting')
    order by c.id
    for update;
    with cancelled as (
      update public.ai_turns
      set status = 'skipped', finished_at = clock_timestamp(), outcome_detail = 'chip_ai_off'
      where workspace_id = p_workspace_id and instance_id = p_instance_id and status = 'waiting'
      returning conversation_id
    )
    update public.conversations c set stage = 'waiting_human'
    from cancelled x
    where c.workspace_id = p_workspace_id and c.id = x.conversation_id and c.stage = 'ai';
  end if;

  update public.instances set is_enabled = p_enabled
  where workspace_id = p_workspace_id and id = p_instance_id
  returning * into v_instance;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner',case when p_enabled then 'instance_ai_enabled' else 'instance_ai_disabled' end,
    'instance',v_instance.id::text,jsonb_build_object('display_name',v_instance.display_name));

  return jsonb_build_object('id', v_instance.id, 'is_enabled', v_instance.is_enabled, 'changed', true);
end;
$$;

-- Pausar tudo: qualquer pessoa ativa da empresa pode parar a IA (parar é sempre seguro).
create or replace function public.pause_my_ai(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_was_paused boolean;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select m.role into v_role
  from public.workspace_memberships m
  where m.workspace_id = p_workspace_id and m.user_id = v_actor and m.status = 'active';
  if v_role is null then raise exception 'Workspace membership required' using errcode = '42501'; end if;

  select s.paused into v_was_paused from public.workspace_ai_state s where s.workspace_id = p_workspace_id for update;
  if coalesce(v_was_paused, false) then
    return jsonb_build_object('paused', true, 'changed', false);
  end if;

  insert into public.workspace_ai_state(workspace_id, paused, paused_at, paused_by)
  values (p_workspace_id, true, clock_timestamp(), v_actor)
  on conflict (workspace_id) do update set paused = true, paused_at = excluded.paused_at, paused_by = excluded.paused_by;

  -- As conversas que a IA ia responder agora passam a esperar uma pessoa.
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id
    and c.id in (select t.conversation_id from public.ai_turns t
                 where t.workspace_id = p_workspace_id and t.status = 'waiting')
  order by c.id
  for update;
  with cancelled as (
    update public.ai_turns
    set status = 'skipped', finished_at = clock_timestamp(), outcome_detail = 'workspace_paused'
    where workspace_id = p_workspace_id and status = 'waiting'
    returning conversation_id
  )
  update public.conversations c set stage = 'waiting_human'
  from cancelled x
  where c.workspace_id = p_workspace_id and c.id = x.conversation_id and c.stage = 'ai';

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,v_role,'ai_paused_all','workspace',p_workspace_id::text,'{}'::jsonb);

  return jsonb_build_object('paused', true, 'changed', true);
end;
$$;

-- Retomar: só o dono.
create or replace function public.resume_my_ai(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_was_paused boolean;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;

  select s.paused into v_was_paused from public.workspace_ai_state s where s.workspace_id = p_workspace_id for update;
  if not coalesce(v_was_paused, false) then
    return jsonb_build_object('paused', false, 'changed', false);
  end if;

  update public.workspace_ai_state
  set paused = false, resumed_at = clock_timestamp(), resumed_by = v_actor
  where workspace_id = p_workspace_id;

  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','ai_resumed_all','workspace',p_workspace_id::text,'{}'::jsonb);

  return jsonb_build_object('paused', false, 'changed', true);
end;
$$;

-- O resumo da IA da empresa, para o topo do painel, a Visão geral e a aba Instâncias.
-- O painel pede este resumo a cada tela que abre; a função aproveita para arrumar o que tiver ficado para
-- trás (resposta interrompida, vez esquecida): assim, uma conversa que a IA deixou sem resposta aparece
-- para a equipe em Esperando você assim que alguém abre o painel, mesmo sem nenhum aviso novo da Evolution.
create or replace function public.read_my_ai_overview(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner boolean;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  v_owner := private.is_workspace_owner(p_workspace_id);
  perform private.reap_ai_turns(p_workspace_id, null);

  return jsonb_build_object(
    'paused', coalesce((select s.paused from public.workspace_ai_state s where s.workspace_id = p_workspace_id), false),
    'paused_at', (select s.paused_at from public.workspace_ai_state s where s.workspace_id = p_workspace_id and s.paused),
    -- Qualquer pessoa da empresa pausa; só o dono retoma e liga a IA nos chips.
    'can_resume', v_owner,
    'can_switch_chips', v_owner,
    -- O que falta para poder ligar a IA: ai_key_missing, ai_training_missing ou vazio.
    'missing', private.ai_missing_setup(p_workspace_id, null),
    'chips_enabled', (select count(*) from public.instances i
                      where i.workspace_id = p_workspace_id and i.status <> 'revoked' and i.is_enabled),
    'chips_answering', (select count(*) from public.instances i
                        where i.workspace_id = p_workspace_id and i.status = 'connected' and i.is_enabled));
end;
$$;

revoke all on function public.set_my_instance_ai(uuid, uuid, boolean) from public, anon;
revoke all on function public.pause_my_ai(uuid) from public, anon;
revoke all on function public.resume_my_ai(uuid) from public, anon;
revoke all on function public.read_my_ai_overview(uuid) from public, anon;
grant execute on function public.set_my_instance_ai(uuid, uuid, boolean) to authenticated;
grant execute on function public.pause_my_ai(uuid) to authenticated;
grant execute on function public.resume_my_ai(uuid) to authenticated;
grant execute on function public.read_my_ai_overview(uuid) to authenticated;

commit;
