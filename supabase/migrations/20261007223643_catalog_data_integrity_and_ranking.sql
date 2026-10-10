-- Preserve catalog provenance and retailer bestseller membership on each store listing.
-- Retailer feeds expose availability but not exact inventory counts, so NULL means unknown.
ALTER TABLE public.store_products
  ALTER COLUMN stock_quantity DROP NOT NULL;

ALTER TABLE public.store_products
  ADD COLUMN IF NOT EXISTS product_url text,
  ADD COLUMN IF NOT EXISTS is_catalog_bestseller boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION private.fn_cheapest_offers()
RETURNS TABLE(
  product_size_id uuid,
  product_id uuid,
  brand_id uuid,
  store_id uuid,
  store_name text,
  price numeric,
  stock_quantity integer,
  currency text,
  price_includes_tax boolean,
  price_includes_shipping boolean,
  last_synced_at timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT DISTINCT ON (sp.product_size_id)
         sp.product_size_id,
         ps.product_id,
         p.brand_id,
         sp.store_id,
         s.name,
         sp.price,
         sp.stock_quantity,
         sp.currency,
         sp.price_includes_tax,
         sp.price_includes_shipping,
         sp.last_synced_at
  FROM public.store_products sp
  JOIN public.stores s ON s.id = sp.store_id AND s.status = 'active'
  JOIN public.product_sizes ps ON ps.id = sp.product_size_id
  JOIN public.products p ON p.id = ps.product_id
  WHERE sp.is_available
    AND (sp.stock_quantity IS NULL OR sp.stock_quantity > 0)
    AND sp.sync_status = 'synced'
  ORDER BY sp.product_size_id,
           sp.price ASC,
           s.commission_rate DESC,
           s.priority_rank ASC;
$function$;

CREATE OR REPLACE VIEW public.public_products AS
SELECT p.id,
       p.brand_id,
       b.name AS brand_name,
       b.slug AS brand_slug,
       p.name,
       p.slug,
       p.short_description,
       p.official_description,
       p.composition,
       p.gender,
       p.notes_source,
       p.meta_title,
       p.meta_description,
       (SELECT min(co.price) FROM public.cheapest_offers co WHERE co.product_id = p.id) AS min_price,
       (SELECT count(*) FROM public.cheapest_offers co WHERE co.product_id = p.id) AS available_sizes,
       ps.views_count,
       ps.sales_count,
       ps.search_count,
       ps.request_count,
       ps.average_rating,
       ps.reviews_count,
       ps.distinctiveness_score,
       COALESCE((
         SELECT bool_or(sp.is_catalog_bestseller)
         FROM public.store_products sp
         JOIN public.product_sizes sps ON sps.id = sp.product_size_id
         WHERE sps.product_id = p.id
           AND sp.sync_status = 'synced'
       ), false) AS catalog_bestseller
FROM public.products p
JOIN public.brands b ON b.id = p.brand_id
LEFT JOIN public.product_stats ps ON ps.product_id = p.id
WHERE p.status = 'published'
  AND p.is_active
  AND EXISTS (
    SELECT 1
    FROM public.cheapest_offers co
    WHERE co.product_id = p.id
  );