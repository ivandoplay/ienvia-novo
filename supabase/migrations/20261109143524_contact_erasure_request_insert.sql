alter table public.contact_erasure_requests add column if not exists requested_by uuid references auth.users(id) on delete set null;
revoke insert on public.contact_erasure_requests from authenticated;
grant insert (workspace_id, contact_id, request_reference, requested_by) on public.contact_erasure_requests to authenticated;
create policy contact_erasure_requests_insert_member on public.contact_erasure_requests for insert to authenticated with check (private.is_workspace_member(workspace_id) and requested_by = auth.uid() and status = 'received');
