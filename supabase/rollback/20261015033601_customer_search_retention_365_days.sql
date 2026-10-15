-- ROLLBACK for supabase/migrations/20261015033601_customer_search_retention_365_days.sql
-- Run manually only if the project owner requests it. Already-deleted rows cannot be restored by this rollback.

begin;

select cron.unschedule(jobid)
from cron.job
where jobname = 'customer-searches-retention-365d';

drop function if exists public.purge_expired_customer_searches();
drop index if exists public.customer_searches_occurred_at_idx;

-- Keep pg_cron installed; it may be shared by other project jobs.
commit;
