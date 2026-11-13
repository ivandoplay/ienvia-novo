-- Fase 6: Catálogo de Produtos (até 5 fotos/PDFs + link HTTPS), PIX EMV/QR Code,
-- Biblioteca de Áudios Estratégicos (PTT + transcrição + anti-repetição), Simulador isolado e integração com Inbox e Atendente de IA.

begin;

-- =============================================================================================
-- 1. Tabelas principais: PIX, Catálogo (+ arquivos), Áudios Estratégicos e Simulador
-- =============================================================================================

create table public.workspace_pix_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  enabled boolean not null default false,
  key_type text not null default 'aleatoria'
    check (key_type in ('cnpj','cpf','celular','email','aleatoria')),
  pix_key text not null default ''
    check (char_length(pix_key) <= 200),
  receiver_name text not null default ''
    check (char_length(receiver_name) <= 200),
  bank_name text not null default ''
    check (char_length(bank_name) <= 200),
  city text not null default 'BRASIL'
    check (char_length(city) <= 80),
  send_qr_image boolean not null default true,
  include_copy_paste boolean not null default true,
  instructions text not null default ''
    check (char_length(instructions) <= 2000),
  updated_at timestamptz not null default now(),
  constraint workspace_pix_settings_enabled_key_check
    check (not enabled or char_length(btrim(pix_key)) > 0)
);

alter table public.workspace_pix_settings enable row level security;
revoke all on public.workspace_pix_settings from anon, authenticated;
grant select on public.workspace_pix_settings to authenticated;
grant all on public.workspace_pix_settings to service_role;

create policy workspace_pix_settings_select_member on public.workspace_pix_settings
  for select to authenticated using (private.is_workspace_member(workspace_id));

create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  category text not null default 'Produto' check (char_length(category) <= 100),
  price text not null default '' check (char_length(price) <= 200),
  description text not null default '' check (char_length(description) <= 12000),
  payment_link text not null default '' check (
    char_length(payment_link) <= 2000
    and (
      payment_link = ''
      or (
        payment_link ~ '^https://'
        and position('@' in split_part(substr(payment_link, 9), '/', 1)) = 0
      )
    )
  ),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create index catalog_items_ws_idx
  on public.catalog_items(workspace_id, sort_order, created_at desc, id desc);

alter table public.catalog_items enable row level security;
revoke all on public.catalog_items from anon, authenticated;
grant select on public.catalog_items to authenticated;
grant all on public.catalog_items to service_role;

create policy catalog_items_select_member on public.catalog_items
  for select to authenticated using (private.is_workspace_member(workspace_id));

create table public.catalog_item_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  item_id uuid not null,
  object_key text not null unique,
  file_name text not null check (char_length(btrim(file_name)) between 1 and 240),
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp','image/gif','application/pdf')),
  byte_size integer not null check (byte_size between 1 and 26214400),
  sort_order integer not null default 0 check (sort_order between 0 and 4),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, item_id) references public.catalog_items(workspace_id, id) on delete cascade
);

create index catalog_item_files_item_idx
  on public.catalog_item_files(workspace_id, item_id, sort_order, created_at);

alter table public.catalog_item_files enable row level security;
revoke all on public.catalog_item_files from anon, authenticated;
grant select on public.catalog_item_files to authenticated;
grant all on public.catalog_item_files to service_role;

create policy catalog_item_files_select_member on public.catalog_item_files
  for select to authenticated using (private.is_workspace_member(workspace_id));

create table public.voice_library_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  transcription text not null check (char_length(btrim(transcription)) between 1 and 16000),
  when_to_use text not null default '' check (char_length(when_to_use) <= 4000),
  linked_message_code text not null default '' check (char_length(linked_message_code) <= 100),
  ai_enabled boolean not null default true,
  object_key text not null unique,
  file_name text not null check (char_length(btrim(file_name)) between 1 and 240),
  content_type text not null check (
    content_type in ('audio/ogg','audio/ogg; codecs=opus','audio/mpeg','audio/mp4','audio/wav','audio/webm','audio/aac')
  ),
  byte_size integer not null check (byte_size between 1 and 16777216),
  duration_sec integer check (duration_sec is null or (duration_sec >= 0 and duration_sec <= 3600)),
  waveform integer[] not null default array[]::integer[]
    check (cardinality(waveform) = 0 or cardinality(waveform) = 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create index voice_library_items_ws_idx
  on public.voice_library_items(workspace_id, created_at desc, id desc);

alter table public.voice_library_items enable row level security;
revoke all on public.voice_library_items from anon, authenticated;
grant select on public.voice_library_items to authenticated;
grant all on public.voice_library_items to service_role;

create policy voice_library_items_select_member on public.voice_library_items
  for select to authenticated using (private.is_workspace_member(workspace_id));

create table public.simulator_sessions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid null,
  history jsonb not null default '[]'::jsonb
    check (jsonb_typeof(history) = 'array' and jsonb_array_length(history) <= 40),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (workspace_id, agent_id) references public.ai_agents(workspace_id, id) on delete set null
);

alter table public.simulator_sessions enable row level security;
revoke all on public.simulator_sessions from anon, authenticated;
grant select on public.simulator_sessions to authenticated;
grant all on public.simulator_sessions to service_role;

create policy simulator_sessions_select_own on public.simulator_sessions
  for select to authenticated
  using (private.is_workspace_member(workspace_id) and user_id = auth.uid());

-- Rastreio de áudio estratégico já enviado na conversa (evita repetição pelo atendente de IA).
alter table public.messages
  add column sent_voice_id uuid references public.voice_library_items(id) on delete set null;

create index messages_conv_sent_voice_idx
  on public.messages(workspace_id, conversation_id, sent_voice_id)
  where sent_voice_id is not null;

-- Recursos compartilháveis (Catálogo, Áudios Estratégicos, Campanhas) podem usar o mesmo object_key
-- em várias mensagens diferentes do mesmo workspace.
alter table public.message_attachments
  drop constraint if exists message_attachments_workspace_id_object_key_key;

create index if not exists message_attachments_object_key_idx
  on public.message_attachments(workspace_id, object_key);

-- =============================================================================================
-- 2. Depósito privado `midias`: permite upload pelo dono nas pastas catalogo/ e audios/
-- =============================================================================================

create or replace function private.can_upload_media_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
    p_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/envios/[a-zA-Z0-9_-]{16,80}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and exists (
      select 1
      from public.conversations c
      join public.workspace_memberships m
        on m.workspace_id = c.workspace_id and m.user_id = auth.uid() and m.status = 'active'
      where c.workspace_id = private.media_object_workspace(p_name)
        and c.id::text = split_part(p_name, '/', 2)
    )
  ) or (
    p_name ~ '^[0-9a-f-]{36}/campanhas/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and exists (
      select 1
      from public.campaign_media_folders f
      join public.workspace_memberships m
        on m.workspace_id = f.workspace_id and m.user_id = auth.uid() and m.status = 'active'
      where f.workspace_id = private.media_object_workspace(p_name)
        and f.id::text = split_part(p_name, '/', 3)
    )
  ) or (
    p_name ~ '^[0-9a-f-]{36}/catalogo/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and private.is_workspace_owner(private.media_object_workspace(p_name))
  ) or (
    p_name ~ '^[0-9a-f-]{36}/audios/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$'
    and private.is_workspace_owner(private.media_object_workspace(p_name))
  )
$$;
revoke all on function private.can_upload_media_object(text) from public, anon;
grant execute on function private.can_upload_media_object(text) to authenticated;

-- =============================================================================================
-- 3. Helpers privados de serialização (usados pelas RPCs do painel e pelo atendente de IA)
-- =============================================================================================

create or replace function private.pix_settings_json(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'enabled', p.enabled,
        'key_type', p.key_type,
        'pix_key', p.pix_key,
        'receiver_name', p.receiver_name,
        'bank_name', p.bank_name,
        'city', p.city,
        'send_qr_image', p.send_qr_image,
        'include_copy_paste', p.include_copy_paste,
        'instructions', p.instructions,
        'updated_at', p.updated_at
      )
      from public.workspace_pix_settings p
      where p.workspace_id = p_workspace_id
    ),
    jsonb_build_object(
      'enabled', false,
      'key_type', 'aleatoria',
      'pix_key', '',
      'receiver_name', '',
      'bank_name', '',
      'city', 'BRASIL',
      'send_qr_image', true,
      'include_copy_paste', true,
      'instructions', '',
      'updated_at', null
    )
  )
$$;
revoke all on function private.pix_settings_json(uuid) from public, anon, authenticated;

create or replace function private.catalog_items_json(p_workspace_id uuid, p_active_only boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'name', i.name,
        'category', i.category,
        'price', i.price,
        'description', i.description,
        'payment_link', i.payment_link,
        'active', i.active,
        'sort_order', i.sort_order,
        'created_at', i.created_at,
        'updated_at', i.updated_at,
        'files', coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'id', f.id,
                'object_key', f.object_key,
                'file_name', f.file_name,
                'content_type', f.content_type,
                'byte_size', f.byte_size,
                'sort_order', f.sort_order
              )
              order by f.sort_order asc, f.created_at asc, f.id asc
            )
            from public.catalog_item_files f
            where f.workspace_id = p_workspace_id and f.item_id = i.id
          ),
          '[]'::jsonb
        )
      )
      order by i.sort_order asc, i.created_at desc, i.id desc
    ),
    '[]'::jsonb
  )
  from public.catalog_items i
  where i.workspace_id = p_workspace_id
    and (not p_active_only or i.active)
$$;
revoke all on function private.catalog_items_json(uuid, boolean) from public, anon, authenticated;

create or replace function private.voice_library_json(p_workspace_id uuid, p_ai_only boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', v.id,
        'name', v.name,
        'transcription', v.transcription,
        'when_to_use', v.when_to_use,
        'linked_message_code', v.linked_message_code,
        'ai_enabled', v.ai_enabled,
        'object_key', v.object_key,
        'file_name', v.file_name,
        'content_type', v.content_type,
        'byte_size', v.byte_size,
        'duration_sec', v.duration_sec,
        'waveform', to_jsonb(v.waveform),
        'created_at', v.created_at,
        'updated_at', v.updated_at
      )
      order by v.created_at desc, v.id desc
    ),
    '[]'::jsonb
  )
  from public.voice_library_items v
  where v.workspace_id = p_workspace_id
    and (not p_ai_only or v.ai_enabled)
$$;
revoke all on function private.voice_library_json(uuid, boolean) from public, anon, authenticated;

-- =============================================================================================
-- 4. RPCs do Painel: PIX, Catálogo, Áudios Estratégicos e Simulador
-- =============================================================================================

create or replace function public.read_my_pix_settings(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  return private.pix_settings_json(p_workspace_id);
end;
$$;

create or replace function public.save_my_pix_settings(p_workspace_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_allowed constant text[] := array[
    'enabled','key_type','pix_key','receiver_name','bank_name','city','send_qr_image','include_copy_paste','instructions'
  ];
  v_key text;
  v_new jsonb;
  v_enabled boolean;
  v_key_type text;
  v_pix_key text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Invalid PIX settings' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_settings) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Unknown setting: %', left(v_key, 60) using errcode = '22023';
    end if;
  end loop;

  v_new := (private.pix_settings_json(p_workspace_id) - 'updated_at') || p_settings;
  v_enabled := coalesce((v_new ->> 'enabled')::boolean, false);
  v_key_type := coalesce(v_new ->> 'key_type', 'aleatoria');
  v_pix_key := btrim(coalesce(v_new ->> 'pix_key', ''));

  if v_key_type not in ('cnpj','cpf','celular','email','aleatoria') then
    raise exception 'Invalid key_type' using errcode = '22023';
  end if;
  if char_length(v_pix_key) > 200 then
    raise exception 'pix_key too long' using errcode = '22023';
  end if;
  if v_enabled and char_length(v_pix_key) = 0 then
    raise exception 'pix_key required when enabled' using errcode = '22023';
  end if;

  insert into public.workspace_pix_settings(
    workspace_id, enabled, key_type, pix_key, receiver_name, bank_name, city,
    send_qr_image, include_copy_paste, instructions, updated_at
  )
  values (
    p_workspace_id,
    v_enabled,
    v_key_type,
    v_pix_key,
    left(btrim(coalesce(v_new ->> 'receiver_name', '')), 200),
    left(btrim(coalesce(v_new ->> 'bank_name', '')), 200),
    coalesce(nullif(left(btrim(coalesce(v_new ->> 'city', '')), 80), ''), 'BRASIL'),
    coalesce((v_new ->> 'send_qr_image')::boolean, true),
    coalesce((v_new ->> 'include_copy_paste')::boolean, true),
    left(btrim(coalesce(v_new ->> 'instructions', '')), 2000),
    now()
  )
  on conflict (workspace_id) do update set
    enabled = excluded.enabled,
    key_type = excluded.key_type,
    pix_key = excluded.pix_key,
    receiver_name = excluded.receiver_name,
    bank_name = excluded.bank_name,
    city = excluded.city,
    send_qr_image = excluded.send_qr_image,
    include_copy_paste = excluded.include_copy_paste,
    instructions = excluded.instructions,
    updated_at = now();

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, private.actor_kind_for(p_workspace_id, v_actor), 'pix_settings_saved', 'workspace', p_workspace_id::text,
    jsonb_build_object('enabled', v_enabled, 'key_type', v_key_type));

  return private.pix_settings_json(p_workspace_id);
end;
$$;

create or replace function public.list_my_catalog_items(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  return private.catalog_items_json(p_workspace_id, false);
end;
$$;

create or replace function public.save_my_catalog_item(p_workspace_id uuid, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_item_id uuid;
  v_is_new boolean := false;
  v_count integer;
  v_name text;
  v_category text;
  v_price text;
  v_description text;
  v_link text;
  v_active boolean;
  v_sort integer;
  v_files jsonb;
  v_elem jsonb;
  v_idx integer := 0;
  v_obj_key text;
  v_obj_meta jsonb;
  v_fname text;
  v_ctype text;
  v_size integer;
  v_keep_keys text[] := array[]::text[];
  v_removed_keys text[] := array[]::text[];
  v_result jsonb;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_item is null or jsonb_typeof(p_item) <> 'object' then
    raise exception 'Invalid catalog item' using errcode = '22023';
  end if;

  v_name := left(btrim(coalesce(p_item ->> 'name', '')), 200);
  if char_length(v_name) = 0 then
    raise exception 'Catalog item name required' using errcode = '22023';
  end if;
  v_category := coalesce(nullif(left(btrim(coalesce(p_item ->> 'category', '')), 100), ''), 'Produto');
  v_price := left(btrim(coalesce(p_item ->> 'price', '')), 200);
  v_description := left(coalesce(p_item ->> 'description', ''), 12000);
  v_link := left(btrim(coalesce(p_item ->> 'payment_link', '')), 2000);
  if v_link <> '' and (v_link !~ '^https://' or position('@' in split_part(substr(v_link, 9), '/', 1)) > 0) then
    raise exception 'Invalid payment link' using errcode = '22023';
  end if;
  v_active := coalesce((p_item ->> 'active')::boolean, true);
  v_sort := coalesce((p_item ->> 'sort_order')::integer, 0);

  if (p_item ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_item_id := (p_item ->> 'id')::uuid;
  else
    v_item_id := gen_random_uuid();
    v_is_new := true;
  end if;

  if not v_is_new then
    perform 1 from public.catalog_items c where c.workspace_id = p_workspace_id and c.id = v_item_id;
    if not found then
      v_is_new := true;
    end if;
  end if;

  if v_is_new then
    select count(*) into v_count from public.catalog_items c where c.workspace_id = p_workspace_id;
    if v_count >= 500 then
      raise exception 'Catalog item limit reached' using errcode = 'P0001';
    end if;
  end if;

  v_files := case when jsonb_typeof(p_item -> 'files') = 'array' then p_item -> 'files' else '[]'::jsonb end;
  if jsonb_array_length(v_files) > 5 then
    raise exception 'Maximum 5 media files per catalog item' using errcode = '22023';
  end if;

  insert into public.catalog_items(
    id, workspace_id, name, category, price, description, payment_link, active, sort_order, updated_at
  )
  values (
    v_item_id, p_workspace_id, v_name, v_category, v_price, v_description, v_link, v_active, v_sort, now()
  )
  on conflict (id) do update set
    name = excluded.name,
    category = excluded.category,
    price = excluded.price,
    description = excluded.description,
    payment_link = excluded.payment_link,
    active = excluded.active,
    sort_order = excluded.sort_order,
    updated_at = now()
  where catalog_items.workspace_id = p_workspace_id;

  -- Coleta arquivos a manter/atualizar e devolve chaves removidas para limpeza no depósito.
  for v_elem in select jsonb_array_elements(v_files) loop
    v_obj_key := coalesce(v_elem ->> 'object_key', '');
    if v_obj_key !~ ('^' || p_workspace_id::text || '/catalogo/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$') then
      raise exception 'Invalid catalog media path' using errcode = '22023';
    end if;
    select o.metadata into v_obj_meta
    from storage.objects o
    where o.bucket_id = 'midias' and o.name = v_obj_key;
    if not found then
      raise exception 'Catalog media file not uploaded' using errcode = 'P0001';
    end if;

    v_fname := coalesce(nullif(left(btrim(coalesce(v_elem ->> 'file_name', '')), 240), ''), split_part(v_obj_key, '/', 5));
    v_ctype := lower(split_part(coalesce(nullif(v_elem ->> 'content_type', ''), v_obj_meta ->> 'mimetype', ''), ';', 1));
    if v_ctype not in ('image/jpeg','image/png','image/webp','image/gif','application/pdf') then
      raise exception 'Invalid catalog media type' using errcode = '22023';
    end if;
    v_size := case
      when (v_elem ->> 'byte_size') ~ '^[0-9]{1,9}$' then (v_elem ->> 'byte_size')::integer
      when (v_obj_meta ->> 'size') ~ '^[0-9]{1,9}$' then (v_obj_meta ->> 'size')::integer
      else 0
    end;
    if v_size < 1 or v_size > 26214400 then
      raise exception 'Invalid catalog media size' using errcode = '22023';
    end if;

    v_keep_keys := array_append(v_keep_keys, v_obj_key);
    v_idx := v_idx + 1;
  end loop;

  select coalesce(array_agg(f.object_key), array[]::text[]) into v_removed_keys
  from public.catalog_item_files f
  where f.workspace_id = p_workspace_id
    and f.item_id = v_item_id
    and not (f.object_key = any (v_keep_keys));

  delete from public.catalog_item_files f
  where f.workspace_id = p_workspace_id and f.item_id = v_item_id;

  v_idx := 0;
  for v_elem in select jsonb_array_elements(v_files) loop
    v_obj_key := coalesce(v_elem ->> 'object_key', '');
    select o.metadata into v_obj_meta
    from storage.objects o
    where o.bucket_id = 'midias' and o.name = v_obj_key;

    v_fname := coalesce(nullif(left(btrim(coalesce(v_elem ->> 'file_name', '')), 240), ''), split_part(v_obj_key, '/', 5));
    v_ctype := lower(split_part(coalesce(nullif(v_elem ->> 'content_type', ''), v_obj_meta ->> 'mimetype', ''), ';', 1));
    v_size := case
      when (v_elem ->> 'byte_size') ~ '^[0-9]{1,9}$' then (v_elem ->> 'byte_size')::integer
      when (v_obj_meta ->> 'size') ~ '^[0-9]{1,9}$' then (v_obj_meta ->> 'size')::integer
      else 1
    end;

    insert into public.catalog_item_files(
      workspace_id, item_id, object_key, file_name, content_type, byte_size, sort_order
    )
    values (
      p_workspace_id, v_item_id, v_obj_key, v_fname, v_ctype, v_size, v_idx
    );
    v_idx := v_idx + 1;
  end loop;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, private.actor_kind_for(p_workspace_id, v_actor), 'catalog_item_saved', 'catalog_item', v_item_id::text,
    jsonb_build_object('name', v_name, 'files', v_idx));

  select x into v_result
  from jsonb_array_elements(private.catalog_items_json(p_workspace_id, false)) x
  where (x ->> 'id') = v_item_id::text
  limit 1;

  return jsonb_build_object(
    'item', v_result,
    'removed_object_keys', to_jsonb(v_removed_keys)
  );
end;
$$;

create or replace function public.delete_my_catalog_item(p_workspace_id uuid, p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_removed text[];
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;

  select coalesce(array_agg(f.object_key), array[]::text[]) into v_removed
  from public.catalog_item_files f
  where f.workspace_id = p_workspace_id and f.item_id = p_item_id;

  delete from public.catalog_items c
  where c.workspace_id = p_workspace_id and c.id = p_item_id;
  if not found then
    return jsonb_build_object('deleted', false, 'removed_object_keys', '[]'::jsonb);
  end if;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (p_workspace_id, v_actor, private.actor_kind_for(p_workspace_id, v_actor), 'catalog_item_deleted', 'catalog_item', p_item_id::text);

  return jsonb_build_object('deleted', true, 'removed_object_keys', to_jsonb(v_removed));
end;
$$;

create or replace function public.list_my_voice_library(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  return private.voice_library_json(p_workspace_id, false);
end;
$$;

create or replace function public.save_my_voice_item(p_workspace_id uuid, p_voice jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_existing public.voice_library_items%rowtype;
  v_has_existing boolean := false;
  v_count integer;
  v_name text;
  v_transc text;
  v_when text;
  v_code text;
  v_ai_enabled boolean;
  v_obj_key text;
  v_obj_meta jsonb;
  v_fname text;
  v_ctype text;
  v_size integer;
  v_dur integer;
  v_wave integer[];
  v_removed_key text := null;
  v_result jsonb;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  if p_voice is null or jsonb_typeof(p_voice) <> 'object' then
    raise exception 'Invalid voice item' using errcode = '22023';
  end if;

  v_name := left(btrim(coalesce(p_voice ->> 'name', '')), 200);
  v_transc := left(btrim(coalesce(p_voice ->> 'transcription', '')), 16000);
  v_when := left(btrim(coalesce(p_voice ->> 'when_to_use', '')), 4000);
  v_code := left(btrim(coalesce(p_voice ->> 'linked_message_code', '')), 100);
  v_ai_enabled := coalesce((p_voice ->> 'ai_enabled')::boolean, true);

  if char_length(v_name) = 0 then
    raise exception 'Voice item name required' using errcode = '22023';
  end if;
  if char_length(v_transc) = 0 then
    raise exception 'Voice transcription required' using errcode = '22023';
  end if;

  if (p_voice ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_id := (p_voice ->> 'id')::uuid;
    select * into v_existing from public.voice_library_items v
    where v.workspace_id = p_workspace_id and v.id = v_id;
    v_has_existing := found;
  else
    v_id := gen_random_uuid();
  end if;

  if not v_has_existing then
    select count(*) into v_count from public.voice_library_items v where v.workspace_id = p_workspace_id;
    if v_count >= 250 then
      raise exception 'Voice library limit reached' using errcode = 'P0001';
    end if;
  end if;

  v_obj_key := coalesce(nullif(p_voice ->> 'object_key', ''), case when v_has_existing then v_existing.object_key else '' end);
  if v_obj_key !~ ('^' || p_workspace_id::text || '/audios/[0-9a-f-]{36}/[0-9a-f-]{36}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$') then
    raise exception 'Invalid audio storage path' using errcode = '22023';
  end if;

  select o.metadata into v_obj_meta
  from storage.objects o
  where o.bucket_id = 'midias' and o.name = v_obj_key;
  if not found then
    raise exception 'Audio file not uploaded' using errcode = 'P0001';
  end if;

  v_fname := coalesce(
    nullif(left(btrim(coalesce(p_voice ->> 'file_name', '')), 240), ''),
    case when v_has_existing then v_existing.file_name else split_part(v_obj_key, '/', 5) end
  );
  v_ctype := lower(split_part(coalesce(nullif(p_voice ->> 'content_type', ''), v_obj_meta ->> 'mimetype', 'audio/ogg'), ';', 1));
  if v_ctype not in ('audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/webm','audio/aac') then
    raise exception 'Invalid audio content type' using errcode = '22023';
  end if;
  if (p_voice ->> 'content_type') = 'audio/ogg; codecs=opus' then
    v_ctype := 'audio/ogg; codecs=opus';
  end if;

  v_size := case
    when (p_voice ->> 'byte_size') ~ '^[0-9]{1,9}$' then (p_voice ->> 'byte_size')::integer
    when (v_obj_meta ->> 'size') ~ '^[0-9]{1,9}$' then (v_obj_meta ->> 'size')::integer
    when v_has_existing then v_existing.byte_size
    else 0
  end;
  if v_size < 1 or v_size > 16777216 then
    raise exception 'Invalid audio byte size' using errcode = '22023';
  end if;

  v_dur := case
    when (p_voice ->> 'duration_sec') ~ '^[0-9]{1,4}$' then least(greatest((p_voice ->> 'duration_sec')::integer, 0), 3600)
    when v_has_existing then v_existing.duration_sec
    else null
  end;

  if jsonb_typeof(p_voice -> 'waveform') = 'array' and jsonb_array_length(p_voice -> 'waveform') = 64 then
    select coalesce(array_agg(least(greatest((el)::integer, 0), 100)), array[]::integer[])
    into v_wave
    from jsonb_array_elements_text(p_voice -> 'waveform') as el;
  elsif v_has_existing and v_obj_key = v_existing.object_key then
    v_wave := v_existing.waveform;
  else
    v_wave := array[]::integer[];
  end if;

  if v_has_existing and v_existing.object_key <> v_obj_key then
    v_removed_key := v_existing.object_key;
  end if;

  insert into public.voice_library_items(
    id, workspace_id, name, transcription, when_to_use, linked_message_code, ai_enabled,
    object_key, file_name, content_type, byte_size, duration_sec, waveform, updated_at
  )
  values (
    v_id, p_workspace_id, v_name, v_transc, v_when, v_code, v_ai_enabled,
    v_obj_key, v_fname, v_ctype, v_size, v_dur, v_wave, now()
  )
  on conflict (id) do update set
    name = excluded.name,
    transcription = excluded.transcription,
    when_to_use = excluded.when_to_use,
    linked_message_code = excluded.linked_message_code,
    ai_enabled = excluded.ai_enabled,
    object_key = excluded.object_key,
    file_name = excluded.file_name,
    content_type = excluded.content_type,
    byte_size = excluded.byte_size,
    duration_sec = excluded.duration_sec,
    waveform = excluded.waveform,
    updated_at = now()
  where voice_library_items.workspace_id = p_workspace_id;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id, details)
  values (p_workspace_id, v_actor, private.actor_kind_for(p_workspace_id, v_actor), 'voice_item_saved', 'voice_item', v_id::text,
    jsonb_build_object('name', v_name, 'ai_enabled', v_ai_enabled));

  select x into v_result
  from jsonb_array_elements(private.voice_library_json(p_workspace_id, false)) x
  where (x ->> 'id') = v_id::text
  limit 1;

  return jsonb_build_object(
    'voice', v_result,
    'removed_object_key', v_removed_key
  );
end;
$$;

create or replace function public.delete_my_voice_item(p_workspace_id uuid, p_voice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_removed text;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;

  delete from public.voice_library_items v
  where v.workspace_id = p_workspace_id and v.id = p_voice_id
  returning v.object_key into v_removed;

  if not found then
    return jsonb_build_object('deleted', false, 'removed_object_key', null);
  end if;

  insert into private.audit_events(workspace_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (p_workspace_id, v_actor, private.actor_kind_for(p_workspace_id, v_actor), 'voice_item_deleted', 'voice_item', p_voice_id::text);

  return jsonb_build_object('deleted', true, 'removed_object_key', v_removed);
end;
$$;

create or replace function public.read_my_simulator_session(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_build_object(
        'agent_id', s.agent_id,
        'history', s.history,
        'updated_at', s.updated_at
      )
      from public.simulator_sessions s
      where s.workspace_id = p_workspace_id and s.user_id = v_actor
    ),
    jsonb_build_object('agent_id', null, 'history', '[]'::jsonb, 'updated_at', null)
  );
end;
$$;

create or replace function public.save_my_simulator_session(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_history jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if p_history is null or jsonb_typeof(p_history) <> 'array' or jsonb_array_length(p_history) > 40 then
    raise exception 'Invalid simulator history' using errcode = '22023';
  end if;
  if p_agent_id is not null then
    perform 1 from public.ai_agents a where a.workspace_id = p_workspace_id and a.id = p_agent_id;
    if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  end if;

  insert into public.simulator_sessions(workspace_id, user_id, agent_id, history, updated_at)
  values (p_workspace_id, v_actor, p_agent_id, p_history, now())
  on conflict (workspace_id, user_id) do update set
    agent_id = excluded.agent_id,
    history = excluded.history,
    updated_at = now();

  return jsonb_build_object('ok', true, 'count', jsonb_array_length(p_history));
end;
$$;

create or replace function public.reset_my_simulator_session(p_workspace_id uuid, p_agent_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if p_agent_id is not null then
    perform 1 from public.ai_agents a where a.workspace_id = p_workspace_id and a.id = p_agent_id;
    if not found then raise exception 'Agent not found' using errcode = 'P0002'; end if;
  end if;

  insert into public.simulator_sessions(workspace_id, user_id, agent_id, history, updated_at)
  values (p_workspace_id, v_actor, p_agent_id, '[]'::jsonb, now())
  on conflict (workspace_id, user_id) do update set
    agent_id = excluded.agent_id,
    history = '[]'::jsonb,
    updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- =============================================================================================
-- 5. Inbox: envio rápido de item do catálogo ou áudio estratégico já armazenado no depósito
-- =============================================================================================

create or replace function public.start_my_workspace_resource_message(
  p_workspace_id uuid,
  p_conversation_id uuid,
  p_idempotency_key text,
  p_object_key text,
  p_kind text,
  p_file_name text,
  p_caption text default null,
  p_duration_seconds integer default null,
  p_is_voice boolean default false,
  p_sent_voice_id uuid default null
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
  v_command_id uuid;
begin
  if v_actor is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[a-zA-Z0-9_-]{16,80}$' then
    raise exception 'Invalid idempotency key' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('image','audio','document') then
    raise exception 'Invalid media kind' using errcode = '22023';
  end if;
  if coalesce(char_length(v_caption), 0) > 1024 or (p_kind = 'audio' and v_caption is not null) then
    raise exception 'Invalid caption' using errcode = '22023';
  end if;

  select c.* into v_conversation
  from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = p_conversation_id
  for update;
  if not found then raise exception 'Conversation not found' using errcode = 'P0002'; end if;

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
  if not found or v_instance.status = 'revoked'
    or not (
      (v_instance.engine = 'evolution' and v_instance.provider_instance_name is not null)
      or (v_instance.engine = 'baileys' and v_instance.local_executor_id is not null)
    ) then
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

  -- Garante que o arquivo pertence ao catálogo ou à biblioteca de áudios deste workspace.
  if not exists (
    select 1 from public.catalog_item_files f
    where f.workspace_id = p_workspace_id and f.object_key = p_object_key
  ) and not exists (
    select 1 from public.voice_library_items v
    where v.workspace_id = p_workspace_id and v.object_key = p_object_key
  ) then
    raise exception 'Resource file not found' using errcode = 'P0001';
  end if;

  if p_sent_voice_id is not null then
    perform 1 from public.voice_library_items v
    where v.workspace_id = p_workspace_id and v.id = p_sent_voice_id;
    if not found then
      raise exception 'Voice item not found' using errcode = 'P0001';
    end if;
  end if;

  select o.metadata into v_metadata
  from storage.objects o
  where o.bucket_id = 'midias' and o.name = p_object_key;
  if not found then raise exception 'media_not_uploaded' using errcode = 'P0001'; end if;

  v_size := case when (v_metadata ->> 'size') ~ '^[0-9]{1,15}$' then (v_metadata ->> 'size')::bigint else 0 end;
  v_mime := lower(left(split_part(coalesce(v_metadata ->> 'mimetype', ''), ';', 1), 120));
  if v_mime !~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' then v_mime := 'application/octet-stream'; end if;
  if v_size < 1 then raise exception 'media_empty' using errcode = 'P0001'; end if;

  insert into public.messages(
    workspace_id, conversation_id, instance_id, idempotency_key, direction,
    source_engine, actor_type, status, body_text, media_object_key, sent_voice_id, occurred_at, sent_by
  )
  values (
    p_workspace_id, p_conversation_id, v_instance.id, p_idempotency_key, 'outbound',
    v_instance.engine, 'human', 'sending', v_caption, p_object_key, p_sent_voice_id, now(), v_actor
  )
  returning * into v_message;

  insert into public.message_attachments(
    workspace_id, message_id, object_key, content_type, byte_size, kind,
    file_name, duration_seconds, is_voice, storage_status, retention_delete_after
  )
  values (
    p_workspace_id, v_message.id, p_object_key, v_mime, v_size, p_kind,
    v_file_name, case when p_duration_seconds between 0 and 3600 then p_duration_seconds end,
    p_kind = 'audio' or p_is_voice, 'stored', null
  )
  returning * into v_attachment;

  if v_instance.engine = 'baileys' then
    insert into public.local_motor_commands(
      workspace_id, executor_id, instance_id, command_type, payload, message_id
    )
    values (
      p_workspace_id,
      v_instance.local_executor_id,
      v_instance.id,
      'send_media',
      jsonb_build_object('recipient', v_contact.external_user_id, 'body_text', v_caption),
      v_message.id
    )
    returning id into v_command_id;

    return jsonb_build_object(
      'message_id', v_message.id,
      'status', v_message.status,
      'already_exists', false,
      'engine', 'baileys',
      'command_id', v_command_id,
      'object_key', p_object_key,
      'kind', v_attachment.kind,
      'content_type', v_attachment.content_type,
      'byte_size', v_attachment.byte_size,
      'file_name', v_attachment.file_name,
      'caption', v_caption
    );
  end if;

  return jsonb_build_object(
    'message_id', v_message.id,
    'status', v_message.status,
    'already_exists', false,
    'engine', 'evolution',
    'provider_instance_name', v_instance.provider_instance_name,
    'recipient', v_contact.external_user_id,
    'object_key', p_object_key,
    'kind', v_attachment.kind,
    'content_type', v_attachment.content_type,
    'byte_size', v_attachment.byte_size,
    'file_name', v_attachment.file_name,
    'caption', v_caption
  );
end;
$$;

-- =============================================================================================
-- 6. Atendente de IA: inclui Catálogo, PIX, Biblioteca de Áudios + sent_voice_ids em claim_ai_turn
--    e disponibiliza start_ai_media_message (service_role) sem quebra de contratos existentes.
-- =============================================================================================

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
  v_sec jsonb;
  v_rate_min integer;
  v_history integer;
  v_last_minute integer;
  v_last_hour integer;
  v_instance public.instances%rowtype;
  v_contact public.contacts%rowtype;
  v_agent_id uuid;
  v_messages jsonb;
  v_sent_voices jsonb;
begin
  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id;
  if not found then return jsonb_build_object('result','gone'); end if;

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

  v_sec := private.security_settings_json(p_workspace_id);
  v_rate_min := least(greatest(coalesce((v_sec ->> 'max_replies_per_minute_per_contact')::integer, 6), 1), 60);

  select count(*) filter (where t.claimed_at > clock_timestamp() - interval '1 minute'), count(*)
  into v_last_minute, v_last_hour
  from public.ai_turns t
  where t.workspace_id = p_workspace_id and t.conversation_id = v_turn.conversation_id
    and t.claimed_at > clock_timestamp() - interval '1 hour';
  if v_last_minute >= v_rate_min or v_last_hour >= greatest(v_rate_min * 10, 60) then
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

  select a.id into v_agent_id
  from public.ai_agents a
  where a.workspace_id = p_workspace_id
    and (a.id = v_instance.ai_agent_id or (v_instance.ai_agent_id is null and a.is_default));

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

  select coalesce(jsonb_agg(distinct m.sent_voice_id::text), '[]'::jsonb) into v_sent_voices
  from public.messages m
  where m.workspace_id = p_workspace_id
    and m.conversation_id = v_turn.conversation_id
    and m.sent_voice_id is not null
    and m.status not in ('failed','cancelled');

  return jsonb_build_object(
    'result', 'claimed',
    'turn', jsonb_build_object('id', v_turn.id, 'conversation_id', v_turn.conversation_id,
      'trigger_message_id', v_turn.trigger_message_id),
    'settings', v_settings,
    'typing', jsonb_build_object(
      'min_ms', least(greatest(coalesce((v_sec ->> 'min_typing_ms')::integer, 1800), 500), 10000),
      'max_ms', least(greatest(coalesce((v_sec ->> 'max_typing_ms')::integer, 5200), 1000), 15000)
    ),
    'keys', coalesce((select jsonb_object_agg(k.provider, k.ciphertext)
                      from private.workspace_ai_secrets k where k.workspace_id = p_workspace_id), '{}'::jsonb),
    'agent', case when v_agent_id is not null then private.ai_agent_json(p_workspace_id, v_agent_id, true) end,
    'resources', jsonb_build_object(
      'pix', private.pix_settings_json(p_workspace_id),
      'catalog', private.catalog_items_json(p_workspace_id, true),
      'voices', private.voice_library_json(p_workspace_id, true),
      'sent_voice_ids', v_sent_voices
    ),
    'conversation', jsonb_build_object(
      'id', v_turn.conversation_id,
      'contact_name', v_contact.display_name,
      'contact_phone', v_contact.phone_e164,
      'contact_email', v_contact.email,
      'recipient', v_contact.external_user_id,
      'instance_id', v_instance.id,
      'instance_label', v_instance.display_name,
      'instance_phone', v_instance.connected_phone,
      'instance_engine', v_instance.engine,
      'provider_instance_name', v_instance.provider_instance_name),
    'messages', v_messages);
end;
$$;

create or replace function public.start_ai_media_message(
  p_workspace_id uuid,
  p_turn_id uuid,
  p_part integer,
  p_object_key text,
  p_kind text,
  p_content_type text,
  p_byte_size integer,
  p_file_name text default null,
  p_caption text default null,
  p_is_voice boolean default false,
  p_duration_seconds integer default null,
  p_sent_voice_id uuid default null,
  p_allow_first_part boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_turn public.ai_turns%rowtype;
  v_caption text := nullif(btrim(coalesce(p_caption, '')), '');
  v_file_name text := nullif(left(btrim(coalesce(p_file_name, '')), 200), '');
  v_key text;
  v_message public.messages%rowtype;
  v_reason text;
  v_next public.ai_turns%rowtype;
  v_instance public.instances%rowtype;
  v_recipient text;
  v_command_id uuid;
begin
  if p_part is null or p_part not between 1 and 20 then
    raise exception 'Invalid media part' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('image','audio','document') then
    raise exception 'Invalid media kind' using errcode = '22023';
  end if;
  if p_byte_size is null or p_byte_size < 1 or p_byte_size > 26214400 then
    raise exception 'Invalid media size' using errcode = '22023';
  end if;
  if coalesce(char_length(v_caption), 0) > 1024 or (p_kind = 'audio' and v_caption is not null) then
    raise exception 'Invalid caption' using errcode = '22023';
  end if;

  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id;
  if not found then raise exception 'Turn not found' using errcode = 'P0002'; end if;
  perform 1 from public.conversations c
  where c.workspace_id = p_workspace_id and c.id = v_turn.conversation_id
  for update;
  select t.* into v_turn from public.ai_turns t where t.workspace_id = p_workspace_id and t.id = p_turn_id for update;

  v_key := 'ia-media-' || replace(v_turn.id::text, '-', '') || '-' || p_part::text;
  select m.* into v_message from public.messages m
  where m.workspace_id = p_workspace_id and m.idempotency_key = v_key;
  if found then
    return jsonb_build_object('result','already_exists','message_id',v_message.id,'status',v_message.status);
  end if;

  if v_turn.status <> 'running' then
    return jsonb_build_object('result','aborted','reason','turn_' || v_turn.status);
  end if;

  v_reason := private.ai_block_reason(p_workspace_id, v_turn.conversation_id);
  if v_reason is null and exists (
    select 1 from public.messages m
    where m.workspace_id = p_workspace_id and m.conversation_id = v_turn.conversation_id
      and m.direction = 'outbound' and m.actor_type = 'human' and m.status = 'sending'
      and m.created_at > clock_timestamp() - interval '90 seconds') then
    v_reason := 'human_replying';
  end if;
  if v_reason is null and p_allow_first_part then
    select w.* into v_next from public.ai_turns w
    where w.workspace_id = p_workspace_id and w.conversation_id = v_turn.conversation_id and w.status = 'waiting';
    if found then v_reason := 'superseded'; end if;
  end if;

  if v_reason is not null then
    update public.ai_turns
    set status = case when p_allow_first_part then 'skipped' else 'answered' end,
        finished_at = clock_timestamp(),
        outcome_detail = left(case when p_allow_first_part then v_reason
                                   else 'stopped_after_media:' || v_reason end, 300)
    where workspace_id = p_workspace_id and id = v_turn.id;
    if p_allow_first_part and v_reason <> 'superseded' then
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

  insert into public.messages(
    workspace_id, conversation_id, instance_id, idempotency_key, direction,
    source_engine, actor_type, status, body_text, media_object_key, sent_voice_id, occurred_at
  )
  values (
    p_workspace_id, v_turn.conversation_id, v_turn.instance_id, v_key, 'outbound',
    v_instance.engine, 'ai', 'sending', v_caption, p_object_key, p_sent_voice_id, clock_timestamp()
  )
  returning * into v_message;

  insert into public.message_attachments(
    workspace_id, message_id, object_key, content_type, byte_size, kind,
    file_name, duration_seconds, is_voice, storage_status, retention_delete_after
  )
  values (
    p_workspace_id, v_message.id, p_object_key, p_content_type, p_byte_size, p_kind,
    v_file_name, case when p_duration_seconds between 0 and 3600 then p_duration_seconds end,
    p_kind = 'audio' or p_is_voice, 'stored',
    case
      when p_object_key like (p_workspace_id::text || '/catalogo/%')
        or p_object_key like (p_workspace_id::text || '/audios/%')
      then null
      else private.media_keep_until(p_workspace_id)
    end
  );

  if v_instance.engine = 'baileys' then
    insert into public.local_motor_commands(
      workspace_id, executor_id, instance_id, command_type, payload, message_id
    )
    values (
      p_workspace_id,
      v_instance.local_executor_id,
      v_instance.id,
      'send_media',
      jsonb_build_object('recipient', v_recipient, 'body_text', v_caption),
      v_message.id
    )
    returning id into v_command_id;

    return jsonb_build_object(
      'result', 'queued_local',
      'message_id', v_message.id,
      'command_id', v_command_id,
      'recipient', v_recipient
    );
  end if;

  return jsonb_build_object(
    'result', 'started',
    'message_id', v_message.id,
    'provider_instance_name', v_instance.provider_instance_name,
    'recipient', v_recipient
  );
end;
$$;

create or replace function public.read_workspace_ai_keys_for_simulator(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_object_agg(s.provider, s.ciphertext)
      from private.workspace_ai_secrets s
      where s.workspace_id = p_workspace_id
    ),
    '{}'::jsonb
  );
$$;

-- =============================================================================================
-- 7. Permissões de execução das novas e atualizadas RPCs
-- =============================================================================================

revoke all on function public.read_my_pix_settings(uuid) from public, anon;
revoke all on function public.save_my_pix_settings(uuid, jsonb) from public, anon;
revoke all on function public.list_my_catalog_items(uuid) from public, anon;
revoke all on function public.save_my_catalog_item(uuid, jsonb) from public, anon;
revoke all on function public.delete_my_catalog_item(uuid, uuid) from public, anon;
revoke all on function public.list_my_voice_library(uuid) from public, anon;
revoke all on function public.save_my_voice_item(uuid, jsonb) from public, anon;
revoke all on function public.delete_my_voice_item(uuid, uuid) from public, anon;
revoke all on function public.read_my_simulator_session(uuid) from public, anon;
revoke all on function public.save_my_simulator_session(uuid, uuid, jsonb) from public, anon;
revoke all on function public.reset_my_simulator_session(uuid, uuid) from public, anon;
revoke all on function public.start_my_workspace_resource_message(uuid, uuid, text, text, text, text, text, integer, boolean, uuid) from public, anon;
revoke all on function public.claim_ai_turn(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.start_ai_media_message(uuid, uuid, integer, text, text, text, integer, text, text, boolean, integer, uuid, boolean) from public, anon, authenticated;
revoke all on function public.read_workspace_ai_keys_for_simulator(uuid) from public, anon, authenticated;

grant execute on function public.read_my_pix_settings(uuid) to authenticated;
grant execute on function public.save_my_pix_settings(uuid, jsonb) to authenticated;
grant execute on function public.list_my_catalog_items(uuid) to authenticated;
grant execute on function public.save_my_catalog_item(uuid, jsonb) to authenticated;
grant execute on function public.delete_my_catalog_item(uuid, uuid) to authenticated;
grant execute on function public.list_my_voice_library(uuid) to authenticated;
grant execute on function public.save_my_voice_item(uuid, jsonb) to authenticated;
grant execute on function public.delete_my_voice_item(uuid, uuid) to authenticated;
grant execute on function public.read_my_simulator_session(uuid) to authenticated;
grant execute on function public.save_my_simulator_session(uuid, uuid, jsonb) to authenticated;
grant execute on function public.reset_my_simulator_session(uuid, uuid) to authenticated;
grant execute on function public.start_my_workspace_resource_message(uuid, uuid, text, text, text, text, text, integer, boolean, uuid) to authenticated;
grant execute on function public.claim_ai_turn(uuid, uuid, uuid) to service_role;
grant execute on function public.start_ai_media_message(uuid, uuid, integer, text, text, text, integer, text, text, boolean, integer, uuid, boolean) to service_role;
grant execute on function public.read_workspace_ai_keys_for_simulator(uuid) to service_role;

commit;
