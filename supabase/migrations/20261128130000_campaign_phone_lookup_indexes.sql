-- Acelera importação e supressão sem mudar regras de bloqueio ou consentimento.
create index if not exists contacts_campaign_phone_core_idx on public.contacts (workspace_id,private.phone_core(phone_e164)) where erased_at is null and phone_e164 is not null;
create index if not exists contacts_campaign_external_core_idx on public.contacts (workspace_id,private.phone_core(external_user_id)) where erased_at is null and external_user_id is not null;
