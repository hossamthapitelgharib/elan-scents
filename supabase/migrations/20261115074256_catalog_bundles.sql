-- Bundles (باقات): a package of several perfumes (and sometimes small extras) sold together at ONE price.
-- Owner rules of 2026-11-14 this migration encodes:
--   * a store's bundle is stored as it was sent; bundles that are really different all appear;
--   * two stores' bundles are compared only when they are PROVABLY the same package: the same catalog sizes in the same quantities
--     and nothing else (composition_key). When unsure the bundle stands alone: a duplicate card is harmless, a wrong merge is not;
--   * the same eligibility as a perfume offer: the store is active, the bundle is published and active, the offer is available and
--     synced, and the stock is a NUMBER greater than zero (stock_quantity is NOT NULL here: the store must send the number);
--   * the platform offer is the cheapest eligible offer of the bundle (a bundle only one store sells is the cheapest by itself),
--     with the same deterministic tie-break as the perfume offers;
--   * NO store-claimed "price before discount": discounts need their own anti-cheating design first (owner decision, 2026-11-14).
-- The tables are written by the server only (service_role); the storefront reads the public views below. Nothing here touches the
-- cart, the order flow or any existing table.

CREATE TABLE public.bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid REFERENCES public.brands(id) ON DELETE RESTRICT,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  -- true when the package holds a piece that is not a catalog size (a sample, a deodorant, a pouch...):
  -- such a package can never be proven identical to another store's, so it never gets a composition_key
  has_extra_items boolean NOT NULL DEFAULT false,
  -- the sorted "size x quantity" list of a package made only of catalog sizes (>= 2 pieces); NULL = never compared across stores
  composition_key text,
  status text NOT NULL DEFAULT 'draft',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bundles_slug_key UNIQUE (slug),
  CONSTRAINT bundles_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT bundles_status_check CHECK (status IN ('draft', 'published')),
  CONSTRAINT bundles_key_not_with_extras CHECK (composition_key IS NULL OR NOT has_extra_items)
);

CREATE UNIQUE INDEX bundles_composition_key_uq ON public.bundles (composition_key) WHERE composition_key IS NOT NULL;
CREATE INDEX bundles_brand_idx ON public.bundles (brand_id);

CREATE TABLE public.bundle_items (
  bundle_id uuid NOT NULL REFERENCES public.bundles(id) ON DELETE CASCADE,
  -- RESTRICT: a size that sits in a package can never be deleted from under it
  product_size_id uuid NOT NULL REFERENCES public.product_sizes(id) ON DELETE RESTRICT,
  quantity integer NOT NULL DEFAULT 1,
  PRIMARY KEY (bundle_id, product_size_id),
  CONSTRAINT bundle_items_quantity_check CHECK (quantity BETWEEN 1 AND 20)
);

CREATE INDEX bundle_items_size_idx ON public.bundle_items (product_size_id);

CREATE TABLE public.store_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  bundle_id uuid NOT NULL REFERENCES public.bundles(id) ON DELETE CASCADE,
  price numeric(12, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'EGP',
  -- the owner's rule: a store must send the stock as a number (no NULL, no "available/unavailable" only)
  stock_quantity integer NOT NULL,
  is_available boolean NOT NULL DEFAULT false,
  price_includes_tax boolean,
  price_includes_shipping boolean,
  data_source text NOT NULL DEFAULT 'store_catalog',
  sync_status text NOT NULL DEFAULT 'unavailable',
  last_synced_at timestamptz,
  product_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_bundles_store_bundle_key UNIQUE (store_id, bundle_id),
  CONSTRAINT store_bundles_price_check CHECK (price > 0),
  CONSTRAINT store_bundles_currency_check CHECK (currency = 'EGP'),
  CONSTRAINT store_bundles_stock_check CHECK (stock_quantity >= 0),
  CONSTRAINT store_bundles_sync_status_check CHECK (sync_status IN ('synced', 'stale', 'unavailable'))
);

CREATE INDEX store_bundles_bundle_idx ON public.store_bundles (bundle_id);

-- the composition key is always derived from the items, never typed by hand ---------------------------------------------------
-- (a package of fewer than 2 pieces is a plain perfume, and a package with an extra piece cannot be proven identical: no key)
CREATE FUNCTION private.bundle_compute_key(p_bundle_id uuid, p_has_extra_items boolean)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT CASE
           WHEN p_has_extra_items THEN NULL
           WHEN COALESCE((SELECT sum(bi.quantity) FROM public.bundle_items bi WHERE bi.bundle_id = p_bundle_id), 0) < 2 THEN NULL
           ELSE (SELECT string_agg(bi.product_size_id::text || 'x' || bi.quantity::text, ',' ORDER BY bi.product_size_id)
                   FROM public.bundle_items bi WHERE bi.bundle_id = p_bundle_id)
         END;
$function$;

-- BEFORE every write of a bundle row the key is recomputed from its items, so a hand-typed key is overwritten
CREATE FUNCTION private.bundles_before_write_compute_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
BEGIN
  NEW.composition_key := private.bundle_compute_key(NEW.id, NEW.has_extra_items);
  RETURN NEW;
END;
$function$;

-- AFTER an item changes, touch its bundle row so the trigger above recomputes the key (a second bundle with the same
-- composition makes the unique index refuse the item, which is the point: the same package never exists twice)
CREATE FUNCTION private.bundle_items_after_write_touch_bundle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.bundles SET composition_key = composition_key WHERE id = OLD.bundle_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.bundle_id IS DISTINCT FROM OLD.bundle_id) THEN
    UPDATE public.bundles SET composition_key = composition_key WHERE id = NEW.bundle_id;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION private.bundle_compute_key(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.bundles_before_write_compute_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.bundle_items_after_write_touch_bundle() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER bundles_compute_key
  BEFORE INSERT OR UPDATE ON public.bundles
  FOR EACH ROW EXECUTE FUNCTION private.bundles_before_write_compute_key();

CREATE TRIGGER bundle_items_touch_bundle
  AFTER INSERT OR UPDATE OR DELETE ON public.bundle_items
  FOR EACH ROW EXECUTE FUNCTION private.bundle_items_after_write_touch_bundle();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.bundles
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.store_bundles
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- server-only tables: RLS on, no policy and no client grant, so a browser can neither read nor write them ----------------------
ALTER TABLE public.bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_bundles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bundles, public.bundle_items, public.store_bundles FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bundles, public.bundle_items, public.store_bundles TO service_role;

-- eligibility and the platform offer ------------------------------------------------------------------------------------------
CREATE FUNCTION private.fn_catalog_eligible_bundle_offers()
RETURNS TABLE(
  store_bundle_id uuid,
  bundle_id uuid,
  store_id uuid,
  store_name text,
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
     AND sb.currency = 'EGP'
     -- a package that holds a hidden or unpublished perfume is hidden with it
     AND NOT EXISTS (
       SELECT 1
         FROM public.bundle_items bi
         JOIN public.product_sizes ps ON ps.id = bi.product_size_id
         JOIN public.products p ON p.id = ps.product_id
        WHERE bi.bundle_id = b.id
          AND NOT (p.status = 'published' AND p.is_active)
     );
$function$;

CREATE FUNCTION private.fn_catalog_public_eligible_bundle_offers()
RETURNS TABLE(
  store_bundle_id uuid,
  bundle_id uuid,
  store_id uuid,
  store_name text,
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
  SELECT o.store_bundle_id, o.bundle_id, o.store_id, o.store_name, o.price, o.currency, o.stock_quantity,
         o.price_includes_tax, o.price_includes_shipping, o.last_synced_at
    FROM private.fn_catalog_eligible_bundle_offers() AS o;
$function$;

CREATE FUNCTION private.fn_catalog_public_platform_bundle_offers()
RETURNS TABLE(
  store_bundle_id uuid,
  bundle_id uuid,
  store_id uuid,
  store_name text,
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
         o.store_bundle_id, o.bundle_id, o.store_id, o.store_name, o.price, o.currency, o.stock_quantity,
         o.price_includes_tax, o.price_includes_shipping, o.last_synced_at
    FROM private.fn_catalog_eligible_bundle_offers() AS o
   ORDER BY o.bundle_id,
            o.price ASC,
            o.commission_rate DESC,
            o.priority_rank ASC,
            o.store_id ASC,
            o.store_bundle_id ASC;
$function$;

REVOKE ALL ON FUNCTION private.fn_catalog_eligible_bundle_offers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fn_catalog_public_eligible_bundle_offers() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fn_catalog_public_platform_bundle_offers() FROM PUBLIC;
-- the API roles call the public ones through the views (function EXECUTE is checked as the calling role)
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_eligible_bundle_offers() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_platform_bundle_offers() TO anon, authenticated, service_role;

-- the public views the storefront reads ---------------------------------------------------------------------------------------
CREATE VIEW public.catalog_eligible_bundle_offers AS
SELECT store_bundle_id, bundle_id, store_id, store_name, price, currency, stock_quantity,
       price_includes_tax, price_includes_shipping, last_synced_at
  FROM private.fn_catalog_public_eligible_bundle_offers();

CREATE VIEW public.catalog_platform_bundle_offers AS
SELECT store_bundle_id, bundle_id, store_id, store_name, price, currency, stock_quantity,
       price_includes_tax, price_includes_shipping, last_synced_at
  FROM private.fn_catalog_public_platform_bundle_offers();

-- a bundle is public only while it has at least one eligible offer (like public_products)
CREATE VIEW public.public_bundles AS
SELECT b.id, b.brand_id, br.name AS brand_name, b.name, b.slug, b.description, b.has_extra_items
  FROM public.bundles b
  LEFT JOIN public.brands br ON br.id = b.brand_id
 WHERE b.status = 'published'
   AND b.is_active
   AND EXISTS (SELECT 1 FROM private.fn_catalog_public_eligible_bundle_offers() o WHERE o.bundle_id = b.id);

CREATE VIEW public.public_bundle_items AS
SELECT bi.bundle_id, bi.product_size_id, bi.quantity
  FROM public.bundle_items bi
  JOIN public.public_bundles pb ON pb.id = bi.bundle_id;

GRANT SELECT ON public.catalog_eligible_bundle_offers, public.catalog_platform_bundle_offers,
  public.public_bundles, public.public_bundle_items TO anon, authenticated, service_role;
