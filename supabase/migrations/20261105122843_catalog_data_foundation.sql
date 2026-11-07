-- Stage 01: establish stable taxonomy keys and one eligibility/global-offer contract.
-- Data audit (2026-11-05): products use only men/women/unisex; taxonomy labels are
-- the expected 3 Arabic gender labels, 5 occasions, and 5 notes; all 14 offers are EGP.
-- Existing gender/category disagreements are intentionally not rewritten: products.gender
-- is authoritative for gender filters; product_categories remains a separate relation.

ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS key text;
ALTER TABLE public.occasions ADD COLUMN IF NOT EXISTS key text;
ALTER TABLE public.aromatic_notes ADD COLUMN IF NOT EXISTS key text;

UPDATE public.categories
SET key = CASE btrim(name)
  WHEN 'رجالي' THEN 'men'
  WHEN 'نسائي' THEN 'women'
  WHEN 'عطر يجمعنا' THEN 'unisex'
  ELSE key
END
WHERE key IS NULL;

UPDATE public.occasions
SET key = CASE btrim(name)
  WHEN 'نهاري' THEN 'daytime'
  WHEN 'ليلي' THEN 'evening'
  WHEN 'عمل' THEN 'work'
  WHEN 'موعد' THEN 'date'
  WHEN 'هدية' THEN 'gift'
  ELSE key
END
WHERE key IS NULL;

UPDATE public.aromatic_notes
SET key = CASE btrim(name)
  WHEN 'عنبري' THEN 'amber'
  WHEN 'عود' THEN 'oud'
  WHEN 'خشبي' THEN 'woody'
  WHEN 'حمضي' THEN 'citrus'
  WHEN 'هيل' THEN 'cardamom'
  ELSE key
END
WHERE key IS NULL;

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM public.categories WHERE key IS NULL)
     OR EXISTS (SELECT 1 FROM public.occasions WHERE key IS NULL)
     OR EXISTS (SELECT 1 FROM public.aromatic_notes WHERE key IS NULL) THEN
    RAISE EXCEPTION 'catalog taxonomy audit failed: every category, occasion, and note needs an explicit stable key';
  END IF;
  IF EXISTS (SELECT 1 FROM public.categories GROUP BY key HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.occasions GROUP BY key HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.aromatic_notes GROUP BY key HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'catalog taxonomy audit failed: duplicate stable keys exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.products WHERE gender IS NOT NULL AND gender NOT IN ('men','women','unisex')) THEN
    RAISE EXCEPTION 'catalog gender audit failed: unknown gender value';
  END IF;
  IF EXISTS (SELECT 1 FROM public.products WHERE status = 'published' AND is_active AND gender IS NULL) THEN
    RAISE EXCEPTION 'catalog gender audit failed: active published product has no gender';
  END IF;
END
$migration$;

ALTER TABLE public.categories ALTER COLUMN key SET NOT NULL;
ALTER TABLE public.occasions ALTER COLUMN key SET NOT NULL;
ALTER TABLE public.aromatic_notes ALTER COLUMN key SET NOT NULL;
ALTER TABLE public.categories ADD CONSTRAINT categories_key_unique UNIQUE (key);
ALTER TABLE public.occasions ADD CONSTRAINT occasions_key_unique UNIQUE (key);
ALTER TABLE public.aromatic_notes ADD CONSTRAINT aromatic_notes_key_unique UNIQUE (key);

-- The audit confirms a single platform currency. Keep future cross-currency prices
-- from being compared as raw numbers until an explicit dated FX policy exists.
ALTER TABLE public.store_products
  ADD CONSTRAINT store_products_currency_egp_check CHECK (currency = 'EGP');

CREATE OR REPLACE FUNCTION private.fn_catalog_eligible_offers()
RETURNS TABLE(
  store_product_id uuid,
  product_size_id uuid,
  product_id uuid,
  brand_id uuid,
  store_id uuid,
  store_name text,
  price numeric,
  currency text,
  stock_quantity integer,
  price_includes_tax boolean,
  price_includes_shipping boolean,
  last_synced_at timestamp with time zone,
  is_available boolean,
  sync_status text,
  store_status text,
  is_new_arrival boolean,
  is_coming_soon boolean,
  is_catalog_bestseller boolean,
  commission_rate numeric,
  priority_rank integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT sp.id,
         sp.product_size_id,
         ps.product_id,
         p.brand_id,
         sp.store_id,
         s.name,
         sp.price,
         sp.currency,
         sp.stock_quantity,
         sp.price_includes_tax,
         sp.price_includes_shipping,
         sp.last_synced_at,
         sp.is_available,
         sp.sync_status,
         s.status,
         sp.is_new_arrival,
         sp.is_coming_soon,
         sp.is_catalog_bestseller,
         s.commission_rate,
         s.priority_rank
  FROM public.store_products sp
  JOIN public.stores s ON s.id = sp.store_id
  JOIN public.product_sizes ps ON ps.id = sp.product_size_id
  JOIN public.products p ON p.id = ps.product_id
  WHERE s.status = 'active'
    AND p.status = 'published'
    AND p.is_active
    AND sp.is_available
    AND sp.sync_status = 'synced'
    AND (sp.stock_quantity IS NULL OR sp.stock_quantity > 0)
    AND sp.currency = 'EGP';
$function$;

CREATE INDEX IF NOT EXISTS idx_store_products_catalog_eligible
  ON public.store_products (product_size_id, price, store_id, id)
  WHERE is_available
    AND sync_status = 'synced'
    AND currency = 'EGP'
    AND (stock_quantity IS NULL OR stock_quantity > 0);

REVOKE ALL ON FUNCTION private.fn_catalog_eligible_offers() FROM PUBLIC, anon, authenticated;

CREATE VIEW public.catalog_eligible_offers AS
SELECT store_product_id,
       product_size_id,
       product_id,
       brand_id,
       store_id,
       store_name,
       price,
       currency,
       stock_quantity,
       price_includes_tax,
       price_includes_shipping,
       last_synced_at,
       is_available,
       sync_status,
       store_status,
       is_new_arrival,
       is_coming_soon,
       is_catalog_bestseller
FROM private.fn_catalog_eligible_offers();

CREATE VIEW public.catalog_global_offers AS
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

GRANT SELECT ON public.catalog_eligible_offers, public.catalog_global_offers TO anon, authenticated, service_role;

-- Preserve the existing cheapest_offers contract while making ties deterministic.
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
