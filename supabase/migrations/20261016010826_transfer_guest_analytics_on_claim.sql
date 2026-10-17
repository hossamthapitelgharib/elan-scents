begin;

-- The detailed ledgers are reassigned to the registered customer below. The separate
-- guest aggregates are only a second copy used for anonymous rankings, so remove them
-- in the same transaction to prevent the converted customer remaining counted as a guest.
-- Keep the existing two-argument RPC during rollout; deployed older API instances can
-- continue using it until the updated API starts calling this three-argument overload.

create function public.claim_guest_browser_cart(
  p_fingerprint_hash text,
  p_analytics_hash text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_guest public.guest_visitors%rowtype;
  v_item jsonb;
  v_moved integer := 0;
  v_cart jsonb := '[]'::jsonb;
  v_size_id uuid;
  v_store_product_id uuid;
  v_quantity integer;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$'
     or p_user_id is null then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;
  if not exists (
    select 1 from public.profiles pr where pr.id = p_user_id and pr.role = 'customer'
  ) then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;

  select * into v_guest
  from public.guest_visitors
  where fingerprint_hash = p_fingerprint_hash
    and status = 'guest'
    and identity_version = 2
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;

  for v_item in
    select value from jsonb_array_elements(coalesce(v_guest.cart_snapshot, '[]'::jsonb))
  loop
    begin
      v_size_id := nullif(v_item->>'sid', '')::uuid;
    exception when others then
      v_size_id := null;
    end;
    begin
      v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid;
    exception when others then
      v_store_product_id := null;
    end;
    begin
      v_quantity := greatest(1, least(99, coalesce((v_item->>'q')::integer, 1)));
    exception when others then
      v_quantity := 1;
    end;

    if v_size_id is not null and v_store_product_id is not null and exists (
      select 1 from public.store_products sp
      where sp.id = v_store_product_id and sp.product_size_id = v_size_id
    ) then
      insert into public.cart_items(user_id, store_product_id, quantity)
      values (p_user_id, v_store_product_id, v_quantity)
      on conflict (user_id, store_product_id) do update
        set quantity = least(99, public.cart_items.quantity + excluded.quantity),
            updated_at = now();
      v_moved := v_moved + 1;
    end if;
  end loop;

  -- Preserve every detailed session, product operation, and search under the account ID.
  update public.customer_sessions
  set guest_id = null, user_id = p_user_id
  where guest_id = v_guest.id;
  update public.customer_product_events
  set guest_id = null, user_id = p_user_id
  where guest_id = v_guest.id;
  update public.customer_searches
  set guest_id = null, user_id = p_user_id
  where guest_id = v_guest.id;

  -- The registered rankings use customer_product_events; these anonymous aggregates
  -- duplicate those operations and must no longer contribute to guest rankings.
  delete from public.guest_product_analytics
  where visitor_hash = p_analytics_hash;
  delete from public.guest_analytics_visits
  where visitor_hash = p_analytics_hash;
  delete from public.guest_visitors
  where id = v_guest.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'sid', sp.product_size_id,
      'storeProductId', sp.id,
      'q', ci.quantity
    )), '[]'::jsonb)
  into v_cart
  from public.cart_items ci
  join public.store_products sp on sp.id = ci.store_product_id
  where ci.user_id = p_user_id;

  return jsonb_build_object(
    'claimed', true,
    'cart', v_moved,
    'items', jsonb_array_length(v_cart),
    'snapshot', v_cart
  );
end;
$$;

revoke all on function public.claim_guest_browser_cart(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_guest_browser_cart(text, text, uuid)
  to service_role;

comment on function public.claim_guest_browser_cart(text, text, uuid) is
  'Atomically transfers a guest cart and detailed activity to its authenticated customer, then removes anonymous ranking aggregates.';

notify pgrst, 'reload schema';
commit;
