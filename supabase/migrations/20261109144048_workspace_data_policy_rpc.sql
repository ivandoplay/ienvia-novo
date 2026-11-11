create or replace function public.update_my_workspace_data_policy(
  p_workspace_id uuid,
  p_message_retention_days integer,
  p_media_retention_days integer,
  p_recovery_window_days integer,
  p_active_data_purge_sla_days integer,
  p_backup_expiry_target_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_policy public.workspace_data_policies%rowtype;
begin
  if v_actor is null or not private.is_workspace_owner(p_workspace_id) then
    raise exception 'Workspace owner required' using errcode = '42501';
  end if;
  update public.workspace_data_policies
  set message_retention_days = p_message_retention_days,
      media_retention_days = p_media_retention_days,
      recovery_window_days = p_recovery_window_days,
      active_data_purge_sla_days = p_active_data_purge_sla_days,
      backup_expiry_target_days = p_backup_expiry_target_days,
      updated_at = now()
  where workspace_id = p_workspace_id
  returning * into v_policy;
  if not found then raise exception 'Workspace policy not found' using errcode = 'P0002'; end if;
  insert into private.audit_events(workspace_id,actor_user_id,actor_kind,action,target_type,target_id,details)
  values (p_workspace_id,v_actor,'owner','workspace_data_policy_updated','workspace_data_policy',p_workspace_id::text,
    jsonb_build_object('message_retention_days',v_policy.message_retention_days,'media_retention_days',v_policy.media_retention_days,'recovery_window_days',v_policy.recovery_window_days,'active_data_purge_sla_days',v_policy.active_data_purge_sla_days,'backup_expiry_target_days',v_policy.backup_expiry_target_days));
  return jsonb_build_object('workspace_id',v_policy.workspace_id,'message_retention_days',v_policy.message_retention_days,'media_retention_days',v_policy.media_retention_days,'recovery_window_days',v_policy.recovery_window_days,'active_data_purge_sla_days',v_policy.active_data_purge_sla_days,'backup_expiry_target_days',v_policy.backup_expiry_target_days,'updated_at',v_policy.updated_at);
end;
$$;
revoke all on function public.update_my_workspace_data_policy(uuid,integer,integer,integer,integer,integer) from public, anon;
grant execute on function public.update_my_workspace_data_policy(uuid,integer,integer,integer,integer,integer) to authenticated;
