begin;

create or replace view public.platform_commission_watch with (security_invoker = true) as
select r.id as request_id, r.tracking_number, r.store_id, r.status, r.reconciliation_status,
       r.created_at, r.updated_at, f.flag
from public.store_order_requests r
left join public.store_shipments sh on sh.request_id = r.id
cross join lateral (values
  ('no_store_report', r.status = 'awaiting_store_confirmation' and r.created_at < now() - interval '3 days'),
  ('stuck_in_review', r.status = 'needs_review' and r.updated_at < now() - interval '2 days'),
  ('report_mismatched', r.status = 'needs_review'
      and lower(coalesce(r.latest_store_payload->>'status', '')) in ('completed', 'success', 'succeeded', 'paid', 'confirmed')),
  ('customer_confirmed_unreported', r.customer_confirmed_at is not null
      and r.status in ('awaiting_store_confirmation', 'store_confirmed', 'processing', 'needs_review')),
  ('rejected_but_customer_confirmed', r.customer_confirmed_at is not null
      and r.status in ('store_rejected', 'store_cancelled', 'cancelled')),
  ('rejected_but_shipped', r.status in ('store_rejected', 'store_cancelled', 'cancelled')
      and sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delivered')),
  ('reversed_after_sale', r.mismatch_fields ? 'reversal_after_sale'
      or (r.status in ('store_rejected', 'store_cancelled', 'cancelled') and exists (
            select 1 from public.commissions c join public.store_order_request_items i on i.id = c.store_order_request_item_id
            where i.request_id = r.id))),
  ('delivery_not_confirmed', sh.shipping_status in ('handed_to_carrier', 'in_transit', 'out_for_delivery', 'delayed')
      and sh.updated_at < now() - interval '14 days'),
  ('delivered_unverified', sh.shipping_status = 'delivered' and sh.delivery_verified_at is null
      and sh.updated_at < now() - interval '3 days'),
  ('below_catalog_total', r.total_amount is not null and r.total_amount + 0.005 < r.subtotal)
) as f(flag, hit)
where f.hit;

revoke all on public.platform_commission_watch from public, anon, authenticated;
grant select on public.platform_commission_watch to service_role;

create or replace function public.platform_store_order_health(p_days integer default 90)
returns table (store_id uuid, store_name text, orders bigint, reported bigint, rejected bigint, needs_review bigint,
               awaiting_over_3d bigint, customer_confirmed_unreported bigint, commission_total numeric)
language sql
stable
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
  select s.id, s.name,
         count(r.id),
         count(*) filter (where r.reconciliation_status = 'matched' and r.status in ('completed', 'shipped', 'delivered')),
         count(*) filter (where r.status in ('store_rejected', 'store_cancelled', 'cancelled')),
         count(*) filter (where r.status = 'needs_review'),
         count(*) filter (where r.status = 'awaiting_store_confirmation' and r.created_at < now() - interval '3 days'),
         count(*) filter (where r.customer_confirmed_at is not null
                            and r.status in ('awaiting_store_confirmation', 'store_confirmed', 'processing', 'needs_review')),
         coalesce(sum(cm.amount), 0)
  from public.stores s
  left join public.store_order_requests r
    on r.store_id = s.id and r.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 1000)))
  left join lateral (
    select sum(c.amount) as amount
    from public.commissions c join public.store_order_request_items i on i.id = c.store_order_request_item_id
    where i.request_id = r.id
  ) cm on true
  group by s.id, s.name
  order by s.name
$function$;

revoke all on function public.platform_store_order_health(integer) from public, anon, authenticated;
grant execute on function public.platform_store_order_health(integer) to service_role;

comment on view public.platform_commission_watch is 'Orders where the store''s report, the customer''s word and the carrier disagree. Reads the unified commission ledger; service_role only.';

do $check$
begin
  if not exists (select 1 from information_schema.views where table_schema = 'public' and table_name = 'platform_commission_watch')
     or has_table_privilege('authenticated', 'public.platform_commission_watch', 'select')
     or has_function_privilege('authenticated', 'public.platform_store_order_health(integer)', 'execute') then
    raise exception 'the commission watch list was not installed closed to clients';
  end if;
end
$check$;

commit;