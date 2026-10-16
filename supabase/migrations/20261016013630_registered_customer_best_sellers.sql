begin;

-- Keep a product identity on the order line even if catalog relationships later change.
alter table public.store_order_request_items
  add column if not exists product_id uuid;

-- Backfill the immutable product identity from existing size/offer links where available.
update public.store_order_request_items i
set product_id = ps.product_id
from public.product_sizes ps
where i.product_id is null
  and i.product_size_id = ps.id;

update public.store_order_request_items i
set product_id = ps.product_id
from public.store_products sp
join public.product_sizes ps on ps.id = sp.product_size_id
where i.product_id is null
  and i.store_product_id = sp.id;

create index if not exists store_order_request_items_product_id_request_idx
  on public.store_order_request_items (product_id, request_id);

comment on column public.store_order_request_items.product_id is
  'Immutable base perfume UUID captured at sale time; intentionally has no catalog foreign key so sales remain attributable after catalog changes.';

-- All newly submitted order lines snapshot the canonical catalog identity, not client-supplied names.
create or replace function public.create_store_order_request(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_request public.store_order_requests;
  v_item jsonb;
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_sp public.store_products;
  v_store_id uuid;
  v_user_id uuid := auth.uid();
  v_session_id uuid := nullif(p_payload->>'checkoutSessionId', '')::uuid;
  v_size_id uuid;
  v_store_product_id uuid;
  v_product_id uuid;
  v_product_name text;
  v_brand_name text;
  v_size_label text;
  v_qty integer;
  v_line numeric;
  v_subtotal numeric := 0;
  v_currency text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  v_store_id := (p_payload->>'storeId')::uuid;
  if not exists (select 1 from public.stores s where s.id = v_store_id and s.status = 'active') then
    raise exception 'Invalid or inactive store';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'), '') = '' or coalesce(trim(p_payload->'customer'->>'phone'), '') = '' or coalesce(trim(p_payload->'customer'->>'address'), '') = '' then
    raise exception 'Customer details are required';
  end if;
  if coalesce(trim(p_payload->>'trackingNumber'), '') = '' then
    raise exception 'Tracking number is required';
  end if;
  if jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_array_length(p_payload->'items') = 0 then
    raise exception 'Order items are required';
  end if;
  if v_session_id is not null and not exists (select 1 from public.checkout_sessions cs where cs.id = v_session_id and cs.user_id = v_user_id) then
    raise exception 'Checkout session not found';
  end if;

  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    v_size_id := nullif(v_item->>'productSizeId', '')::uuid;
    v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid;
    v_qty := (v_item->>'quantity')::integer;
    if v_size_id is null or v_qty is null or v_qty < 1 then
      raise exception 'Invalid order item';
    end if;
    select * into v_sp from public.store_products sp
      where sp.store_id = v_store_id
        and sp.product_size_id = v_size_id
        and (v_store_product_id is null or sp.id = v_store_product_id)
      limit 1;
    if not found then
      raise exception 'Product is not offered by this store';
    end if;
    if not v_sp.is_available or (v_sp.stock_quantity is not null and v_sp.stock_quantity < v_qty) then
      raise exception 'Product is unavailable or has insufficient stock';
    end if;
    select ps.product_id, p.name, b.name, ps.size_label
      into v_product_id, v_product_name, v_brand_name, v_size_label
    from public.product_sizes ps
    join public.products p on p.id = ps.product_id
    left join public.brands b on b.id = p.brand_id
    where ps.id = v_sp.product_size_id
    limit 1;
    if not found or v_product_id is null then
      raise exception 'Product catalog identity is unavailable';
    end if;
    if abs(coalesce((v_item->>'unitPrice')::numeric, -1) - v_sp.price) > 0.005 then
      raise exception 'Price changed for product %', v_size_id;
    end if;
    v_line := round(v_sp.price * v_qty, 2);
    if abs(coalesce((v_item->>'total')::numeric, -1) - v_line) > 0.005 then
      raise exception 'Line total mismatch for product %', v_size_id;
    end if;
    if v_currency is null then
      v_currency := v_sp.currency;
    elsif v_currency <> v_sp.currency then
      raise exception 'Mixed currencies are not supported';
    end if;
    v_subtotal := v_subtotal + v_line;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'sp_id', v_sp.id, 'size_id', v_sp.product_size_id, 'product_id', v_product_id,
      'name', v_product_name, 'brand', v_brand_name, 'size', v_size_label,
      'qty', v_qty, 'unit', v_sp.price, 'line', v_line, 'currency', v_sp.currency));
  end loop;

  if p_payload ? 'subtotal' and abs(coalesce((p_payload->>'subtotal')::numeric, -1) - v_subtotal) > 0.005 then
    raise exception 'Subtotal mismatch';
  end if;

  insert into public.store_order_requests (tracking_number, checkout_tracking_number, checkout_session_id, store_id, user_id, customer_name, customer_phone, customer_email, customer_address, customer_notes, subtotal, currency, initial_payload)
  values (p_payload->>'trackingNumber', coalesce(nullif(p_payload->>'checkoutTrackingNumber', ''), p_payload->>'trackingNumber'), v_session_id, v_store_id, v_user_id, trim(p_payload->'customer'->>'name'), trim(p_payload->'customer'->>'phone'), nullif(trim(p_payload->'customer'->>'email'), ''), trim(p_payload->'customer'->>'address'), nullif(trim(p_payload->'customer'->>'notes'), ''), v_subtotal, v_currency, p_payload)
  returning * into v_request;

  for v_row in select value from jsonb_array_elements(v_rows) loop
    insert into public.store_order_request_items (request_id, store_product_id, product_size_id, product_id, product_name, brand_name, size_label, quantity, unit_price, line_total, currency)
    values (v_request.id, (v_row->>'sp_id')::uuid, (v_row->>'size_id')::uuid, (v_row->>'product_id')::uuid, v_row->>'name', v_row->>'brand', v_row->>'size', (v_row->>'qty')::integer, (v_row->>'unit')::numeric, (v_row->>'line')::numeric, v_row->>'currency');
  end loop;

  insert into public.store_order_notifications (request_id, tracking_number, event_type, store_status, match_status, payload)
  values (v_request.id, v_request.tracking_number, 'initial_submitted', 'awaiting_store_confirmation', 'matched', p_payload);

  return jsonb_build_object('id', v_request.id, 'trackingNumber', v_request.tracking_number, 'checkoutTrackingNumber', v_request.checkout_tracking_number, 'checkoutSessionId', v_request.checkout_session_id, 'status', v_request.status);
end;
$$;

revoke all on function public.create_store_order_request(jsonb) from public, anon;
grant execute on function public.create_store_order_request(jsonb) to authenticated;

create or replace function public.platform_registered_customer_best_sellers(
  p_period text default 'all',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_start date;
  v_start_ts timestamptz;
  v_end_ts timestamptz := ((now() at time zone 'Africa/Cairo')::date + 1)::timestamp at time zone 'Africa/Cairo';
  v_total bigint := 0;
  v_records jsonb := '[]'::jsonb;
  v_audit jsonb := '{}'::jsonb;
begin
  if p_period is null or p_period not in ('all','today','week','month','year') then
    raise exception 'invalid best seller period';
  end if;
  if p_limit is null or p_offset is null or p_limit < 1 or p_limit > 100 or p_offset < 0 or p_offset > 100000 then
    raise exception 'invalid best seller page';
  end if;

  v_start := case p_period when 'today' then v_today when 'week' then v_today-6 when 'month' then v_today-29 when 'year' then v_today-364 else null end;
  if v_start is not null then
    v_start_ts := v_start::timestamp at time zone 'Africa/Cairo';
  end if;

  with line_scope as materialized (
    select i.product_id, i.product_name, i.brand_name, i.size_label, i.quantity,
           r.id as request_id, coalesce(r.checkout_session_id, r.id) as purchase_id,
           r.store_id, r.status, r.reconciliation_status, r.user_id,
           cs.user_id as checkout_user_id, r.created_at,
           (r.user_id is not null and cs.user_id is not null and r.user_id <> cs.user_id) as owner_conflict
    from public.store_order_request_items i
    join public.store_order_requests r on r.id = i.request_id
    left join public.checkout_sessions cs on cs.id = r.checkout_session_id
    where (v_start_ts is null or r.created_at >= v_start_ts)
      and r.created_at < v_end_ts
  ), registered_lines as materialized (
    select * from line_scope where coalesce(user_id, checkout_user_id) is not null
  ), eligible_lines as materialized (
    select * from registered_lines
    where not owner_conflict
      and quantity > 0
      and ((status = 'completed' and reconciliation_status = 'matched')
        or (status = 'delivered' and reconciliation_status in ('matched','pending')))
  ), size_totals as (
    select product_id, coalesce(nullif(size_label,''),'غير محدد') as size_label,
           sum(quantity)::bigint as units
    from eligible_lines where product_id is not null
    group by product_id, coalesce(nullif(size_label,''),'غير محدد')
  ), size_breakdowns as (
    select product_id, jsonb_agg(jsonb_build_object('size',size_label,'units',units) order by size_label) as breakdown
    from size_totals group by product_id
  ), latest_snapshots as (
    select product_id,
      (array_agg(product_name order by created_at desc) filter (where nullif(product_name,'') is not null))[1] as snapshot_name,
      (array_agg(brand_name order by created_at desc) filter (where nullif(brand_name,'') is not null))[1] as snapshot_brand
    from eligible_lines where product_id is not null group by product_id
  ), product_totals as (
    select e.product_id, sum(e.quantity)::bigint as units_sold,
      count(distinct e.purchase_id)::bigint as purchase_count,
      count(distinct e.store_id)::bigint as store_count
    from eligible_lines e
    where e.product_id is not null
    group by e.product_id
  ), ranked as materialized (
    select row_number() over (order by pt.units_sold desc,pt.purchase_count desc,pt.product_id asc)::bigint as rank,
      pt.product_id, coalesce(nullif(p.name,''),ls.snapshot_name,'عطر محذوف من الكتالوج') as product_name,
      coalesce(nullif(b.name,''),ls.snapshot_brand) as brand_name,p.slug,
      pt.units_sold,pt.purchase_count,pt.store_count,sb.breakdown
    from product_totals pt
    join size_breakdowns sb on sb.product_id=pt.product_id
    left join public.products p on p.id=pt.product_id
    left join public.brands b on b.id=p.brand_id
    left join latest_snapshots ls on ls.product_id=pt.product_id
  ), aggregates as (
    select
      coalesce(sum(quantity) filter (where quantity > 0),0)::bigint as registered_units,
      coalesce(sum(quantity) filter (where owner_conflict and quantity > 0),0)::bigint as owner_conflict_units,
      coalesce(sum(quantity) filter (where not owner_conflict and status in ('cancelled','store_cancelled','store_rejected') and quantity > 0),0)::bigint as excluded_cancelled_units,
      coalesce(sum(quantity) filter (where not owner_conflict and status in ('awaiting_store_confirmation','store_confirmed','processing','shipped') and quantity > 0),0)::bigint as excluded_in_progress_units,
      coalesce(sum(quantity) filter (where not owner_conflict and (status = 'needs_review' or (status in ('completed','delivered') and reconciliation_status = 'mismatched')) and quantity > 0),0)::bigint as excluded_review_units,
      coalesce(sum(quantity) filter (where not owner_conflict and status not in ('completed','delivered','cancelled','store_cancelled','store_rejected','awaiting_store_confirmation','store_confirmed','processing','shipped','needs_review') and quantity > 0),0)::bigint as excluded_other_units
    from registered_lines
  ), eligible_aggregates as (
    select count(distinct purchase_id)::bigint as eligible_purchases,
      coalesce(sum(quantity),0)::bigint as eligible_units,
      coalesce(sum(quantity) filter (where product_id is not null),0)::bigint as ranked_units,
      coalesce(sum(quantity) filter (where product_id is null),0)::bigint as unlinked_units,
      count(*) filter (where product_id is null)::bigint as unlinked_lines
    from eligible_lines
  ), unregistered_aggregates as (
    select coalesce(sum(quantity) filter (where quantity > 0),0)::bigint as unregistered_units
    from line_scope where coalesce(user_id,checkout_user_id) is null
  )
  select
    (select count(*) from ranked),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'rank',page.rank,
        'product',jsonb_build_object('id',page.product_id,'name',page.product_name,'brand_name',page.brand_name,'slug',page.slug,'brand',jsonb_build_object('name',page.brand_name)),
        'unitsSold',page.units_sold,'purchases',page.purchase_count,'storeCount',page.store_count,'sizeBreakdown',page.breakdown
      ) order by page.rank)
      from (select * from ranked order by rank limit p_limit offset p_offset) page
    ),'[]'::jsonb),
    jsonb_build_object(
      'registeredUnits',a.registered_units,
      'eligiblePurchases',e.eligible_purchases,
      'eligibleUnits',e.eligible_units,
      'rankedUnits',e.ranked_units,
      'unlinkedEligibleUnits',e.unlinked_units,
      'unlinkedEligibleLines',e.unlinked_lines,
      'excludedCancelledUnits',a.excluded_cancelled_units,
      'excludedInProgressUnits',a.excluded_in_progress_units,
      'excludedReviewOrMismatchUnits',a.excluded_review_units,
      'excludedOtherUnits',a.excluded_other_units,
      'ownerConflictUnits',a.owner_conflict_units,
      'unregisteredUnitsExcluded',u.unregistered_units,
      'returnsAndRefundsTracked',false
    )
  into v_total,v_records,v_audit
  from aggregates a cross join eligible_aggregates e cross join unregistered_aggregates u;

  return jsonb_build_object(
    'period',p_period,'fromDate',v_start,'toDate',v_today,
    'limit',p_limit,'offset',p_offset,'total',v_total,
    'hasMore',p_offset+jsonb_array_length(v_records)<v_total,
    'records',v_records,'audit',v_audit
  );
end;
$$;

revoke all on function public.platform_registered_customer_best_sellers(text,integer,integer) from public, anon, authenticated;
grant execute on function public.platform_registered_customer_best_sellers(text,integer,integer) to service_role;
comment on function public.platform_registered_customer_best_sellers(text,integer,integer) is
  'Admin-only all-time or period ranking of perfume units from registered customer store orders that are completed and reconciled or delivered without a reconciliation mismatch; returns count-quality audit metrics.';

commit;
