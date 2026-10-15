-- Real Supabase integration test for customer activity, carts, and product snapshots.
-- Every synthetic write is inside an exception subtransaction and the entire file
-- is additionally wrapped in BEGIN/ROLLBACK. A deliberate sentinel exception
-- forces rollback before assertions verify no fixture rows remain.
-- Only one existing store-product/size/product ID is read; no customer data is
-- read or modified, and no external Auth/email API is invoked.

begin;

do $customer_activity_fixture$
declare
  v_guest_hash text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  v_analytics_hash text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  v_guest_id uuid;
  v_customer_id uuid := gen_random_uuid();
  v_guest_session uuid := gen_random_uuid();
  v_customer_session uuid := gen_random_uuid();
  v_store_product_id uuid;
  v_product_size_id uuid;
  v_product_id uuid;
  v_customer_role text;
  v_cart_result jsonb;
  v_search_result jsonb;
  v_search_ok boolean;
  v_claim_result jsonb;
  v_search_detail jsonb;
  v_retention_deleted bigint;
  v_event_ok boolean;
  v_event_type text;
  v_sentinel constant text := 'customer_activity_fixture_force_rollback';
begin
  begin
    select sp.id, sp.product_size_id, ps.product_id
      into v_store_product_id, v_product_size_id, v_product_id
    from public.store_products sp
    join public.product_sizes ps on ps.id = sp.product_size_id
    order by sp.id
    limit 1;

    if v_product_id is null then
      raise exception 'fixture requires one existing store product with a valid size';
    end if;

    -- The only auth.users trigger was verified to insert a local profile row.
    -- Both auth.users and profiles are rolled back with this subtransaction.
    insert into auth.users (
      id, aud, role, email, encrypted_password, raw_app_meta_data,
      raw_user_meta_data, email_confirmed_at, created_at, updated_at
    ) values (
      v_customer_id, 'authenticated', 'authenticated',
      'fixture-' || v_customer_id::text || '@example.invalid', '',
      '{}'::jsonb, '{"full_name":"transactional-fixture"}'::jsonb,
      now(), now(), now()
    );

    select p.role into v_customer_role
    from public.profiles p
    where p.id = v_customer_id
    limit 1;
    if v_customer_role is distinct from 'customer' then
      raise exception 'synthetic customer profile was not created with customer role';
    end if;

    v_cart_result := public.save_guest_browser_cart(
      v_guest_hash,
      v_analytics_hash,
      jsonb_build_array(jsonb_build_object(
        'sid', v_product_size_id,
        'storeProductId', v_store_product_id,
        'q', 2
      ))
    );
    v_guest_id := nullif(v_cart_result->>'visitorId', '')::uuid;
    if v_guest_id is null or jsonb_array_length(coalesce(v_cart_result->'cart', '[]'::jsonb)) <> 1 then
      raise exception 'guest cart persistence did not return the fixture basket';
    end if;
    if not exists (
      select 1 from public.guest_current_cart_items c
      where c.guest_id = v_guest_id
        and c.quantity = 2
        and c.product_snapshot is not null
        and c.product_snapshot <> '{}'::jsonb
      limit 1
    ) then
      raise exception 'guest current-cart view omitted its authoritative product snapshot';
    end if;

    foreach v_event_type in array array['view', 'search', 'cart_add', 'cart_remove'] loop
      v_event_ok := public.record_customer_product_event(
        v_guest_hash, v_analytics_hash, null, v_guest_session,
        v_event_type, v_product_id, v_product_size_id, v_store_product_id,
        case when v_event_type in ('cart_add', 'cart_remove') then 1 else null end
      );
      if v_event_ok is distinct from true then
        raise exception 'guest event RPC rejected fixture event type %', v_event_type;
      end if;

      v_event_ok := public.record_customer_product_event(
        null, null, v_customer_id, v_customer_session,
        v_event_type, v_product_id, v_product_size_id, v_store_product_id,
        case when v_event_type in ('cart_add', 'cart_remove') then 1 else null end
      );
      if v_event_ok is distinct from true then
        raise exception 'registered-customer event RPC rejected fixture event type %', v_event_type;
      end if;
    end loop;

    if not exists (select 1 from public.customer_product_view_events where guest_id = v_guest_id and product_snapshot <> '{}'::jsonb limit 1)
       or not exists (select 1 from public.customer_product_search_events where guest_id = v_guest_id and product_snapshot <> '{}'::jsonb limit 1)
       or not exists (select 1 from public.customer_product_cart_add_events where guest_id = v_guest_id and product_snapshot <> '{}'::jsonb limit 1)
       or not exists (select 1 from public.customer_product_cart_remove_events where guest_id = v_guest_id and product_snapshot <> '{}'::jsonb limit 1) then
      raise exception 'one or more guest event category views failed to expose snapshots';
    end if;

    if not exists (select 1 from public.customer_product_view_events where user_id = v_customer_id and product_snapshot <> '{}'::jsonb limit 1)
       or not exists (select 1 from public.customer_product_search_events where user_id = v_customer_id and product_snapshot <> '{}'::jsonb limit 1)
       or not exists (select 1 from public.customer_product_cart_add_events where user_id = v_customer_id and product_snapshot <> '{}'::jsonb limit 1)
       or not exists (select 1 from public.customer_product_cart_remove_events where user_id = v_customer_id and product_snapshot <> '{}'::jsonb limit 1) then
      raise exception 'one or more registered-customer event category views failed to expose snapshots';
    end if;

    v_search_ok := public.record_customer_search(
      v_guest_hash, v_analytics_hash, null, v_guest_session,
      'عطر تجريبي للزائر', jsonb_build_array(jsonb_build_object(
        'productId', v_product_id, 'productSizeId', v_product_size_id, 'storeProductId', v_store_product_id
      ))
    );
    if v_search_ok is distinct from true then raise exception 'guest search operation was not recorded'; end if;
    v_search_ok := public.record_customer_search(
      v_guest_hash, v_analytics_hash, null, v_guest_session, 'بحث بلا نتائج', '[]'::jsonb
    );
    if v_search_ok is distinct from true then raise exception 'guest no-result search operation was not recorded'; end if;
    v_search_ok := public.record_customer_search(
      null, null, v_customer_id, v_customer_session,
      'عطر تجريبي للعميل', jsonb_build_array(jsonb_build_object(
        'productId', v_product_id, 'productSizeId', v_product_size_id, 'storeProductId', v_store_product_id
      ))
    );
    if v_search_ok is distinct from true then raise exception 'registered-customer search operation was not recorded'; end if;

    select to_jsonb(cs) into v_search_result from public.customer_searches cs
    where cs.guest_id = v_guest_id and cs.search_text = 'عطر تجريبي للزائر' limit 1;
    if v_search_result is null
       or v_search_result->>'result_count' <> '1'
       or v_search_result->'result_products'->0->'product' = '{}'::jsonb then
      raise exception 'guest query did not preserve its complete authoritative result snapshot';
    end if;
    if not exists (
      select 1 from public.customer_searches cs
      where cs.guest_id = v_guest_id and cs.search_text = 'بحث بلا نتائج'
        and cs.result_count = 0 and cs.result_products = '[]'::jsonb limit 1
    ) then raise exception 'zero-result search operation was not retained'; end if;

    v_search_detail := public.platform_customer_search_detail(v_guest_id, null, 100, 0);
    if (v_search_detail->>'searchTotal')::integer <> 2
       or jsonb_array_length(v_search_detail->'searches') <> 2 then
      raise exception 'admin detail RPC did not return all guest search operations';
    end if;
    v_search_detail := public.platform_customer_search_detail(null, v_customer_id, 100, 0);
    if (v_search_detail->>'searchTotal')::integer <> 1 then
      raise exception 'admin detail RPC did not return registered-customer searches';
    end if;

    insert into public.customer_searches(guest_id, user_id, session_id, search_text, result_products, result_count, occurred_at)
    values
      (v_guest_id, null, v_guest_session, 'اختبار منتهي الاحتفاظ', '[]'::jsonb, 0, now() - interval '366 days'),
      (v_guest_id, null, v_guest_session, 'اختبار داخل الاحتفاظ', '[]'::jsonb, 0, now() - interval '364 days');
    v_retention_deleted := public.purge_expired_customer_searches();
    if v_retention_deleted <> 1
       or exists (select 1 from public.customer_searches where guest_id = v_guest_id and search_text = 'اختبار منتهي الاحتفاظ' limit 1)
       or not exists (select 1 from public.customer_searches where guest_id = v_guest_id and search_text = 'اختبار داخل الاحتفاظ' limit 1) then
      raise exception '365-day retention did not delete only the expired search row';
    end if;

    if not exists (
      select 1 from public.guest_product_analytics a
      where a.visitor_hash = v_analytics_hash
        and a.product_id = v_product_id
        and a.event_count = 2
        and a.product_snapshot <> '{}'::jsonb
      limit 1
    ) then
      raise exception 'guest ranking aggregate did not persist its event and snapshot';
    end if;

    insert into public.cart_items (user_id, store_product_id, quantity)
    values (v_customer_id, v_store_product_id, 2);
    if not exists (
      select 1 from public.registered_customer_current_cart_items c
      where c.user_id = v_customer_id
        and c.store_product_id = v_store_product_id
        and c.quantity = 2
        and c.product_snapshot <> '{}'::jsonb
      limit 1
    ) then
      raise exception 'registered current-cart view omitted its trigger-built product snapshot';
    end if;

    if not exists (select 1 from public.customer_sessions s where s.session_id = v_guest_session and s.guest_id = v_guest_id and s.user_id is null limit 1)
       or not exists (select 1 from public.customer_sessions s where s.session_id = v_customer_session and s.user_id = v_customer_id and s.guest_id is null limit 1) then
      raise exception 'guest and registered-customer visits were not separated into sessions';
    end if;

    v_claim_result := public.claim_guest_browser_cart(v_guest_hash, v_customer_id);
    if coalesce((v_claim_result->>'claimed')::boolean, false) is not true then
      raise exception 'guest claim did not complete';
    end if;
    if exists (select 1 from public.guest_visitors where id = v_guest_id limit 1)
       or not exists (select 1 from public.customer_searches where user_id = v_customer_id and guest_id is null and search_text = 'عطر تجريبي للزائر' limit 1)
       or not exists (select 1 from public.customer_searches where user_id = v_customer_id and guest_id is null and search_text = 'بحث بلا نتائج' limit 1) then
      raise exception 'guest search history was not transferred to the registered customer';
    end if;

    raise exception using errcode = 'P0001', message = v_sentinel;
  exception when others then
    if sqlerrm <> v_sentinel then
      raise;
    end if;
  end;

  -- Verify the exception subtransaction really removed every synthetic record.
  if exists (select 1 from auth.users where id = v_customer_id limit 1)
     or exists (select 1 from public.profiles where id = v_customer_id limit 1)
     or exists (select 1 from public.guest_visitors where fingerprint_hash = v_guest_hash limit 1)
     or exists (select 1 from public.customer_sessions where session_id in (v_guest_session, v_customer_session) limit 1)
     or exists (select 1 from public.customer_product_events where user_id = v_customer_id or guest_id = v_guest_id limit 1)
     or exists (select 1 from public.customer_searches where user_id = v_customer_id or guest_id = v_guest_id limit 1)
     or exists (select 1 from public.guest_product_analytics where visitor_hash = v_analytics_hash limit 1)
     or exists (select 1 from public.cart_items where user_id = v_customer_id limit 1) then
    raise exception 'synthetic fixture data remained after the rollback subtransaction';
  end if;
end;
$customer_activity_fixture$;

rollback;
