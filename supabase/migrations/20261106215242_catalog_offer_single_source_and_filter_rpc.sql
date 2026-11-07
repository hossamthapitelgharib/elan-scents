-- Stage 01: one canonical platform offer selection and one relational editor filter query.
-- The platform view is the sole cheapest-offer selector; legacy view/function names delegate to it.
CREATE OR REPLACE VIEW public.catalog_global_offers AS
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
FROM public.catalog_platform_offers;

CREATE INDEX IF NOT EXISTS idx_products_published_gender_brand
  ON public.products (gender, brand_id, id)
  WHERE status = 'published' AND is_active;

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
  SELECT offer.product_size_id,
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
  FROM public.catalog_platform_offers AS offer;
$function$;

-- Server-only editor filter. Each taxonomy dimension is an EXISTS predicate, so
-- joins cannot multiply product-size rows; different dimensions intersect with AND.
CREATE OR REPLACE FUNCTION public.catalog_filter_product_sizes(
  p_brand_id uuid DEFAULT NULL,
  p_store_id uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_occasion_id uuid DEFAULT NULL,
  p_note_id uuid DEFAULT NULL,
  p_gender text DEFAULT NULL,
  p_size_ml integer DEFAULT NULL,
  p_price_min numeric DEFAULT NULL,
  p_price_max numeric DEFAULT NULL,
  p_search text DEFAULT NULL
)
RETURNS TABLE(
  product_id uuid,
  product_size_id uuid,
  name text,
  size_ml integer,
  size_label text,
  gender text,
  category_ids uuid[],
  category_keys text[],
  occasion_ids uuid[],
  occasion_keys text[],
  note_ids uuid[],
  note_keys text[],
  store_product_id uuid,
  store_id uuid,
  price numeric,
  currency text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p.id,
         ps.id,
         p.name,
         ps.size_ml,
         ps.size_label,
         p.gender,
         COALESCE((SELECT array_agg(pc.category_id ORDER BY c.key, pc.category_id)
                   FROM public.product_categories pc
                   JOIN public.categories c ON c.id = pc.category_id
                   WHERE pc.product_id = p.id), ARRAY[]::uuid[]),
         COALESCE((SELECT array_agg(c.key ORDER BY c.key, pc.category_id)
                   FROM public.product_categories pc
                   JOIN public.categories c ON c.id = pc.category_id
                   WHERE pc.product_id = p.id), ARRAY[]::text[]),
         COALESCE((SELECT array_agg(po.occasion_id ORDER BY o.key, po.occasion_id)
                   FROM public.product_occasions po
                   JOIN public.occasions o ON o.id = po.occasion_id
                   WHERE po.product_id = p.id), ARRAY[]::uuid[]),
         COALESCE((SELECT array_agg(o.key ORDER BY o.key, po.occasion_id)
                   FROM public.product_occasions po
                   JOIN public.occasions o ON o.id = po.occasion_id
                   WHERE po.product_id = p.id), ARRAY[]::text[]),
         COALESCE((SELECT array_agg(pn.note_id ORDER BY n.key, pn.note_id)
                   FROM public.product_notes pn
                   JOIN public.aromatic_notes n ON n.id = pn.note_id
                   WHERE pn.product_id = p.id), ARRAY[]::uuid[]),
         COALESCE((SELECT array_agg(n.key ORDER BY n.key, pn.note_id)
                   FROM public.product_notes pn
                   JOIN public.aromatic_notes n ON n.id = pn.note_id
                   WHERE pn.product_id = p.id), ARRAY[]::text[]),
         offer.store_product_id,
         offer.store_id,
         offer.price,
         offer.currency
  FROM public.products p
  JOIN public.product_sizes ps ON ps.product_id = p.id
  JOIN public.catalog_platform_offers offer ON offer.product_size_id = ps.id
  WHERE p.status = 'published'
    AND p.is_active
    AND (p_brand_id IS NULL OR p.brand_id = p_brand_id)
    AND (p_gender IS NULL OR p.gender = p_gender)
    AND (p_category_id IS NULL OR EXISTS (
      SELECT 1 FROM public.product_categories pc
      WHERE pc.product_id = p.id AND pc.category_id = p_category_id
    ))
    AND (p_occasion_id IS NULL OR EXISTS (
      SELECT 1 FROM public.product_occasions po
      WHERE po.product_id = p.id AND po.occasion_id = p_occasion_id
    ))
    AND (p_note_id IS NULL OR EXISTS (
      SELECT 1 FROM public.product_notes pn
      WHERE pn.product_id = p.id AND pn.note_id = p_note_id
    ))
    AND (p_store_id IS NULL OR offer.store_id = p_store_id)
    AND (p_size_ml IS NULL OR ps.size_ml = p_size_ml)
    AND (p_price_min IS NULL OR offer.price >= p_price_min)
    AND (p_price_max IS NULL OR offer.price <= p_price_max)
    AND (p_search IS NULL OR p.name ILIKE ('%' || p_search || '%'))
  ORDER BY p.name, ps.size_ml NULLS LAST, ps.id;
$function$;

REVOKE ALL ON FUNCTION public.catalog_filter_product_sizes(uuid, uuid, uuid, uuid, uuid, text, integer, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.catalog_filter_product_sizes(uuid, uuid, uuid, uuid, uuid, text, integer, numeric, numeric, text) TO service_role;
