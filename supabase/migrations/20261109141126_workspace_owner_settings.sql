grant update (name) on public.workspaces to authenticated;
create policy workspaces_update_owner
on public.workspaces
for update
to authenticated
using (private.is_workspace_owner(id))
with check (private.is_workspace_owner(id));
