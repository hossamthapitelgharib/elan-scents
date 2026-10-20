-- Real-database test for supabase/migrations/20261020115120_harden_adjustment_trigger_fn_and_add_fk_indexes.sql
-- Run AFTER the migration inside one transaction. Everything is rolled back; no data is created.
begin;

do $$
declare
  fk record;
begin
  -- The trigger function is no longer an RPC for clients, and the trigger itself still exists and is enabled.
  assert not has_function_privilege('anon', 'public.validate_store_order_item_adjustment()', 'execute'), 'anon cannot execute the trigger function';
  assert not has_function_privilege('authenticated', 'public.validate_store_order_item_adjustment()', 'execute'), 'signed-in users cannot execute the trigger function';
  assert exists (select 1 from pg_trigger where tgname = 'validate_store_order_item_adjustment_trigger' and tgenabled = 'O' and not tgisinternal), 'the adjustment validation trigger is still enabled';

  -- The policy keeps its rule but evaluates auth.uid() once per statement.
  assert exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'store_shipments'
                   and policyname = 'store_shipments_owner_read' and cmd = 'SELECT' and roles = '{authenticated}'
                   and qual ilike '%select auth.uid()%'), 'store_shipments_owner_read uses (select auth.uid())';

  -- Every foreign key we covered has an index whose leading columns are the key columns.
  for fk in
    select c.conrelid, c.conname, c.conkey
    from pg_constraint c
    where c.contype = 'f' and c.conname in (
      'customer_product_events_session_id_fkey', 'customer_product_events_product_size_id_fkey',
      'customer_product_events_store_product_id_fkey', 'customer_searches_session_id_fkey',
      'store_order_item_adjustments_created_by_fkey', 'store_order_item_adjustments_item_request_fkey')
  loop
    assert exists (
      select 1 from pg_index i
      where i.indrelid = fk.conrelid and i.indpred is null
        and (i.indkey::int2[])[0:array_length(fk.conkey, 1) - 1] = fk.conkey
    ), 'foreign key ' || fk.conname || ' has a covering index';
  end loop;

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
