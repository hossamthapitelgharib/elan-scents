-- Bundles stand on their own (owner rules of 2026-11-17; follow-up of 20261115074256_catalog_bundles and
-- 20261115130025_catalog_bundle_views_and_offer_messages).
--   * A bundle is NOT built from the platform's perfumes. Its pieces may be a size nobody sells alone, an exclusive size, or a
--     perfume the platform does not list at all, so the pieces are written as the store lists them (brand, name, size in ml,
--     quantity) with no link to the perfume catalog. A perfume that is hidden, deleted or never listed has no effect on whether a
--     bundle shows, and a bundle never blocks the deletion of a perfume.
--   * The bundle is shown with the store's OWN title and its FULL description, exactly as the store wrote them
--     (store_bundles.title / .description). The platform proposes no description (bundles.description is dropped).
--   * Two stores' bundles are compared by CONTENT only: the same pieces (brand, name, size) in the same quantities and nothing
--     else. The key is a normalised form of the pieces (case, spaces, punctuation and accents ignored) and never reads a title or
--     a description, so no wording can make a bundle disappear or let a dearer store show instead of a cheaper one.
--     When the pieces cannot be proven identical the bundles stay side by side: a duplicate card is harmless, a wrong merge is not.
-- Nothing here touches the cart, the order flow, prices or any perfume row.

-- 0. the views and functions whose shape changes (nothing else in the database refers to them) --------------------------------
DROP VIEW public.catalog_platform_bundle_offers;
DROP VIEW public.catalog_eligible_bundle_offers;
DROP VIEW public.public_bundle_items;
DROP VIEW public.public_bundles;
DROP FUNCTION private.fn_catalog_public_platform_bundle_offers();
DROP FUNCTION private.fn_catalog_public_eligible_bundle_offers();
DROP FUNCTION private.fn_catalog_public_bundle_items();
DROP FUNCTION private.fn_catalog_public_bundles();
DROP FUNCTION private.fn_catalog_eligible_bundle_offers();

-- 1. the normal form used to compare pieces ------------------------------------------------------------------------------------
-- lower case, the common Latin accents folded, everything except letters, digits and Arabic letters removed
CREATE FUNCTION private.bundle_norm(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO pg_catalog
AS $function$
  SELECT regexp_replace(
           translate(lower(coalesce(p, '')),
                     'àáâãäåèéêëìíîïòóôõöùúûüçñ',
                     'aaaaaaeeeeiiiiooooouuuucn'),
           '[^a-z0-9ء-ي]+', '', 'g');
$function$;

REVOKE ALL ON FUNCTION private.bundle_norm(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.bundle_norm(text) TO service_role;

-- 2. the store's own words ------------------------------------------------------------------------------------------------------
ALTER TABLE public.store_bundles ADD COLUMN title text;
ALTER TABLE public.store_bundles ADD COLUMN description text;
UPDATE public.store_bundles sb SET title = b.name FROM public.bundles b WHERE b.id = sb.bundle_id;
ALTER TABLE public.store_bundles ALTER COLUMN title SET NOT NULL;
ALTER TABLE public.store_bundles
  ADD CONSTRAINT store_bundles_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  ADD CONSTRAINT store_bundles_description_check CHECK (description IS NULL OR length(description) <= 20000);

-- 3. the pieces as the store lists them -----------------------------------------------------------------------------------------
ALTER TABLE public.bundle_items ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.bundle_items ADD COLUMN item_brand text;
ALTER TABLE public.bundle_items ADD COLUMN item_name text;
ALTER TABLE public.bundle_items ADD COLUMN size_ml integer;

-- the rows written before this change keep what they said: copy the perfume's brand, name and size into the piece itself
UPDATE public.bundle_items bi
   SET item_brand = br.name, item_name = p.name, size_ml = ps.size_ml
  FROM public.product_sizes ps
  JOIN public.products p ON p.id = ps.product_id
  LEFT JOIN public.brands br ON br.id = p.brand_id
 WHERE ps.id = bi.product_size_id;

ALTER TABLE public.bundle_items ALTER COLUMN item_name SET NOT NULL;
ALTER TABLE public.bundle_items DROP CONSTRAINT bundle_items_pkey;
ALTER TABLE public.bundle_items ADD CONSTRAINT bundle_items_pkey PRIMARY KEY (id);
-- the link to the perfume catalog goes (its foreign key and index with it): a piece has nothing to do with a catalog row
ALTER TABLE public.bundle_items DROP COLUMN product_size_id;
ALTER TABLE public.bundle_items
  ADD CONSTRAINT bundle_items_name_check CHECK (length(btrim(item_name)) BETWEEN 1 AND 200),
  ADD CONSTRAINT bundle_items_brand_check CHECK (item_brand IS NULL OR length(btrim(item_brand)) BETWEEN 1 AND 120),
  ADD CONSTRAINT bundle_items_size_check CHECK (size_ml IS NULL OR size_ml BETWEEN 1 AND 5000);
-- the same piece twice in one bundle is the store sending a quantity of 2 the wrong way: refused, as the old primary key did
CREATE UNIQUE INDEX bundle_items_piece_uq
  ON public.bundle_items (bundle_id, private.bundle_norm(item_brand), private.bundle_norm(item_name), COALESCE(size_ml, 0));

-- the platform writes no description of its own: the store's text is the only description of a bundle
ALTER TABLE public.bundles DROP COLUMN description;

-- 4. the composition key: pieces only, never a title or a description -----------------------------------------------------------
CREATE OR REPLACE FUNCTION private.bundle_compute_key(p_bundle_id uuid, p_has_extra_items boolean)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT CASE
           WHEN p_has_extra_items THEN NULL
           WHEN COALESCE((SELECT sum(bi.quantity) FROM public.bundle_items bi WHERE bi.bundle_id = p_bundle_id), 0) < 2 THEN NULL
           ELSE (SELECT string_agg(piece, ',' ORDER BY piece)
                   FROM (SELECT private.bundle_norm(bi.item_brand) || '|' || private.bundle_norm(bi.item_name) || '|'
                                || COALESCE(bi.size_ml::text, '') || 'x' || bi.quantity::text AS piece
                           FROM public.bundle_items bi WHERE bi.bundle_id = p_bundle_id) pieces)
         END;
$function$;

-- the keys already stored were built from catalog ids: derive them again from the pieces (the trigger does it on any write)
UPDATE public.bundles SET composition_key = composition_key;

-- 5. eligibility and the platform offer -----------------------------------------------------------------------------------------
-- a bundle shows when it is published and active and one of its store offers is eligible; the perfumes are NOT consulted
CREATE FUNCTION private.fn_catalog_eligible_bundle_offers()
RETURNS TABLE(
  store_bundle_id uuid,
  bundle_id uuid,
  store_id uuid,
  store_name text,
  title text,
  description text,
  price numeric,
  currency text,
  stock_quantity integer,
  price_includes_tax boolean,
  price_includes_shipping boolean,
  last_synced_at timestamptz,
  commission_rate numeric,
  priority_rank integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT sb.id,
         sb.bundle_id,
         sb.store_id,
         s.name,
         sb.title,
         sb.description,
         sb.price,
         sb.currency,
         sb.stock_quantity,
         sb.price_includes_tax,
         sb.price_includes_shipping,
         sb.last_synced_at,
         s.commission_rate,
         s.priority_rank
    FROM public.store_bundles sb
    JOIN public.stores s ON s.id = sb.store_id
    JOIN public.bundles b ON b.id = sb.bundle_id
   WHERE s.status = 'active'
     AND b.status = 'published'
     AND b.is_active
     AND sb.is_available
     AND sb.sync_status = 'synced'
     AND sb.stock_quantity > 0
     AND sb.price > 0
     AND sb.currency = 'EGP';
$function$;

CREATE FUNCTION private.fn_catalog_public_eligible_bundle_offers()
RETURNS TABLE(
  store_bundle_id uuid,
  bundle_id uuid,
  store_id uuid,
  store_name text,
  title text,
  description text,
  price numeric,
  currency text,
  stock_quantity integer,
  price_includes_tax boolean,
  price_includes_shipping boolean,
  last_synced_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT o.store_bundle_id, o.bundle_id, o.store_id, o.store_name, o.title, o.description, o.price, o.currency, o.stock_quantity,
         o.price_includes_tax, o.price_includes_shipping, o.last_synced_at
    FROM private.fn_catalog_eligible_bundle_offers() AS o;
$function$;

CREATE FUNCTION private.fn_catalog_public_platform_bundle_offers()
RETURNS TABLE(
  store_bundle_id uuid,
  bundle_id uuid,
  store_id uuid,
  store_name text,
  title text,
  description text,
  price numeric,
  currency text,
  stock_quantity integer,
  price_includes_tax boolean,
  price_includes_shipping boolean,
  last_synced_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT DISTINCT ON (o.bundle_id)
         o.store_bundle_id, o.bundle_id, o.store_id, o.store_name, o.title, o.description, o.price, o.currency, o.stock_quantity,
         o.price_includes_tax, o.price_includes_shipping, o.last_synced_at
    FROM private.fn_catalog_eligible_bundle_offers() AS o
   ORDER BY o.bundle_id,
            o.price ASC,
            o.commission_rate DESC,
            o.priority_rank ASC,
            o.store_id ASC,
            o.store_bundle_id ASC;
$function$;

CREATE FUNCTION private.fn_catalog_public_bundles()
RETURNS TABLE(
  id uuid,
  brand_id uuid,
  brand_name text,
  name text,
  slug text,
  has_extra_items boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT b.id, b.brand_id, br.name, b.name, b.slug, b.has_extra_items
    FROM public.bundles b
    LEFT JOIN public.brands br ON br.id = b.brand_id
   WHERE b.status = 'published'
     AND b.is_active
     AND EXISTS (SELECT 1 FROM private.fn_catalog_eligible_bundle_offers() o WHERE o.bundle_id = b.id);
$function$;

CREATE FUNCTION private.fn_catalog_public_bundle_items()
RETURNS TABLE(
  bundle_id uuid,
  quantity integer,
  brand_name text,
  product_name text,
  size_ml integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT bi.bundle_id, bi.quantity, bi.item_brand, bi.item_name, bi.size_ml
    FROM public.bundle_items bi
    JOIN private.fn_catalog_public_bundles() pb ON pb.id = bi.bundle_id
   ORDER BY bi.bundle_id, bi.item_name, bi.size_ml, bi.id;
$function$;

REVOKE ALL ON FUNCTION private.fn_catalog_eligible_bundle_offers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fn_catalog_public_eligible_bundle_offers() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fn_catalog_public_platform_bundle_offers() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fn_catalog_public_bundles() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fn_catalog_public_bundle_items() FROM PUBLIC;
-- the API roles call the public ones through the views (function EXECUTE is checked as the calling role)
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_eligible_bundle_offers() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_platform_bundle_offers() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_bundles() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_bundle_items() TO anon, authenticated, service_role;

-- 6. the public views the storefront reads --------------------------------------------------------------------------------------
CREATE VIEW public.catalog_eligible_bundle_offers WITH (security_invoker = true) AS
SELECT store_bundle_id, bundle_id, store_id, store_name, title, description, price, currency, stock_quantity,
       price_includes_tax, price_includes_shipping, last_synced_at
  FROM private.fn_catalog_public_eligible_bundle_offers();

CREATE VIEW public.catalog_platform_bundle_offers WITH (security_invoker = true) AS
SELECT store_bundle_id, bundle_id, store_id, store_name, title, description, price, currency, stock_quantity,
       price_includes_tax, price_includes_shipping, last_synced_at
  FROM private.fn_catalog_public_platform_bundle_offers();

CREATE VIEW public.public_bundles WITH (security_invoker = true) AS
SELECT id, brand_id, brand_name, name, slug, has_extra_items
  FROM private.fn_catalog_public_bundles();

CREATE VIEW public.public_bundle_items WITH (security_invoker = true) AS
SELECT bundle_id, quantity, brand_name, product_name, size_ml
  FROM private.fn_catalog_public_bundle_items();

GRANT SELECT ON public.catalog_eligible_bundle_offers, public.catalog_platform_bundle_offers,
  public.public_bundles, public.public_bundle_items TO anon, authenticated, service_role;
