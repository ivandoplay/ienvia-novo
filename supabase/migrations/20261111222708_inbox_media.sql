begin;

-- Fase 1 (Inbox), terceira parte: fotos, áudios, vídeos, documentos e figurinhas.
-- Os arquivos ficam num depósito fechado do Supabase Storage (midias); o banco guarda só a ficha de cada um.
-- Caminho de um arquivo: <empresa>/<conversa>/<mensagem>/<nome>  (recebidos)
--                        <empresa>/<conversa>/envios/<chave do envio>/<nome>  (enviados pelo painel)

-- 1) Depósito fechado, com limite de 25 MB por arquivo.
insert into storage.buckets (id, name, public, file_size_limit)
values ('midias', 'midias', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

-- 2) Ficha do arquivo: tipo, nome, duração, tamanho da imagem e se já está guardado.
alter table public.message_attachments
  add column kind text not null default 'document' check (kind in ('image','audio','video','document','sticker')),
  add column file_name text check (file_name is null or char_length(file_name) between 1 and 200),
  add column duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 86400),
  add column width integer check (width is null or width between 1 and 20000),
  add column height integer check (height is null or height between 1 and 20000),
  add column is_voice boolean not null default false,
  add column storage_status text not null default 'stored' check (storage_status in ('pending','stored','failed','too_large')),
  add column attempts integer not null default 0 check (attempts >= 0),
  add column last_attempt_at timestamptz;
-- Uma mensagem do WhatsApp leva no máximo um arquivo.
create unique index message_attachments_message_uq on public.message_attachments(workspace_id, message_id);

-- 3) Quem pode ler e enviar arquivos. A empresa é sempre a primeira pasta do caminho.
create or replace function private.media_object_workspace(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end
$$;

create or replace function private.can_read_media_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_workspace_member(private.media_object_workspace(p_name))
$$;

-- Envio pelo painel: só na pasta envios de uma conversa da própria empresa.
create or replace function private.can_upload_media_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/envios/[a-zA-Z0-9_-]{16,80}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and exists (
      select 1
      from public.conversations c
      join public.workspace_memberships m
        on m.workspace_id = c.workspace_id and m.user_id = auth.uid() and m.status = 'active'
      where c.workspace_id = private.media_object_workspace(p_name)
        and c.id::text = split_part(p_name, '/', 2)
    )
$$;

revoke all on function private.media_object_workspace(text) from public, anon;
revoke all on function private.can_read_media_object(text) from public, anon;
revoke all on function private.can_upload_media_object(text) from public, anon;
grant execute on function private.media_object_workspace(text) to authenticated;
grant execute on function private.can_read_media_object(text) to authenticated;
grant execute on function private.can_upload_media_object(text) to authenticated;

create policy ienvia_midias_ler on storage.objects for select to authenticated
  using (bucket_id = 'midias' and private.can_read_media_object(name));
create policy ienvia_midias_enviar on storage.objects for insert to authenticated
  with check (bucket_id = 'midias' and private.can_upload_media_object(name));

-- 4) Texto curto que representa a mensagem na lista de conversas.
create or replace function private.message_preview(p_body text, p_kind text, p_is_voice boolean, p_file_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(case
    when p_kind is null then coalesce(p_body, '')
    else (case p_kind
            when 'image' then '📷 Foto'
            when 'video' then '🎥 Vídeo'
            when 'audio' then case when p_is_voice then '🎤 Áudio' else '🎵 Áudio' end
            when 'sticker' then 'Figurinha'
            else '📄 ' || coalesce(nullif(btrim(p_file_name), ''), 'Documento')
          end)
      || case when nullif(btrim(coalesce(p_body, '')), '') is not null then ': ' || btrim(p_body) else '' end
  end, 300)
$$;
revoke all on function private.message_preview(text,text,boolean,text) from public, anon, authenticated;

-- Até quando o arquivo fica guardado: o prazo de cada empresa (30 dias se ela não definiu outro).
-- A limpeza em si ainda não existe; a data já fica anotada para quando existir.
create or replace function private.media_keep_until(p_workspace_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select now() + make_interval(days => coalesce(
    (select p.media_retention_days from public.workspace_data_policies p where p.workspace_id = p_workspace_id), 30))
$$;
revoke all on function private.media_keep_until(uuid) from public, anon, authenticated;

-- Nome de arquivo seguro para o depósito: só letras sem acento, números, ponto, traço e sublinhado,
-- sempre começando por letra ou número.
create or replace function private.safe_object_name(p_file_name text, p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    nullif(left(btrim(regexp_replace(lower(coalesce(p_file_name, '')), '[^a-z0-9._-]+', '-', 'g'), '-._'), 100), ''),
    case p_kind when 'image' then 'foto' when 'video' then 'video' when 'audio' then 'audio'
                when 'sticker' then 'figurinha' else 'documento' end)
$$;
revoke all on function private.safe_object_name(text,text) from public, anon, authenticated;

-- 5) Receber da Evolution, agora também com arquivo. p_media (quando houver):
--    { kind, mime, size, file_name, duration, width, height, voice }
--    O texto (p_body_text) passa a ser a legenda e pode vir vazio quando há arquivo.
--    A mensagem nasce com a ficha do arquivo como pendente: quem busca o arquivo na Evolution e guarda
--    no depósito é o painel, logo depois (begin_media_download / complete_media_download).
--    Ficha com tipo estranho vira documento: a mensagem do cliente nunca se perde por um detalhe do arquivo.
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
      returning m.id into v_message_id;
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
    perform private.touch_conversation_after_outbound(v_workspace_id, v_conversation_id, v_preview, p_occurred_at);
  else
    update public.conversations
    set last_message_preview = case when last_message_at is null or p_occurred_at >= last_message_at
                                    then v_preview else last_message_preview end,
        last_message_at = greatest(coalesce(last_message_at,p_occurred_at),p_occurred_at),
        unread_count = unread_count + 1,
        stage = case when stage = 'waiting_customer' then 'human' else stage end
    where workspace_id = v_workspace_id and id = v_conversation_id;
  end if;

  update public.webhook_events set processing_status = 'processed', processed_at = now() where id = v_webhook_event_id;

  return jsonb_build_object('result','accepted','workspace_id',v_workspace_id,
    'instance_id',v_instance_id,'contact_id',v_contact_id,'conversation_id',v_conversation_id,
    'message_id',v_message_id,'direction',case when p_from_me then 'outbound' else 'inbound' end,'adopted',v_adopted,
    'media',case when v_media_status is not null
                 then jsonb_build_object('object_key',v_object_key,'status',v_media_status) end);
end;
$$;

-- A função antiga (só texto) continua existindo e passa a chamar a nova.
create or replace function private.ingest_evolution_text(
  p_instance_name text,
  p_token_sha256 text,
  p_event_id text,
  p_event_type text,
  p_sender_jid text,
  p_push_name text,
  p_body_text text,
  p_occurred_at timestamptz,
  p_from_me boolean
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.ingest_evolution_message(p_instance_name,p_token_sha256,p_event_id,p_event_type,p_sender_jid,
    p_push_name,p_body_text,p_occurred_at,p_from_me,null::jsonb)
$$;

create or replace function public.ingest_evolution_message(
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
language sql
security definer
set search_path = ''
as $$
  select private.ingest_evolution_message(p_instance_name,p_token_sha256,p_event_id,p_event_type,p_sender_jid,
    p_push_name,p_body_text,p_occurred_at,p_from_me,p_media)
$$;
revoke all on function private.ingest_evolution_message(text,text,text,text,text,text,text,timestamptz,boolean,jsonb) from public, anon, authenticated;
revoke all on function public.ingest_evolution_message(text,text,text,text,text,text,text,timestamptz,boolean,jsonb) from public, anon, authenticated;
grant execute on function private.ingest_evolution_message(text,text,text,text,text,text,text,timestamptz,boolean,jsonb) to service_role;
grant execute on function public.ingest_evolution_message(text,text,text,text,text,text,text,timestamptz,boolean,jsonb) to service_role;

-- 6) Buscar o arquivo na Evolution: só o servidor do painel (service_role) chama.
--    begin: reserva a vez (para dois pedidos não baixarem o mesmo arquivo juntos) e diz de onde baixar.
create or replace function public.begin_media_download(p_workspace_id uuid, p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attachment public.message_attachments%rowtype;
  v_target jsonb;
begin
  select a.* into v_attachment
  from public.message_attachments a
  where a.workspace_id = p_workspace_id and a.message_id = p_message_id
  for update;
  if not found then return jsonb_build_object('claimed', false, 'reason', 'not_found'); end if;
  if v_attachment.storage_status not in ('pending','failed') then
    return jsonb_build_object('claimed', false, 'reason', v_attachment.storage_status);
  end if;
  -- Pendente e tentado há pouco: outro pedido está baixando agora.
  if v_attachment.storage_status = 'pending' and v_attachment.last_attempt_at is not null
    and v_attachment.last_attempt_at > now() - interval '90 seconds' then
    return jsonb_build_object('claimed', false, 'reason', 'in_progress');
  end if;

  select jsonb_build_object('claimed', true, 'object_key', v_attachment.object_key, 'kind', v_attachment.kind,
    'content_type', v_attachment.content_type, 'provider_instance_name', i.provider_instance_name,
    'provider_message_id', m.provider_message_id, 'remote_jid', ct.external_user_id,
    'from_me', m.direction = 'outbound')
  into v_target
  from public.messages m
  join public.conversations c on c.workspace_id = m.workspace_id and c.id = m.conversation_id
  join public.contacts ct on ct.workspace_id = c.workspace_id and ct.id = c.contact_id
  join public.instances i on i.workspace_id = m.workspace_id and i.id = m.instance_id
  where m.workspace_id = p_workspace_id and m.id = p_message_id
    and m.provider_message_id is not null and i.provider_instance_name is not null
    and i.engine = 'evolution' and i.status <> 'revoked';
  if v_target is null then return jsonb_build_object('claimed', false, 'reason', 'unavailable'); end if;

  update public.message_attachments
  set storage_status = 'pending', attempts = attempts + 1, last_attempt_at = now()
  where workspace_id = p_workspace_id and id = v_attachment.id;
  return v_target;
end;
$$;

--    complete: conta como terminou (stored = guardado; failed = não deu; too_large = grande demais).
create or replace function public.complete_media_download(
  p_workspace_id uuid,
  p_message_id uuid,
  p_outcome text,
  p_content_type text,
  p_byte_size bigint,
  p_sha256_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_status text;
begin
  if p_outcome is null or p_outcome not in ('stored','failed','too_large') then
    raise exception 'Invalid outcome' using errcode = '22023';
  end if;
  if p_outcome = 'stored' and (p_byte_size is null or p_byte_size < 0 or p_byte_size > 26214400) then
    raise exception 'Invalid byte size' using errcode = '22023';
  end if;
  if p_sha256_hex is not null and p_sha256_hex !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid digest' using errcode = '22023';
  end if;

  update public.message_attachments a
  set storage_status = p_outcome,
      content_type = case when p_outcome = 'stored' and lower(coalesce(p_content_type, '')) ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'
                          then lower(p_content_type) else a.content_type end,
      byte_size = case when p_outcome = 'stored' then p_byte_size else a.byte_size end,
      sha256_hex = case when p_outcome = 'stored' then p_sha256_hex else a.sha256_hex end
  where a.workspace_id = p_workspace_id and a.message_id = p_message_id
    and a.storage_status in ('pending','failed')
  returning a.storage_status into v_status;
  if v_status is null then
    return jsonb_build_object('changed', false);
  end if;

  -- Nada muda na conversa; é só para as telas abertas perceberem que o arquivo chegou (ou não).
  select m.conversation_id into v_conversation_id
  from public.messages m where m.workspace_id = p_workspace_id and m.id = p_message_id;
  update public.conversations set updated_at = now()
  where workspace_id = p_workspace_id and id = v_conversation_id;

  return jsonb_build_object('changed', true, 'status', v_status);
end;
$$;

revoke all on function public.begin_media_download(uuid,uuid) from public, anon, authenticated;
revoke all on function public.complete_media_download(uuid,uuid,text,text,bigint,text) from public, anon, authenticated;
grant execute on function public.begin_media_download(uuid,uuid) to service_role;
grant execute on function public.complete_media_download(uuid,uuid,text,text,bigint,text) to service_role;

-- 7) Começar o envio de um arquivo pelo painel. O arquivo já foi colocado no depósito pelo navegador
--    (na pasta envios da conversa); aqui o banco confere que ele existe e cria a mensagem como enviando.
--    Foto, vídeo e áudio: até 16 MB. Documento: até 25 MB. Áudio sai como mensagem de voz.
create or replace function public.start_my_media_message(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_idempotency_key text,
  p_object_key text,
  p_kind text,
  p_file_name text,
  p_caption text,
  p_duration_seconds integer,
  p_width integer,
  p_height integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_caption text := nullif(btrim(coalesce(p_caption, '')), '');
  v_file_name text := nullif(left(btrim(coalesce(p_file_name, '')), 200), '');
  v_conversation public.conversations%rowtype;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_message public.messages%rowtype;
  v_attachment public.message_attachments%rowtype;
  v_metadata jsonb;
  v_size bigint;
  v_mime text;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[a-zA-Z0-9_-]{16,80}$' then
    raise exception 'Invalid idempotency key' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('image','audio','video','document') then
    raise exception 'Invalid media kind' using errcode = '22023';
  end if;
  if coalesce(char_length(v_caption), 0) > 1024 or (p_kind = 'audio' and v_caption is not null) then
    raise exception 'Invalid caption' using errcode = '22023';
  end if;

  -- Trava a conversa: dois envios ao mesmo tempo entram em fila, um depois do outro.
  select c.* into v_conversation
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id
  for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;

  -- Pedido repetido: devolve o que já existe. Nunca cria a segunda mensagem.
  select m.* into v_message
  from public.messages m
  where m.workspace_id = p_workspace_id and m.idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', true);
  end if;

  if v_conversation.stage in ('resolved','archived') then
    raise exception 'conversation_closed' using errcode = 'P0001';
  end if;

  select i.* into v_instance
  from public.instances i
  where i.workspace_id = p_workspace_id and i.id = v_conversation.instance_id;
  if not found or v_instance.engine <> 'evolution' or v_instance.status = 'revoked'
    or v_instance.provider_instance_name is null then
    raise exception 'instance_unavailable' using errcode = 'P0001';
  end if;
  if v_instance.status <> 'connected' then
    raise exception 'instance_not_connected' using errcode = 'P0001';
  end if;

  select ct.* into v_contact
  from public.contacts ct
  where ct.workspace_id = p_workspace_id and ct.id = v_conversation.contact_id;
  if not found or v_contact.erased_at is not null or v_contact.external_user_id is null
    or v_contact.external_user_id !~ '^[1-9][0-9]{5,19}@s[.]whatsapp[.]net$' then
    raise exception 'contact_unreachable' using errcode = 'P0001';
  end if;

  -- O arquivo tem de estar exatamente na pasta deste envio, e já no depósito.
  if p_object_key is null
    or p_object_key !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/envios/[a-zA-Z0-9_-]{16,80}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    or not starts_with(p_object_key,
         p_workspace_id::text || '/' || p_conversation_id::text || '/envios/' || p_idempotency_key || '/') then
    raise exception 'Invalid media path' using errcode = '22023';
  end if;
  select o.metadata into v_metadata
  from storage.objects o
  where o.bucket_id = 'midias' and o.name = p_object_key;
  if not found then raise exception 'media_not_uploaded' using errcode = 'P0001'; end if;

  v_size := case when (v_metadata ->> 'size') ~ '^[0-9]{1,15}$' then (v_metadata ->> 'size')::bigint else 0 end;
  v_mime := lower(left(split_part(coalesce(v_metadata ->> 'mimetype', ''), ';', 1), 120));
  if v_mime !~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' then v_mime := 'application/octet-stream'; end if;
  if v_size < 1 then
    raise exception 'media_empty' using errcode = 'P0001';
  end if;
  if v_size > (case when p_kind = 'document' then 26214400 else 16777216 end) then
    raise exception 'media_too_large' using errcode = 'P0001';
  end if;
  -- Foto, vídeo e áudio só nos formatos que o WhatsApp mostra; o resto vai como documento.
  if (p_kind = 'image' and v_mime not in ('image/jpeg','image/png','image/webp'))
    or (p_kind = 'video' and v_mime <> 'video/mp4')
    or (p_kind = 'audio' and v_mime !~ '^audio/') then
    raise exception 'media_type_mismatch' using errcode = 'P0001';
  end if;

  insert into public.messages(workspace_id,conversation_id,instance_id,idempotency_key,direction,
    source_engine,actor_type,status,body_text,media_object_key,occurred_at,sent_by)
  values (p_workspace_id,p_conversation_id,v_instance.id,p_idempotency_key,'outbound',
    'evolution','human','sending',v_caption,p_object_key,now(),v_actor)
  returning * into v_message;

  insert into public.message_attachments(workspace_id,message_id,object_key,content_type,byte_size,kind,
    file_name,duration_seconds,width,height,is_voice,storage_status,retention_delete_after)
  values (p_workspace_id,v_message.id,p_object_key,v_mime,v_size,p_kind,v_file_name,
    case when p_duration_seconds between 0 and 86400 then p_duration_seconds end,
    case when p_width between 1 and 20000 then p_width end,
    case when p_height between 1 and 20000 then p_height end,
    p_kind = 'audio','stored',private.media_keep_until(p_workspace_id))
  returning * into v_attachment;

  return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'already_exists', false,
    'provider_instance_name', v_instance.provider_instance_name, 'recipient', v_contact.external_user_id,
    'object_key', p_object_key, 'kind', p_kind, 'content_type', v_mime, 'byte_size', v_size,
    'file_name', v_file_name, 'caption', v_caption);
end;
$$;
revoke all on function public.start_my_media_message(uuid,uuid,text,text,text,text,text,integer,integer,integer) from public, anon;
grant execute on function public.start_my_media_message(uuid,uuid,text,text,text,text,text,integer,integer,integer) to authenticated;

-- 8) Contar como o envio terminou: igual à versão anterior, com duas diferenças para mensagens com arquivo:
--    a lista de conversas mostra o tipo do arquivo (Foto, Áudio...) e, ao juntar um eco repetido, a ficha
--    do arquivo repetido sai junto.
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
  v_conversation_id uuid;
  v_message public.messages%rowtype;
  v_other public.messages%rowtype;
  v_attachment public.message_attachments%rowtype;
  v_previous_status text;
  v_new_status text;
  v_provider_id text := p_provider_message_id;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select m.role into v_role
  from public.workspace_memberships m
  where m.workspace_id = p_workspace_id and m.user_id = v_actor and m.status = 'active';
  if v_role is null then raise exception 'Workspace membership required' using errcode = '42501'; end if;
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
    perform private.touch_conversation_after_outbound(p_workspace_id, v_conversation_id,
      private.message_preview(v_message.body_text, v_attachment.kind, v_attachment.is_voice, v_attachment.file_name),
      v_message.occurred_at);
  else
    -- Nada muda na conversa; é só para as telas abertas perceberem que a mensagem mudou.
    update public.conversations set updated_at = now()
    where workspace_id = p_workspace_id and id = v_conversation_id;
  end if;

  -- Envio comum que deu certo não vai para a auditoria (seria uma linha por mensagem).
  if v_new_status <> 'sent' or v_previous_status = 'awaiting_human_confirmation' then
    insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
    values (p_workspace_id,v_actor,v_role,'message_send_' || p_outcome,'message',v_message.id::text,
      jsonb_build_object('from',v_previous_status,'to',v_new_status));
  end if;

  return jsonb_build_object('message_id', v_message.id, 'status', v_message.status, 'changed', true);
end;
$$;

-- 9) A conversa aberta passa a trazer a ficha do arquivo de cada mensagem (attachment), no lugar de has_media.
--    status: pending (ainda buscando), stored (guardado), failed (não deu para buscar), too_large (grande demais
--    para guardar) ou deleted (já apagado pelo prazo de guarda).
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
    'instance', jsonb_build_object('id', i.id, 'display_name', i.display_name, 'status', i.status, 'engine', i.engine))
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
           row_number() over (order by m.occurred_at desc, m.created_at desc, m.id desc) as rn
    from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = p_conversation_id
    order by m.occurred_at desc, m.created_at desc, m.id desc
    limit v_limit + 1
  ) t;

  return jsonb_build_object('conversation', v_conversation, 'messages', v_messages, 'has_more', v_found > v_limit);
end;
$$;

commit;
