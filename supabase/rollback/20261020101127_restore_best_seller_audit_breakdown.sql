-- Rolls back migration 20261020101127_restore_best_seller_audit_breakdown.sql:
-- restores platform_registered_customer_best_sellers exactly as 20261018215138 defined it (returns and refunds tracked,
-- without the cancelled / in progress / review / other / owner-conflict audit fields) and its previous comment.
begin;

CREATE OR REPLACE FUNCTION public.platform_registered_customer_best_sellers(
  p_period text DEFAULT 'all',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_start date;
  v_start_ts timestamptz;
  v_end_ts timestamptz := ((now() at time zone 'Africa/Cairo')::date + 1)::timestamp at time zone 'Africa/Cairo';
  v_total bigint := 0;
  v_records jsonb := '[]'::jsonb;
  v_audit jsonb := '{}'::jsonb;
begin
  if p_period is null or p_period not in ('all','today','week','month','year') then raise exception 'invalid best seller period'; end if;
  if p_limit is null or p_offset is null or p_limit < 1 or p_limit > 100 or p_offset < 0 or p_offset > 100000 then raise exception 'invalid best seller page'; end if;
  v_start := case p_period when 'today' then v_today when 'week' then v_today-6 when 'month' then v_today-29 when 'year' then v_today-364 else null end;
  if v_start is not null then v_start_ts := v_start::timestamp at time zone 'Africa/Cairo'; end if;

  WITH line_scope AS MATERIALIZED (
    SELECT i.id AS request_item_id, i.product_id, i.product_name, i.brand_name, i.size_label, i.quantity AS ordered_quantity,
      COALESCE(r.checkout_session_id, r.id) AS purchase_id, r.store_id, r.status, r.reconciliation_status, r.user_id,
      cs.user_id AS checkout_user_id, r.created_at,
      (r.user_id IS NOT NULL AND cs.user_id IS NOT NULL AND r.user_id <> cs.user_id) AS owner_conflict,
      COALESCE((SELECT SUM(a.quantity) FROM public.store_order_item_adjustments a WHERE a.request_item_id=i.id AND a.status='completed'),0)::bigint AS reversed_quantity
    FROM public.store_order_request_items i
    JOIN public.store_order_requests r ON r.id=i.request_id
    LEFT JOIN public.checkout_sessions cs ON cs.id=r.checkout_session_id
    WHERE (v_start_ts IS NULL OR r.created_at >= v_start_ts) AND r.created_at < v_end_ts
  ), registered_lines AS MATERIALIZED (
    SELECT *, GREATEST(ordered_quantity - reversed_quantity, 0)::bigint AS quantity
    FROM line_scope WHERE COALESCE(user_id, checkout_user_id) IS NOT NULL
  ), eligible_lines AS MATERIALIZED (
    SELECT * FROM registered_lines
    WHERE NOT owner_conflict AND quantity > 0
      AND ((status='completed' AND reconciliation_status='matched') OR (status='delivered' AND reconciliation_status IN ('matched','pending')))
  ), size_totals AS (
    SELECT product_id, COALESCE(NULLIF(size_label,''),'غير محدد') AS size_label, SUM(quantity)::bigint AS units
    FROM eligible_lines WHERE product_id IS NOT NULL GROUP BY product_id, COALESCE(NULLIF(size_label,''),'غير محدد')
  ), size_breakdowns AS (
    SELECT product_id, jsonb_agg(jsonb_build_object('size',size_label,'units',units) ORDER BY size_label) AS breakdown FROM size_totals GROUP BY product_id
  ), latest_snapshots AS (
    SELECT product_id, (array_agg(product_name ORDER BY created_at DESC) FILTER (WHERE NULLIF(product_name,'') IS NOT NULL))[1] AS snapshot_name,
      (array_agg(brand_name ORDER BY created_at DESC) FILTER (WHERE NULLIF(brand_name,'') IS NOT NULL))[1] AS snapshot_brand
    FROM eligible_lines WHERE product_id IS NOT NULL GROUP BY product_id
  ), product_totals AS (
    SELECT product_id, SUM(quantity)::bigint AS units_sold, COUNT(DISTINCT purchase_id)::bigint AS purchase_count, COUNT(DISTINCT store_id)::bigint AS store_count
    FROM eligible_lines WHERE product_id IS NOT NULL GROUP BY product_id
  ), ranked AS MATERIALIZED (
    SELECT ROW_NUMBER() OVER (ORDER BY pt.units_sold DESC,pt.purchase_count DESC,pt.product_id)::bigint AS rank, pt.product_id,
      COALESCE(NULLIF(p.name,''),ls.snapshot_name,'عطر محذوف من الكتالوج') AS product_name, COALESCE(NULLIF(b.name,''),ls.snapshot_brand) AS brand_name,p.slug,
      pt.units_sold,pt.purchase_count,pt.store_count,sb.breakdown
    FROM product_totals pt JOIN size_breakdowns sb ON sb.product_id=pt.product_id
    LEFT JOIN public.products p ON p.id=pt.product_id LEFT JOIN public.brands b ON b.id=p.brand_id LEFT JOIN latest_snapshots ls ON ls.product_id=pt.product_id
  ), aggregates AS (
    SELECT COALESCE(SUM(quantity),0)::bigint AS eligible_units,
      COALESCE(SUM(reversed_quantity) FILTER (WHERE reversed_quantity > 0),0)::bigint AS reversed_units,
      COUNT(DISTINCT purchase_id)::bigint AS eligible_purchases,
      COALESCE(SUM(quantity) FILTER (WHERE product_id IS NOT NULL),0)::bigint AS ranked_units,
      COALESCE(SUM(quantity) FILTER (WHERE product_id IS NULL),0)::bigint AS unlinked_units,
      COUNT(*) FILTER (WHERE product_id IS NULL)::bigint AS unlinked_lines
    FROM eligible_lines
  ), registered_totals AS (
    SELECT COALESCE(SUM(ordered_quantity) FILTER (WHERE ordered_quantity > 0),0)::bigint AS registered_units FROM registered_lines
  ), unregistered_totals AS (
    SELECT COALESCE(SUM(GREATEST(ordered_quantity-reversed_quantity,0)) FILTER (WHERE ordered_quantity > 0),0)::bigint AS unregistered_units
    FROM line_scope WHERE COALESCE(user_id,checkout_user_id) IS NULL
  )
  SELECT (SELECT COUNT(*) FROM ranked),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('rank',page.rank,'product',jsonb_build_object('id',page.product_id,'name',page.product_name,'brand_name',page.brand_name,'slug',page.slug,'brand',jsonb_build_object('name',page.brand_name)),'unitsSold',page.units_sold,'purchases',page.purchase_count,'storeCount',page.store_count,'sizeBreakdown',page.breakdown) ORDER BY page.rank) FROM (SELECT * FROM ranked ORDER BY rank LIMIT p_limit OFFSET p_offset) page),'[]'::jsonb),
    jsonb_build_object('registeredUnits',rt.registered_units,'eligiblePurchases',a.eligible_purchases,'eligibleUnits',a.eligible_units,'rankedUnits',a.ranked_units,'unlinkedEligibleUnits',a.unlinked_units,'unlinkedEligibleLines',a.unlinked_lines,'reversedUnits',a.reversed_units,'unregisteredUnitsExcluded',u.unregistered_units,'returnsAndRefundsTracked',true)
  INTO v_total,v_records,v_audit FROM aggregates a CROSS JOIN registered_totals rt CROSS JOIN unregistered_totals u;

  RETURN jsonb_build_object('period',p_period,'fromDate',v_start,'toDate',v_today,'limit',p_limit,'offset',p_offset,'total',v_total,'hasMore',p_offset+jsonb_array_length(v_records)<v_total,'records',v_records,'audit',v_audit);
end;
$function$;

REVOKE ALL ON FUNCTION public.platform_registered_customer_best_sellers(text,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_registered_customer_best_sellers(text,integer,integer) TO service_role;
COMMENT ON FUNCTION public.platform_registered_customer_best_sellers(text,integer,integer) IS
  'Admin-only all-time or period ranking of perfume units from registered customer store orders that are completed and reconciled or delivered without a reconciliation mismatch; returns count-quality audit metrics.';

commit;
