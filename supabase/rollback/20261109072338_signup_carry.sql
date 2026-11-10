-- Rollback of 20261109072338_signup_carry.sql. Run only on purpose: it drops the table, so a carry that was not yet taken by its account is lost
-- (the visitor's lists stay in his own browser; nothing else is lost). The guest-cart claim returns to adding quantities (the older behaviour).
begin;

drop function if exists public.claim_signup_carry(uuid);
drop function if exists public.stash_signup_carry(uuid, jsonb, jsonb);
drop table if exists public.signup_carry;

create or replace function public.claim_guest_browser_cart(p_fingerprint_hash text, p_analytics_hash text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_guest public.guest_visitors%rowtype;
  v_item jsonb;
  v_moved integer := 0;
  v_cart jsonb := '[]'::jsonb;
  v_size_id uuid;
  v_store_product_id uuid;
  v_quantity integer;
  v_first_seen date;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$'
     or p_user_id is null then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.role = 'customer') then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;

  select * into v_guest from public.guest_visitors
  where fingerprint_hash = p_fingerprint_hash and status = 'guest' and identity_version = 2
  for update;
  if not found then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(v_guest.cart_snapshot, '[]'::jsonb))
  loop
    begin v_size_id := nullif(v_item->>'sid', '')::uuid; exception when others then v_size_id := null; end;
    begin v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid; exception when others then v_store_product_id := null; end;
    begin v_quantity := greatest(1, least(99, coalesce((v_item->>'q')::integer, 1))); exception when others then v_quantity := 1; end;
    if v_size_id is not null and v_store_product_id is not null and exists (
      select 1 from public.store_products sp where sp.id = v_store_product_id and sp.product_size_id = v_size_id
    ) then
      insert into public.cart_items(user_id, store_product_id, quantity)
      values (p_user_id, v_store_product_id, v_quantity)
      on conflict (user_id, store_product_id) do update
        set quantity = least(99, public.cart_items.quantity + excluded.quantity), updated_at = now();
      v_moved := v_moved + 1;
    end if;
  end loop;

  -- Preserve every detailed session, product operation, and search under the account ID.
  update public.customer_sessions set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;
  update public.customer_product_events set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;
  update public.customer_searches set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;

  v_first_seen := coalesce((select min(activity_date) from public.guest_analytics_visits where visitor_hash = p_analytics_hash),
                           (v_guest.first_seen_at at time zone 'Africa/Cairo')::date);
  insert into public.guest_conversions (visitor_hash, user_id, first_seen_date, converted_on)
  values (
    encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'),
    p_user_id, v_first_seen, (now() at time zone 'Africa/Cairo')::date);

  -- the browser's identity and every anonymous trace of it go away
  delete from public.guest_product_analytics where visitor_hash = p_analytics_hash;
  delete from public.guest_analytics_visits where visitor_hash = p_analytics_hash;
  delete from public.guest_fingerprints where analytics_hash = p_analytics_hash;
  delete from public.guest_identity_links where hash_a = p_analytics_hash or hash_b = p_analytics_hash;
  delete from public.guest_visitors where id = v_guest.id;

  select coalesce(jsonb_agg(jsonb_build_object('sid', sp.product_size_id, 'storeProductId', sp.id, 'q', ci.quantity)), '[]'::jsonb)
    into v_cart from public.cart_items ci join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = p_user_id;
  return jsonb_build_object('claimed', true, 'cart', v_moved, 'items', jsonb_array_length(v_cart), 'snapshot', v_cart);
end;
$function$;

commit;
