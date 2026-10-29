begin;

-- Owner decision of 2026-10-28: nothing that belongs to a registered customer is deleted automatically.
-- The daily search purge (customer-searches-retention-365d, 03:17 UTC) used to delete every search older than 365 days,
-- registered customers' included. It now deletes only the searches of visitors who never registered
-- (user_id is null, which the exactly-one-actor constraint makes the same as guest_id is not null).
-- Grants are unchanged (create or replace keeps them); the schedule is unchanged.

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
        and cs.user_id is null
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

comment on function public.purge_expired_customer_searches() is 'Deletes searches of unregistered visitors (user_id is null) older than 365 days in batches of 1000; searches of registered customers are never deleted automatically (owner decision of 2026-10-28); scheduled daily at 03:17 UTC by pg_cron.';

commit;
