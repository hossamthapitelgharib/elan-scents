-- Platform phase: one meaning of "needs review".
-- The platform dashboard and the order follow-up panel count an order as needing review when its status is
-- needs_review OR its reconciliation is mismatched. platform_store_summary counted only the mismatched ones, so the
-- store panel's "needs review" was lower than the platform's for the same orders. Same signature, same grants
-- (service_role only); only review_order_count changes.
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
       and (r.status = 'needs_review' or r.reconciliation_status = 'mismatched')),
    (select count(*)::bigint from public.store_shipments sh where sh.store_id = s.id)
  from public.stores s
  order by s.name asc, s.id asc;
$function$;

commit;
