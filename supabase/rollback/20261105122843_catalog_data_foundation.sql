DROP INDEX IF EXISTS public.idx_store_products_catalog_eligible;
DROP VIEW IF EXISTS public.catalog_global_offers;
DROP VIEW IF EXISTS public.catalog_eligible_offers;
DROP FUNCTION IF EXISTS private.fn_catalog_eligible_offers();

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

ALTER TABLE public.store_products DROP CONSTRAINT IF EXISTS store_products_currency_egp_check;
ALTER TABLE public.categories DROP CONSTRAINT IF EXISTS categories_key_unique;
ALTER TABLE public.occasions DROP CONSTRAINT IF EXISTS occasions_key_unique;
ALTER TABLE public.aromatic_notes DROP CONSTRAINT IF EXISTS aromatic_notes_key_unique;
ALTER TABLE public.categories DROP COLUMN IF EXISTS key;
ALTER TABLE public.occasions DROP COLUMN IF EXISTS key;
ALTER TABLE public.aromatic_notes DROP COLUMN IF EXISTS key;
