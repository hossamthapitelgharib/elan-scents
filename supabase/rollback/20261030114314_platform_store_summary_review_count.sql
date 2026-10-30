-- Rolls back migrations/20261030114314_platform_store_summary_review_count.sql.
-- review_order_count goes back to counting only reconciliation_status = 'mismatched', so the store panel's
-- "needs review" is again lower than the platform dashboard's for orders whose status is needs_review.
begin;

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
set search_path to 'public', 'pg_temp'
as $function$
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
$function$;

commit;
