-- Customer-admin detail responses use the immutable server-captured product snapshots.
-- Preserve the existing response shape while keeping event/cart history visible when
-- catalog rows or store offers later change or become unavailable.
create or replace function public.platform_customer_activity_detail(
  p_guest_id uuid,
  p_user_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest public.guest_visitors%rowtype;
  v_profile public.profiles%rowtype;
  v_cart jsonb := '[]'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_sessions jsonb := '[]'::jsonb;
  v_event_total bigint := 0;
  v_session_total bigint := 0;
  v_active_seconds bigint := 0;
begin
  if (p_guest_id is null) = (p_user_id is null) then
    raise exception 'exactly one customer id is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 then
    raise exception 'invalid page';
  end if;

  if p_guest_id is not null then
    select * into v_guest
    from public.guest_visitors gv
    where gv.id = p_guest_id and gv.status = 'guest' and gv.identity_version = 2;
    if not found then return jsonb_build_object('found', false); end if;

    select coalesce(jsonb_agg(jsonb_build_object(
      'quantity', case when coalesce(item.value->>'q', item.value->>'quantity', '') ~ '^[0-9]{1,3}$'
        then greatest(1, least(99, coalesce(item.value->>'q', item.value->>'quantity')::integer)) else 1 end,
      'product', coalesce(
        nullif(item.value->'productSnapshot', 'null'::jsonb),
        nullif(item.value->'productSnapshot', '{}'::jsonb),
        to_jsonb(p), jsonb_build_object('id', ps.product_id)
      ),
      'size', coalesce(
        nullif(item.value->'productSnapshot'->'selectedSize', 'null'::jsonb),
        to_jsonb(ps)
      ),
      'offer', coalesce(
        nullif(item.value->'productSnapshot'->'selectedOffer', 'null'::jsonb),
        case when sp.id is null then null else jsonb_build_object(
          'id', sp.id, 'price', sp.price, 'originalPrice', sp.original_price,
          'currency', sp.currency, 'stockQuantity', sp.stock_quantity,
          'available', sp.is_available, 'productUrl', sp.product_url, 'storeName', st.name
        ) end
      )
    ) order by coalesce(p.name, item.value->'productSnapshot'->>'name', '')),
      '[]'::jsonb)
    into v_cart
    from jsonb_array_elements(coalesce(v_guest.cart_snapshot, '[]'::jsonb)) as item(value)
    left join public.product_sizes ps on ps.id = case
      when coalesce(item.value->>'sid', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (item.value->>'sid')::uuid else null end
    left join public.public_products p on p.id = ps.product_id
    left join public.store_products sp on sp.id = case
      when coalesce(item.value->>'storeProductId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (item.value->>'storeProductId')::uuid else null end
      and sp.product_size_id = ps.id
    left join public.stores st on st.id = sp.store_id;

    select count(*) into v_event_total
    from public.customer_product_events e where e.guest_id = p_guest_id;
    select count(*), coalesce(sum(cs.active_seconds), 0)
      into v_session_total, v_active_seconds
    from public.customer_sessions cs where cs.guest_id = p_guest_id;

    select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
      into v_events
    from (
      select e.id, e.event_type as "eventType", e.occurred_at as "occurredAt",
        e.quantity, e.session_id as "sessionId",
        coalesce(nullif(e.product_snapshot, '{}'::jsonb), to_jsonb(p), jsonb_build_object('id', e.product_id)) as product,
        coalesce(nullif(e.product_snapshot->'selectedSize', 'null'::jsonb), to_jsonb(ps)) as size,
        coalesce(nullif(e.product_snapshot->'selectedOffer', 'null'::jsonb),
          case when sp.id is null then null else jsonb_build_object(
            'id', sp.id, 'price', sp.price, 'originalPrice', sp.original_price,
            'currency', sp.currency, 'stockQuantity', sp.stock_quantity,
            'available', sp.is_available, 'productUrl', sp.product_url, 'storeName', st.name
          ) end) as offer
      from public.customer_product_events e
      left join public.public_products p on p.id = e.product_id
      left join public.product_sizes ps on ps.id = e.product_size_id
      left join public.store_products sp on sp.id = e.store_product_id
      left join public.stores st on st.id = sp.store_id
      where e.guest_id = p_guest_id
      order by e.occurred_at desc, e.id desc
      limit p_limit offset p_offset
    ) x;

    select coalesce(jsonb_agg(jsonb_build_object(
      'sessionId', x.session_id, 'startedAt', x.started_at,
      'lastSeenAt', x.last_seen_at, 'endedAt', x.ended_at,
      'activeSeconds', x.active_seconds
    ) order by x.started_at desc), '[]'::jsonb)
      into v_sessions
    from (
      select cs.session_id, cs.started_at, cs.last_seen_at, cs.ended_at, cs.active_seconds
      from public.customer_sessions cs where cs.guest_id = p_guest_id
      order by cs.started_at desc, cs.session_id desc
      limit p_limit offset p_offset
    ) x;

    return jsonb_build_object(
      'found', true, 'actorType', 'guest',
      'customer', jsonb_build_object('id', v_guest.id, 'fingerprintHash', v_guest.fingerprint_hash,
        'firstSeenAt', v_guest.first_seen_at, 'lastSeenAt', v_guest.last_seen_at),
      'currentCart', v_cart, 'events', v_events, 'sessions', v_sessions,
      'eventTotal', v_event_total, 'visitCount', v_session_total,
      'activeSeconds', v_active_seconds,
      'hasMore', p_offset + p_limit < greatest(v_event_total, v_session_total)
    );
  end if;

  select * into v_profile
  from public.profiles pr where pr.id = p_user_id and pr.role = 'customer';
  if not found then return jsonb_build_object('found', false); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'quantity', ci.quantity,
    'product', coalesce(nullif(ci.product_snapshot, '{}'::jsonb), to_jsonb(p), jsonb_build_object('id', ps.product_id)),
    'size', coalesce(nullif(ci.product_snapshot->'selectedSize', 'null'::jsonb), to_jsonb(ps)),
    'offer', coalesce(nullif(ci.product_snapshot->'selectedOffer', 'null'::jsonb),
      jsonb_build_object('id', sp.id, 'price', sp.price, 'originalPrice', sp.original_price,
        'currency', sp.currency, 'stockQuantity', sp.stock_quantity,
        'available', sp.is_available, 'productUrl', sp.product_url, 'storeName', st.name))
  ) order by coalesce(p.name, ci.product_snapshot->>'name', '')), '[]'::jsonb)
    into v_cart
  from public.cart_items ci
  left join public.store_products sp on sp.id = ci.store_product_id
  left join public.product_sizes ps on ps.id = sp.product_size_id
  left join public.public_products p on p.id = ps.product_id
  left join public.stores st on st.id = sp.store_id
  where ci.user_id = p_user_id;

  select count(*) into v_event_total
  from public.customer_product_events e where e.user_id = p_user_id;
  select count(*), coalesce(sum(cs.active_seconds), 0)
    into v_session_total, v_active_seconds
  from public.customer_sessions cs where cs.user_id = p_user_id;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    into v_events
  from (
    select e.id, e.event_type as "eventType", e.occurred_at as "occurredAt",
      e.quantity, e.session_id as "sessionId",
      coalesce(nullif(e.product_snapshot, '{}'::jsonb), to_jsonb(p), jsonb_build_object('id', e.product_id)) as product,
      coalesce(nullif(e.product_snapshot->'selectedSize', 'null'::jsonb), to_jsonb(ps)) as size,
      coalesce(nullif(e.product_snapshot->'selectedOffer', 'null'::jsonb),
        case when sp.id is null then null else jsonb_build_object(
          'id', sp.id, 'price', sp.price, 'originalPrice', sp.original_price,
          'currency', sp.currency, 'stockQuantity', sp.stock_quantity,
          'available', sp.is_available, 'productUrl', sp.product_url, 'storeName', st.name
        ) end) as offer
    from public.customer_product_events e
    left join public.public_products p on p.id = e.product_id
    left join public.product_sizes ps on ps.id = e.product_size_id
    left join public.store_products sp on sp.id = e.store_product_id
    left join public.stores st on st.id = sp.store_id
    where e.user_id = p_user_id
    order by e.occurred_at desc, e.id desc
    limit p_limit offset p_offset
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
    'sessionId', x.session_id, 'startedAt', x.started_at,
    'lastSeenAt', x.last_seen_at, 'endedAt', x.ended_at,
    'activeSeconds', x.active_seconds
  ) order by x.started_at desc), '[]'::jsonb)
    into v_sessions
  from (
    select cs.session_id, cs.started_at, cs.last_seen_at, cs.ended_at, cs.active_seconds
    from public.customer_sessions cs where cs.user_id = p_user_id
    order by cs.started_at desc, cs.session_id desc
    limit p_limit offset p_offset
  ) x;

  return jsonb_build_object(
    'found', true, 'actorType', 'customer', 'customer', to_jsonb(v_profile),
    'currentCart', v_cart, 'events', v_events, 'sessions', v_sessions,
    'eventTotal', v_event_total, 'visitCount', v_session_total,
    'activeSeconds', v_active_seconds,
    'hasMore', p_offset + p_limit < greatest(v_event_total, v_session_total)
  );
end;
$$;

revoke all on function public.platform_customer_activity_detail(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.platform_customer_activity_detail(uuid, uuid, integer, integer) to service_role;
comment on function public.platform_customer_activity_detail(uuid, uuid, integer, integer) is
  'Service-only customer admin detail; serves immutable full product/cart snapshots and preserves activity history when catalog entries change.';
