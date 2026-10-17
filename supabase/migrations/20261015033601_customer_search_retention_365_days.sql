begin;

-- pg_cron is available in this Supabase project but was not enabled at the time this policy was approved.
create extension if not exists pg_cron;

create index if not exists customer_searches_occurred_at_idx
  on public.customer_searches (occurred_at);

create or replace function public.purge_expired_customer_searches()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz := now() - interval '365 days';
  v_batch_count integer;
  v_deleted bigint := 0;
begin
  loop
    with expired as (
      select cs.ctid
      from public.customer_searches cs
      where cs.occurred_at < v_cutoff
      order by cs.occurred_at
      limit 1000
    )
    delete from public.customer_searches cs
    using expired
    where cs.ctid = expired.ctid;

    get diagnostics v_batch_count = row_count;
    v_deleted := v_deleted + v_batch_count;
    exit when v_batch_count < 1000;
  end loop;
  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_customer_searches() from public, anon, authenticated;
grant execute on function public.purge_expired_customer_searches() to service_role;

select cron.schedule(
  'customer-searches-retention-365d',
  '17 3 * * *',
  'select public.purge_expired_customer_searches();'
);

comment on function public.purge_expired_customer_searches() is 'Deletes customer_searches older than 365 days in batches of 1000; scheduled daily at 03:17 UTC by pg_cron.';

commit;
