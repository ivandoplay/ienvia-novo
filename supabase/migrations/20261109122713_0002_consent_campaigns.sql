-- Consent evidence, manual cross-channel links and one-shot campaign planning.
-- Review-only until tested with Supabase local + RLS tests.
begin;

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  message_id uuid not null,
  object_key text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  sha256_hex text,
  retention_delete_after timestamptz,
  deletion_status text not null default 'active' check (deletion_status in ('active','pending','deleted','retained_exception')),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, object_key),
  foreign key (workspace_id, message_id) references public.messages(workspace_id, id) on delete restrict
);
create index message_attachments_retention_idx on public.message_attachments(retention_delete_after, id)
  where deletion_status = 'active' and retention_delete_after is not null;
create index message_attachments_message_idx on public.message_attachments(workspace_id, message_id, created_at);
alter table public.message_attachments enable row level security;
revoke all on public.message_attachments from anon, authenticated;
grant select on public.message_attachments to authenticated;
grant all on public.message_attachments to service_role;
create policy message_attachments_select_member on public.message_attachments for select to authenticated using (private.is_workspace_member(workspace_id));
-- Object bytes live in a private Storage bucket; signed URLs must be issued server-side after RLS checks.

create table public.contact_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id_low uuid not null,
  contact_id_high uuid not null,
  linked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, contact_id_low, contact_id_high),
  check (contact_id_low < contact_id_high),
  foreign key (workspace_id, contact_id_low) references public.contacts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, contact_id_high) references public.contacts(workspace_id, id) on delete cascade
);
create index contact_links_workspace_low_idx on public.contact_links(workspace_id, contact_id_low);
create index contact_links_workspace_high_idx on public.contact_links(workspace_id, contact_id_high);
alter table public.contact_links enable row level security;
revoke all on public.contact_links from anon, authenticated;
grant select, insert, delete on public.contact_links to authenticated;
grant all on public.contact_links to service_role;
create policy contact_links_select_member on public.contact_links for select to authenticated using (private.is_workspace_member(workspace_id));
create policy contact_links_insert_member on public.contact_links for insert to authenticated with check (private.is_workspace_member(workspace_id));
create policy contact_links_delete_member on public.contact_links for delete to authenticated using (private.is_workspace_member(workspace_id));

create table public.contact_consent_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null,
  purpose text not null check (char_length(purpose) between 1 and 80),
  action text not null check (action in ('granted','withdrawn','opted_out','reconfirmed')),
  source text not null check (char_length(source) between 1 and 80),
  evidence_reference text,
  recorded_by uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete restrict
);
create index consent_contact_history_idx on public.contact_consent_events(workspace_id, contact_id, purpose, occurred_at desc);
alter table public.contact_consent_events enable row level security;
revoke all on public.contact_consent_events from anon, authenticated;
grant select on public.contact_consent_events to authenticated;
grant all on public.contact_consent_events to service_role;
create policy consent_events_select_member on public.contact_consent_events for select to authenticated using (private.is_workspace_member(workspace_id));

create table public.contact_consent_state (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null,
  purpose text not null,
  status text not null check (status in ('granted','withdrawn','opted_out')),
  source text not null,
  evidence_reference text,
  occurred_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, contact_id, purpose),
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete restrict
);
create index consent_state_eligibility_idx on public.contact_consent_state(workspace_id, purpose, status, contact_id);
alter table public.contact_consent_state enable row level security;
revoke all on public.contact_consent_state from anon, authenticated;
grant select on public.contact_consent_state to authenticated;
grant all on public.contact_consent_state to service_role;
create policy consent_state_select_member on public.contact_consent_state for select to authenticated using (private.is_workspace_member(workspace_id));

-- The RPC is the only authenticated write path: evidence is appended and current state updated atomically.
create or replace function public.record_contact_consent(
  p_workspace_id uuid, p_contact_id uuid, p_purpose text, p_action text, p_source text,
  p_evidence_reference text default null, p_occurred_at timestamptz default now()
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_event_id uuid;
begin
  if auth.uid() is null or not private.is_workspace_member(p_workspace_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_purpose is null or char_length(trim(p_purpose)) not between 1 and 80 then raise exception 'invalid purpose' using errcode = '22023'; end if;
  if p_action is null or p_action not in ('granted','withdrawn','opted_out','reconfirmed') then raise exception 'invalid action' using errcode = '22023'; end if;
  if p_source is null or char_length(trim(p_source)) not between 1 and 80 then raise exception 'invalid source' using errcode = '22023'; end if;
  if p_evidence_reference is not null and char_length(p_evidence_reference)>2048 then raise exception 'evidence reference too long' using errcode = '22023'; end if;
  if p_action in ('granted','reconfirmed') and nullif(trim(p_evidence_reference),'') is null then raise exception 'evidence required for grant' using errcode = '22023'; end if;
  if p_occurred_at > now() + interval '5 minutes' then raise exception 'future consent timestamp' using errcode = '22023'; end if;
  perform 1 from public.contacts c where c.workspace_id=p_workspace_id and c.id=p_contact_id and c.erased_at is null for update;
  if not found then raise exception 'contact not found' using errcode = 'P0002'; end if;
  insert into public.contact_consent_events(workspace_id,contact_id,purpose,action,source,evidence_reference,recorded_by,occurred_at)
    values(p_workspace_id,p_contact_id,trim(p_purpose),p_action,trim(p_source),nullif(trim(p_evidence_reference),''),auth.uid(),p_occurred_at)
    returning id into v_event_id;
  insert into public.contact_consent_state(workspace_id,contact_id,purpose,status,source,evidence_reference,occurred_at,updated_at)
    values(p_workspace_id,p_contact_id,trim(p_purpose),
      case when p_action in ('granted','reconfirmed') then 'granted' when p_action='opted_out' then 'opted_out' else 'withdrawn' end,
      trim(p_source),nullif(trim(p_evidence_reference),''),p_occurred_at,now())
    on conflict (workspace_id,contact_id,purpose) do update set status=excluded.status,source=excluded.source,evidence_reference=excluded.evidence_reference,occurred_at=excluded.occurred_at,updated_at=now();
  if trim(p_purpose)='global' then
    update public.contacts set consent_status=case when p_action in ('granted','reconfirmed') then 'opted_in' else 'opted_out' end,consent_updated_at=p_occurred_at
      where workspace_id=p_workspace_id and id=p_contact_id;
  end if;
  return v_event_id;
end;
$$;
revoke all on function public.record_contact_consent(uuid,uuid,text,text,text,text,timestamptz) from public, anon;
grant execute on function public.record_contact_consent(uuid,uuid,text,text,text,text,timestamptz) to authenticated;
-- Browser cannot edit current consent or event rows directly; campaign eligibility also checks both global and purpose state.
revoke update, delete, insert on public.contact_consent_events from authenticated;

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  status text not null default 'draft' check (status in ('draft','scheduled','preparing','awaiting_confirmation','running','paused','completed','cancelled','failed')),
  text_body text,
  media_object_key text,
  scheduled_for timestamptz,
  send_window_start time,
  send_window_end time,
  timezone text not null default 'America/Fortaleza',
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (text_body is not null or media_object_key is not null),
  check ((send_window_start is null) = (send_window_end is null))
);
create index campaigns_workspace_created_idx on public.campaigns(workspace_id, created_at desc, id desc);
create index campaigns_workspace_status_schedule_idx on public.campaigns(workspace_id, status, scheduled_for);
create trigger campaigns_touch_updated_at before update on public.campaigns for each row execute function private.touch_updated_at();
alter table public.campaigns enable row level security;
revoke all on public.campaigns from anon, authenticated;
grant select on public.campaigns to authenticated;
grant insert (workspace_id, name, text_body, media_object_key, scheduled_for, send_window_start, send_window_end, timezone, settings) on public.campaigns to authenticated;
grant update (name, text_body, media_object_key, scheduled_for, send_window_start, send_window_end, timezone, settings) on public.campaigns to authenticated;
grant all on public.campaigns to service_role;
create policy campaigns_select_member on public.campaigns for select to authenticated using (private.is_workspace_member(workspace_id));
create policy campaigns_insert_member on public.campaigns for insert to authenticated with check (private.is_workspace_member(workspace_id) and status = 'draft');
create policy campaigns_update_draft_member on public.campaigns for update to authenticated using (private.is_workspace_member(workspace_id) and status = 'draft') with check (private.is_workspace_member(workspace_id) and status = 'draft');

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  campaign_id uuid not null,
  contact_id uuid not null,
  instance_id uuid not null,
  status text not null default 'pending' check (status in ('pending','suppressed','queued','awaiting_human_confirmation','sending','sent','delivered','read','replied','failed','cancelled')),
  eligibility_checked_at timestamptz,
  send_allowed boolean not null default false,
  suppression_reason text,
  message_id uuid,
  idempotency_key text not null,
  planned_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, campaign_id, contact_id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, campaign_id) references public.campaigns(workspace_id, id) on delete cascade,
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id) on delete restrict,
  foreign key (workspace_id, instance_id) references public.instances(workspace_id, id) on delete restrict,
  foreign key (workspace_id, message_id) references public.messages(workspace_id, id) on delete restrict
);
create index campaign_recipients_dispatch_idx on public.campaign_recipients(workspace_id, campaign_id, status, planned_at, id);
create index campaign_recipients_contact_idx on public.campaign_recipients(workspace_id, contact_id, created_at desc);
alter table public.campaign_recipients enable row level security;
revoke all on public.campaign_recipients from anon, authenticated;
grant select on public.campaign_recipients to authenticated;
grant all on public.campaign_recipients to service_role;
create policy campaign_recipients_select_member on public.campaign_recipients for select to authenticated using (private.is_workspace_member(workspace_id));
-- Recipient materialization, opt-in checks, dispatch status and campaign start/pause are server-only.

create table public.workspace_exports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  format text not null check (format in ('csv','xlsx','json','archive')),
  categories jsonb not null,
  date_from timestamptz,
  date_to timestamptz,
  status text not null default 'queued' check (status in ('queued','processing','ready','failed','expired','cancelled')),
  object_key text,
  manifest jsonb,
  checksum_sha256 text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  failure_code text,
  unique (workspace_id, id)
);
create index workspace_exports_owner_idx on public.workspace_exports(workspace_id, requested_by, requested_at desc);
create index workspace_exports_cleanup_idx on public.workspace_exports(expires_at) where status = 'ready';
alter table public.workspace_exports enable row level security;
revoke all on public.workspace_exports from anon, authenticated;
grant select, insert on public.workspace_exports to authenticated;
grant all on public.workspace_exports to service_role;
create policy exports_select_owner on public.workspace_exports for select to authenticated using (private.is_workspace_owner(workspace_id));
create policy exports_insert_owner on public.workspace_exports for insert to authenticated with check (private.is_workspace_owner(workspace_id) and requested_by = auth.uid() and status = 'queued');
-- Export data/files are private. Only an authenticated owner receives short-lived download access after job completion.

create table public.workspace_lifecycle_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  request_type text not null check (request_type in ('close','restore','confirm_delete')),
  status text not null default 'received' check (status in ('received','verifying','scheduled','processing','completed','rejected','cancelled')),
  requested_at timestamptz not null default now(),
  recovery_deadline timestamptz,
  completed_at timestamptz,
  result_code text,
  foreign key (workspace_id, requested_by) references public.workspace_memberships(workspace_id, user_id) on delete restrict
);
create index workspace_lifecycle_pending_idx on public.workspace_lifecycle_requests(workspace_id, status, requested_at desc);
alter table public.workspace_lifecycle_requests enable row level security;
revoke all on public.workspace_lifecycle_requests from anon, authenticated;
grant select, insert on public.workspace_lifecycle_requests to authenticated;
grant all on public.workspace_lifecycle_requests to service_role;
create policy lifecycle_select_owner on public.workspace_lifecycle_requests for select to authenticated using (private.is_workspace_owner(workspace_id));
create policy lifecycle_insert_owner on public.workspace_lifecycle_requests for insert to authenticated with check (private.is_workspace_owner(workspace_id) and requested_by = auth.uid() and status = 'received');
-- A recovery/restoration request requires verification; state transitions are server-side and audited.

create table public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email_normalized text not null,
  role text not null check (role in ('owner','operator')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index workspace_invites_workspace_status_idx on public.workspace_invites(workspace_id, status, created_at desc);
alter table public.workspace_invites enable row level security;
revoke all on public.workspace_invites from anon, authenticated;
grant select on public.workspace_invites to authenticated;
grant all on public.workspace_invites to service_role;
create policy invites_select_owner on public.workspace_invites for select to authenticated using (private.is_workspace_owner(workspace_id));
-- Invite creation/consumption is server-side; only a token hash is stored, never the raw link secret.

-- The contact summary fields are updated only from validated, append-only consent events.
revoke update (consent_status, consent_updated_at) on public.contacts from authenticated;

commit;
