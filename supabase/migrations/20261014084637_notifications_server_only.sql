revoke all on table public.notifications from public, anon, authenticated;

drop policy if exists notifications_realtime_platform_read on public.notifications;
drop policy if exists notifications_realtime_user_read on public.notifications;
drop policy if exists notifications_realtime_store_read on public.notifications;
drop policy if exists notifications_realtime_update on public.notifications;

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    execute 'alter publication supabase_realtime drop table public.notifications';
  end if;
end;
$$;
