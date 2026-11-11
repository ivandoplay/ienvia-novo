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
    update public.conversations set stage = 'human', automation_paused = true, assigned_user_id = v_actor, assigned_label = 'Atendente' where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_claimed';
  elsif p_action = 'resolve' then
    if v_row.stage = 'archived' then raise exception 'Archived conversation cannot be resolved again' using errcode = '22023'; end if;
    update public.conversations set stage = 'resolved', automation_paused = true where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_resolved';
  elsif p_action = 'mark_read' then
    update public.conversations set unread_count = 0 where workspace_id = p_workspace_id and id = p_conversation_id returning * into v_row;
    v_action_name := 'conversation_marked_read';
  else raise exception 'Unsupported conversation action' using errcode = '22023';
  end if;
  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,v_role,v_action_name,'conversation',p_conversation_id::text,jsonb_build_object('stage',v_row.stage,'automation_paused',v_row.automation_paused,'unread_count',v_row.unread_count));
  return jsonb_build_object('id',v_row.id,'stage',v_row.stage,'assigned_user_id',v_row.assigned_user_id,'assigned_label',v_row.assigned_label,'automation_paused',v_row.automation_paused,'unread_count',v_row.unread_count,'updated_at',v_row.updated_at);
end;
$$;
revoke all on function public.transition_workspace_conversation(uuid,uuid,text) from public, anon;
grant execute on function public.transition_workspace_conversation(uuid,uuid,text) to authenticated;
