-- Real-database integration test for the customer-cart revision CAS migration.
-- Run AFTER the migration is applied, as the project owner, inside one transaction; everything is rolled back.
-- The account is synthetic and catalog rows are read only.
begin;

do $$
declare
  u1 constant uuid := 'f1000000-0000-4000-8000-000000000001';
  u2 constant uuid := 'f1000000-0000-4000-8000-000000000002';
  v_store_product uuid;
  v_initial jsonb;
  v_saved jsonb;
  v_stale jsonb;
  v_after jsonb;
  v_revision bigint;
  v_denied boolean;
begin
  select id into v_store_product from public.store_products order by id limit 1;
  assert v_store_product is not null, 'the catalog has a store product for a safe cart fixture';

  insert into auth.users (id, aud, role, email) values
    (u1, 'authenticated', 'authenticated', 'cart-cas-one@example.invalid'),
    (u2, 'authenticated', 'authenticated', 'cart-cas-two@example.invalid');

  v_initial := public.read_customer_cart_server(u1);
  assert jsonb_typeof(v_initial->'items') = 'array', 'GET RPC returns cart items';
  assert (v_initial->>'revision')::bigint >= 0, 'GET RPC returns a non-negative revision';
  v_revision := (v_initial->>'revision')::bigint;

  v_saved := public.replace_customer_cart_server_cas(
    jsonb_build_array(jsonb_build_object('storeProductId', v_store_product, 'quantity', 4)), v_revision, u1);
  assert (v_saved->>'ok')::boolean and not coalesce((v_saved->>'conflict')::boolean, false), 'the matching revision accepts replacement';
  assert (v_saved->>'revision')::bigint > v_revision, 'a committed replacement advances the revision';
  assert jsonb_array_length(v_saved->'items') = 1, 'the current canonical cart is returned';
  v_revision := (v_saved->>'revision')::bigint;

  -- A second device's stale empty snapshot must not clear the newer cart.
  v_stale := public.replace_customer_cart_server_cas('[]'::jsonb, 0, u1);
  assert not (v_stale->>'ok')::boolean and (v_stale->>'conflict')::boolean, 'stale revision is a clear conflict';
  assert (v_stale->>'revision')::bigint = v_revision, 'conflict returns the current revision';
  assert jsonb_array_length(v_stale->'items') = 1, 'conflict includes the authoritative cart';
  assert (v_stale->'items'->0->>'quantity')::integer = 4, 'the stale empty snapshot changed nothing';
  v_after := public.read_customer_cart_server(u1);
  assert (v_after->>'revision')::bigint = v_revision, 'a conflict does not advance the revision';
  assert (v_after->'items'->0->>'quantity')::integer = 4, 'the latest cart is still intact';

  -- A different account gets its own independent initial revision and empty cart.
  v_after := public.read_customer_cart_server(u2);
  assert jsonb_array_length(v_after->'items') = 0, 'account cart data is isolated';
  assert (v_after->>'revision')::bigint = 0, 'a new account starts at revision zero';

  assert not has_table_privilege('anon', 'public.customer_cart_revisions', 'SELECT'), 'anon cannot inspect revisions';
  assert not has_table_privilege('authenticated', 'public.customer_cart_revisions', 'SELECT'), 'authenticated cannot inspect revisions';
  assert not has_function_privilege('authenticated', 'public.read_customer_cart_server(uuid)', 'EXECUTE'), 'authenticated cannot call the read RPC directly';
  assert not has_function_privilege('authenticated', 'public.replace_customer_cart_server_cas(jsonb,bigint,uuid)', 'EXECUTE'), 'authenticated cannot call the CAS RPC directly';
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_denied := false;
  begin
    perform 1 from public.customer_cart_revisions;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  reset role;
  assert v_denied, 'the revision table is unreadable to a customer';
end $$;

rollback;
