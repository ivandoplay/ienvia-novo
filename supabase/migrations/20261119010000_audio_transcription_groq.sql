create table if not exists public.workspace_transcription_settings (
 workspace_id uuid primary key references public.workspaces(id) on delete cascade,
 groq_ciphertext text,
 gemini_fallback boolean not null default false,
 updated_at timestamptz not null default now(),
 constraint transcription_ciphertext check (groq_ciphertext is null or groq_ciphertext ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22}[.][A-Za-z0-9_-]+$')
);
alter table public.workspace_transcription_settings enable row level security;
revoke all on public.workspace_transcription_settings from anon, authenticated;
grant all on public.workspace_transcription_settings to service_role;
