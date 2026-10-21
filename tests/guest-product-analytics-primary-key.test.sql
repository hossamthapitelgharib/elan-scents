-- Real-database test for supabase/migrations/<version>_guest_product_analytics_primary_key.sql
-- Run AFTER the migration inside one transaction. Everything is rolled back; the rows below are synthetic.
begin;

do $$
declare
  v_hash constant text := repeat('a', 64);
  v_product constant uuid := '00000000-0000-4000-8000-000000000001';
  v_count integer;
begin
  -- The table now has a primary key over the natural key, in this column order.
  assert exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.guest_product_analytics'::regclass and c.contype = 'p'
      and (select array_agg(a.attname::text order by k.ord)
             from unnest(c.conkey) with ordinality k(attnum, ord)
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
          = array['visitor_hash', 'product_id', 'activity_date', 'event_type']
  ), 'guest_product_analytics has a primary key on (visitor_hash, product_id, activity_date, event_type)';

  -- The old UNIQUE constraint is gone (the primary key replaced it, no duplicate index is left behind).
  assert not exists (
    select 1 from pg_constraint
    where conrelid = 'public.guest_product_analytics'::regclass
      and conname = 'guest_product_analytics_visitor_hash_product_id_activity_da_key'
  ), 'the old unique constraint was replaced';
  assert (select count(*) from pg_index where indrelid = 'public.guest_product_analytics'::regclass and indisunique) = 1,
    'exactly one unique index remains';

  -- The upsert form used by the tracking functions still resolves its conflict target.
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count, product_snapshot)
  values (v_hash, v_product, date '2026-01-01', 'view', 1, '{}'::jsonb)
  on conflict (visitor_hash, product_id, activity_date, event_type)
  do update set event_count = public.guest_product_analytics.event_count + 1;
  insert into public.guest_product_analytics (visitor_hash, product_id, activity_date, event_type, event_count, product_snapshot)
  values (v_hash, v_product, date '2026-01-01', 'view', 1, '{}'::jsonb)
  on conflict (visitor_hash, product_id, activity_date, event_type)
  do update set event_count = public.guest_product_analytics.event_count + 1;

  select event_count into v_count from public.guest_product_analytics
  where visitor_hash = v_hash and product_id = v_product and activity_date = date '2026-01-01' and event_type = 'view';
  assert v_count = 2, 'the second upsert added to the same row instead of inserting a duplicate';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
