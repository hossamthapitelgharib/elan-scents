-- Real-database test for supabase/migrations/20261030114314_platform_store_summary_review_count.sql
-- Run AFTER the migration, as the project owner, inside one transaction. Everything is rolled back.
-- Three synthetic order requests are added to one live store inside the transaction.
begin;

do $$
declare
  v_store uuid;
  v_before record;
  v_after record;
begin
  select id into v_store from public.stores order by name limit 1;
  assert v_store is not null, 'a live store exists to test with';
  select * into v_before from public.platform_store_summary() where store_id = v_store;

  insert into public.store_order_requests (tracking_number, store_id, customer_name, customer_phone, customer_address, status, reconciliation_status)
  values ('TEST-RC-00000001', v_store, 'Test One', '0000000001', 'Nowhere 1', 'needs_review', 'pending'),
         ('TEST-RC-00000002', v_store, 'Test Two', '0000000002', 'Nowhere 2', 'completed', 'mismatched'),
         ('TEST-RC-00000003', v_store, 'Test Three', '0000000003', 'Nowhere 3', 'completed', 'matched'),
         ('TEST-RC-00000004', v_store, 'Test Four', '0000000004', 'Nowhere 4', 'needs_review', 'mismatched'),
         ('TEST-RC-00000005', v_store, 'Test Five', '0000000005', 'Nowhere 5', 'awaiting_store_confirmation', 'pending');
  select * into v_after from public.platform_store_summary() where store_id = v_store;

  assert v_after.review_order_count - v_before.review_order_count = 3, 'needs_review, mismatched, and both together count once each; matched completed and a plain open order do not';
  assert v_after.order_request_count - v_before.order_request_count = 5, 'all five are orders of the store';
  assert v_after.open_order_count - v_before.open_order_count = 1, 'the open count is unchanged in meaning (only the awaiting order is open)';
  assert v_after.review_order_count = (select count(*) from public.store_order_requests r where r.store_id = v_store and (r.status = 'needs_review' or r.reconciliation_status = 'mismatched')), 'the function equals the rule the platform dashboard uses';

  assert not has_function_privilege('anon', 'public.platform_store_summary()', 'execute'), 'anon cannot call it';
  assert not has_function_privilege('authenticated', 'public.platform_store_summary()', 'execute'), 'signed-in users cannot call it';
  assert has_function_privilege('service_role', 'public.platform_store_summary()', 'execute'), 'the server can';
  assert (select prosecdef and proconfig @> array['search_path=public, pg_temp'] from pg_proc where oid = 'public.platform_store_summary()'::regprocedure), 'still security definer with a fixed search_path';

  raise notice 'ALL CHECKS PASSED';
end $$;

rollback;
