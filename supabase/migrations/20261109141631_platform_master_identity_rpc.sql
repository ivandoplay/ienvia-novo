create or replace function public.is_my_platform_master()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_master();
$$;
revoke all on function public.is_my_platform_master() from public, anon;
grant execute on function public.is_my_platform_master() to authenticated;
notify pgrst, 'reload schema';
