begin;

-- A live, read-only database relation for the all-time registered-customer best-seller table.
-- It derives rankings from authoritative order snapshots so status/reconciliation changes are
-- reflected immediately and no separately maintained counter can become stale.
create or replace view public.registered_customer_best_sellers
with (security_invoker = true) as
with eligible_lines as (
  select i.product_id,
         i.product_name,
         i.brand_name,
         i.size_label,
         i.quantity,
         coalesce(r.checkout_session_id, r.id) as purchase_id,
         r.store_id,
         r.created_at
  from public.store_order_request_items i
  join public.store_order_requests r on r.id = i.request_id
  left join public.checkout_sessions cs on cs.id = r.checkout_session_id
  where coalesce(r.user_id, cs.user_id) is not null
    and not (r.user_id is not null and cs.user_id is not null and r.user_id <> cs.user_id)
    and i.quantity > 0
    and ((r.status = 'completed' and r.reconciliation_status = 'matched')
      or (r.status = 'delivered' and r.reconciliation_status in ('matched','pending')))
    and r.created_at < (((now() at time zone 'Africa/Cairo')::date + 1)::timestamp at time zone 'Africa/Cairo')
), size_totals as (
  select product_id,
         coalesce(nullif(size_label,''),'غير محدد') as size_label,
         sum(quantity)::bigint as units
  from eligible_lines
  where product_id is not null
  group by product_id, coalesce(nullif(size_label,''),'غير محدد')
), size_breakdowns as (
  select product_id,
         jsonb_agg(jsonb_build_object('size',size_label,'units',units) order by size_label) as size_breakdown
  from size_totals
  group by product_id
), latest_snapshots as (
  select product_id,
         (array_agg(product_name order by created_at desc) filter (where nullif(product_name,'') is not null))[1] as snapshot_name,
         (array_agg(brand_name order by created_at desc) filter (where nullif(brand_name,'') is not null))[1] as snapshot_brand
  from eligible_lines
  where product_id is not null
  group by product_id
), product_totals as (
  select product_id,
         sum(quantity)::bigint as units_sold,
         count(distinct purchase_id)::bigint as purchase_count,
         count(distinct store_id)::bigint as store_count
  from eligible_lines
  where product_id is not null
  group by product_id
)
select row_number() over (order by pt.units_sold desc, pt.purchase_count desc, pt.product_id asc)::bigint as rank,
       pt.product_id,
       coalesce(nullif(p.name,''), ls.snapshot_name, 'عطر محذوف من الكتالوج') as product_name,
       coalesce(nullif(b.name,''), ls.snapshot_brand) as brand_name,
       p.slug,
       pt.units_sold,
       pt.purchase_count,
       pt.store_count,
       sb.size_breakdown
from product_totals pt
join size_breakdowns sb on sb.product_id = pt.product_id
left join public.products p on p.id = pt.product_id
left join public.brands b on b.id = p.brand_id
left join latest_snapshots ls on ls.product_id = pt.product_id;

comment on view public.registered_customer_best_sellers is
  'Live server-only view of all-time perfume-unit rankings from eligible registered-customer orders; based on immutable product snapshots and recalculated as order reconciliation/status changes.';

revoke all privileges on table public.registered_customer_best_sellers from public, anon, authenticated;
grant select on table public.registered_customer_best_sellers to service_role;

commit;
