begin;

-- Customer activity is private application data. Reads go through platform-admin APIs using service_role.
revoke all on table public.guest_visitors, public.customer_sessions, public.customer_product_events
  from anon, authenticated;
revoke select on table public.profiles, public.cart_items from anon;

-- Aggregate store-operational metadata only; never expose customer PII through this RPC.
create or replace function public.platform_store_summary()
returns table (
  store_id uuid,
  linked_accounts bigint,
  product_count bigint,
  available_product_count bigint,
  active_offer_count bigint,
  order_request_count bigint,
  open_order_count bigint,
  review_order_count bigint,
  shipment_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id,
    (select count(*)::bigint from public.store_accounts sa where sa.store_id = s.id),
    (select count(*)::bigint from public.store_products sp where sp.store_id = s.id),
    (select count(*)::bigint from public.store_products sp where sp.store_id = s.id and sp.is_available),
    (select count(*)::bigint from public.offers o where o.store_id = s.id and o.is_active
       and (o.start_date is null or o.start_date <= now())
       and (o.end_date is null or o.end_date >= now())),
    (select count(*)::bigint from public.store_order_requests r where r.store_id = s.id),
    (select count(*)::bigint from public.store_order_requests r where r.store_id = s.id
       and r.status in ('awaiting_store_confirmation','store_confirmed','processing','shipped')),
    (select count(*)::bigint from public.store_order_requests r where r.store_id = s.id
       and r.reconciliation_status = 'mismatched'),
    (select count(*)::bigint from public.store_shipments sh where sh.store_id = s.id)
  from public.stores s
  order by s.name asc, s.id asc;
$$;

revoke all on function public.platform_store_summary() from public, anon, authenticated;
grant execute on function public.platform_store_summary() to service_role;

commit;
