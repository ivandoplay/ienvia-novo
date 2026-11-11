-- Ienvia initial multi-tenant core. Review-only migration: do not apply to a remote project yet.
-- Assumes Supabase Auth schema. No secrets or provider credentials are stored here.
begin;

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'active' check (status in ('active','closed','deleting','deleted')),
  created_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz,
  deletion_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','operator')),
  status text not null default 'active' check (status in ('invited','active','suspended')),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id),
  unique (workspace_id, id)
);
create unique index workspace_single_active_owner on public.workspace_memberships(workspace_id)
  where role = 'owner' and status = 'active';
create index workspace_memberships_user_active_idx on public.workspace_memberships(user_id, workspace_id)
  where status = 'active';

create table public.workspace_data_policies (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  message_retention_days integer not null default 60 check (message_retention_days between 1 and 3650),
  media_retention_days integer not null default 30 check (media_retention_days between 1 and 3650),
  recovery_window_days integer not null default 30 check (recovery_window_days between 1 and 180),
  active_data_purge_sla_days integer not null default 7 check (active_data_purge_sla_days between 1 and 90),
  backup_expiry_target_days integer not null default 7 check (backup_expiry_target_days between 0 and 90),
  updated_at timestamptz not null default now()
);

create table public.instances (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','instagram')),
  engine text not null check (engine in ('evolution','baileys','meta')),
  display_name text not null,
  logical_number_key text,
  status text not null default 'disconnected' check (status in ('disconnected','connecting','connected','paused','error','revoked')),
  is_enabled boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((channel = 'whatsapp' and engine in ('evolution','baileys')) or (channel = 'instagram' and engine = 'meta'))
);
create index instances_workspace_status_idx on public.instances(workspace_id, status);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  instance_id uuid,
  channel text not null check (channel in ('whatsapp','instagram','manual')),
  external_user_id text,
  display_name text not null default '',
  phone_e164 text,
  email text,
  consent_status text not null default 'unknown' check (consent_status in ('unknown','opted_in','opted_out','restricted')),
  consent_updated_at timestamptz,
  erased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete restrict
);
create unique index contacts_external_identity_uq on public.contacts(workspace_id, channel, instance_id, external_user_id)
  where external_user_id is not null and erased_at is null;
create index contacts_workspace_created_idx on public.contacts(workspace_id, created_at desc, id desc);
create index contacts_workspace_name_idx on public.contacts(workspace_id, lower(display_name), id);
create index contacts_workspace_phone_idx on public.contacts(workspace_id, phone_e164) where phone_e164 is not null;
create index contacts_display_name_trgm_idx on public.contacts using gin (display_name extensions.gin_trgm_ops);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null,
  instance_id uuid not null,
  stage text not null default 'new' check (stage in ('new','ai','waiting_human','human','waiting_customer','resolved','archived')),
  assigned_user_id uuid references auth.users(id) on delete set null,
  assigned_label text,
  automation_paused boolean not null default false,
  last_message_at timestamptz,
  last_message_preview text,
  unread_count integer not null default 0 check (unread_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activity_at timestamptz generated always as (coalesce(last_message_at, created_at)) stored,
  unique (workspace_id, id),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete restrict,
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete restrict
);
create index conversations_workspace_activity_idx on public.conversations(workspace_id, activity_at desc, id desc);
create index conversations_workspace_stage_activity_idx on public.conversations(workspace_id, stage, activity_at desc, id desc);
create index conversations_workspace_assignee_idx on public.conversations(workspace_id, assigned_user_id, activity_at desc, id desc);
create index conversations_preview_trgm_idx on public.conversations using gin (last_message_preview extensions.gin_trgm_ops)
  where last_message_preview is not null;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid not null,
  instance_id uuid not null,
  provider_message_id text,
  idempotency_key text,
  direction text not null check (direction in ('inbound','outbound')),
  source_engine text not null check (source_engine in ('evolution','baileys','meta','system')),
  actor_type text not null check (actor_type in ('contact','ai','human','api','system')),
  status text not null check (status in ('received','queued','awaiting_human_confirmation','sending','sent','delivered','read','failed','cancelled')),
  body_text text,
  media_object_key text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id) on delete restrict,
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete restrict,
  check (body_text is not null or media_object_key is not null)
);
create unique index messages_provider_dedupe_uq on public.messages(workspace_id, instance_id, source_engine, provider_message_id)
  where provider_message_id is not null;
create unique index messages_idempotency_uq on public.messages(workspace_id, idempotency_key)
  where idempotency_key is not null;
create index messages_conversation_timeline_idx on public.messages(workspace_id, conversation_id, occurred_at desc, id desc);

-- Jobs are durable intent/state. Queue providers are dispatch mechanisms, not history.
create table public.outbox_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  conversation_id uuid,
  message_id uuid,
  job_type text not null check (job_type in ('send_message','export_workspace','erase_contact','campaign_chunk','sync_events')),
  status text not null default 'pending' check (status in ('pending','leased','succeeded','retryable','dead','cancelled')),
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id) on delete restrict,
  foreign key (workspace_id, message_id) references public.messages(workspace_id, id) on delete restrict
);
create index outbox_claim_idx on public.outbox_jobs(status, available_at, created_at) where status in ('pending','retryable');

-- Webhook deliveries are recorded server-side and deduplicated before side effects.
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  instance_id uuid not null,
  engine text not null check (engine in ('evolution','baileys','meta')),
  provider_event_id text not null,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (processing_status in ('received','processing','processed','retryable','dead')),
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete restrict,
  unique (workspace_id, instance_id, engine, provider_event_id)
);
create index webhook_events_pending_idx on public.webhook_events(received_at) where processing_status in ('received','retryable');

create table public.contact_erasure_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid,
  request_reference text not null,
  status text not null default 'received' check (status in ('received','verifying','processing','completed','partially_retained','rejected')),
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  retention_exception_code text,
  result_summary text,
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete set null (contact_id),
  unique (workspace_id, request_reference)
);
create index erasure_requests_workspace_status_idx on public.contact_erasure_requests(workspace_id, status, received_at desc);

-- Master identities and audit records remain outside the exposed API schema.
create table private.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table private.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid,
  actor_user_id uuid,
  actor_kind text not null check (actor_kind in ('owner','operator','master','service')),
  action text not null,
  target_type text,
  target_id text,
  request_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_workspace_time_idx on private.audit_events(workspace_id, created_at desc);
create index audit_events_actor_time_idx on private.audit_events(actor_user_id, created_at desc);
revoke all on all tables in schema private from public, anon, authenticated;

create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.status = 'active'
  );
$$;
create or replace function private.is_workspace_owner(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = p_workspace_id and m.user_id = auth.uid() and m.status = 'active' and m.role = 'owner'
  );
$$;
create or replace function private.is_active_workspace_user(p_workspace_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.status = 'active'
  );
$$;
create or replace function private.is_platform_master()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.platform_admins a where a.user_id = auth.uid() and a.is_active);
$$;
revoke all on function private.is_workspace_member(uuid) from public, anon;
revoke all on function private.is_workspace_owner(uuid) from public, anon;
revoke all on function private.is_active_workspace_user(uuid, uuid) from public, anon;
revoke all on function private.is_platform_master() from public, anon;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.is_workspace_owner(uuid) to authenticated;
grant execute on function private.is_active_workspace_user(uuid, uuid) to authenticated;
grant execute on function private.is_platform_master() to authenticated;

create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles for each row execute function private.touch_updated_at();
create trigger workspaces_touch_updated_at before update on public.workspaces for each row execute function private.touch_updated_at();
create trigger instances_touch_updated_at before update on public.instances for each row execute function private.touch_updated_at();
create trigger contacts_touch_updated_at before update on public.contacts for each row execute function private.touch_updated_at();
create trigger conversations_touch_updated_at before update on public.conversations for each row execute function private.touch_updated_at();
create trigger outbox_jobs_touch_updated_at before update on public.outbox_jobs for each row execute function private.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_data_policies enable row level security;
alter table public.instances enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.outbox_jobs enable row level security;
alter table public.webhook_events enable row level security;
alter table public.contact_erasure_requests enable row level security;

-- Start with no broad grants; every exposed operation has an explicit grant and policy.
revoke all on public.profiles, public.workspaces, public.workspace_memberships, public.workspace_data_policies,
  public.instances, public.contacts, public.conversations, public.messages, public.outbox_jobs,
  public.webhook_events, public.contact_erasure_requests from anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select on public.workspaces, public.workspace_memberships, public.instances to authenticated;
grant select, update on public.workspace_data_policies to authenticated;
grant select on public.contacts to authenticated;
grant insert (workspace_id, channel, display_name, phone_e164, email) on public.contacts to authenticated;
grant update (display_name, phone_e164, email) on public.contacts to authenticated;
grant select on public.conversations to authenticated;
grant update (stage, assigned_user_id, assigned_label, automation_paused, unread_count) on public.conversations to authenticated;
grant select on public.messages to authenticated;
grant select on public.contact_erasure_requests to authenticated;
-- No browser grants for workspaces/memberships creation, message insertion, sending jobs, webhooks, or audit.
grant all on public.profiles, public.workspaces, public.workspace_memberships, public.workspace_data_policies,
  public.instances, public.contacts, public.conversations, public.messages, public.outbox_jobs,
  public.webhook_events, public.contact_erasure_requests to service_role;
grant all on all tables in schema private to service_role;
grant all on all sequences in schema private to service_role;

create policy profiles_select_self on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert_self on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy workspaces_select_member on public.workspaces for select to authenticated using (private.is_workspace_member(id));
create policy memberships_select_self_or_owner on public.workspace_memberships for select to authenticated using (user_id = auth.uid() or private.is_workspace_owner(workspace_id));
create policy policies_select_member on public.workspace_data_policies for select to authenticated using (private.is_workspace_member(workspace_id));
create policy policies_update_owner on public.workspace_data_policies for update to authenticated using (private.is_workspace_owner(workspace_id)) with check (private.is_workspace_owner(workspace_id));

create policy instances_select_member on public.instances for select to authenticated using (private.is_workspace_member(workspace_id));
create policy contacts_select_member on public.contacts for select to authenticated using (private.is_workspace_member(workspace_id));
create policy contacts_insert_member on public.contacts for insert to authenticated with check (private.is_workspace_member(workspace_id));
create policy contacts_update_member on public.contacts for update to authenticated using (private.is_workspace_member(workspace_id)) with check (private.is_workspace_member(workspace_id));
create policy conversations_select_member on public.conversations for select to authenticated using (private.is_workspace_member(workspace_id));
create policy conversations_update_member on public.conversations for update to authenticated
  using (private.is_workspace_member(workspace_id))
  with check (private.is_workspace_member(workspace_id) and (assigned_user_id is null or private.is_active_workspace_user(workspace_id, assigned_user_id)));
create policy messages_select_member on public.messages for select to authenticated using (private.is_workspace_member(workspace_id));
create policy erasure_requests_select_member on public.contact_erasure_requests for select to authenticated using (private.is_workspace_member(workspace_id));

commit;
