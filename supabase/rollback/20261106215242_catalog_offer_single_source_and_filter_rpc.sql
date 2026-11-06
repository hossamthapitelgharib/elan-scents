DROP FUNCTION IF EXISTS public.catalog_filter_product_sizes(uuid, uuid, uuid, uuid, uuid, text, integer, numeric, numeric, text);
DROP INDEX IF EXISTS public.idx_products_published_gender_brand;

CREATE OR REPLACE VIEW public.catalog_global_offers AS
SELECT DISTINCT ON (offer.product_size_id)
       offer.store_product_id,
       offer.product_size_id,
       offer.product_id,
       offer.brand_id,
       offer.store_id,
       offer.store_name,
       offer.price,
       offer.currency,
       offer.stock_quantity,
       offer.price_includes_tax,
       offer.price_includes_shipping,
       offer.last_synced_at,
       offer.is_available,
       offer.sync_status,
       offer.store_status,
       offer.is_new_arrival,
       offer.is_coming_soon,
       offer.is_catalog_bestseller
FROM private.fn_catalog_eligible_offers() AS offer
ORDER BY offer.product_size_id,
         offer.price ASC,
         offer.commission_rate DESC,
         offer.priority_rank ASC,
         offer.store_id ASC,
         offer.store_product_id ASC;

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
  SELECT DISTINCT ON (offer.product_size_id)
         offer.product_size_id,
         offer.product_id,
         offer.brand_id,
         offer.store_id,
         offer.store_name,
         offer.price,
         offer.stock_quantity,
         offer.currency,
         offer.price_includes_tax,
         offer.price_includes_shipping,
         offer.last_synced_at
  FROM private.fn_catalog_eligible_offers() AS offer
  ORDER BY offer.product_size_id,
           offer.price ASC,
           offer.commission_rate DESC,
           offer.priority_rank ASC,
           offer.store_id ASC,
           offer.store_product_id ASC;
$function$;
