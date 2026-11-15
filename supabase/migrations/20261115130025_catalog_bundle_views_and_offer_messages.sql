-- Follow-up of 20261115074256_catalog_bundles (owner decisions of 2026-11-14/15):
-- 1. the four public bundle views become security_invoker views over granted SECURITY DEFINER functions, so the Supabase advisor
--    no longer reports them as security_definer_view (the older offer views keep their own, already documented, advisory);
--    public_bundle_items now also carries the perfume name, brand and size label, because a perfume that is sold only inside a
--    bundle has no standalone offer and the storefront could not otherwise name it;
-- 2. an "offer" (عرض) is a PROMOTIONAL MESSAGE from the store (e.g. "buy two, get a gift", "free shipping") that never changes a
--    price, and a "discount" (خصم) is an EXPLICIT declaration by the store on specific perfumes. offers.kind records which one
--    the store declared. The numbers a store types for "price before / after" (offers.discount_type, offers.discount_value,
--    store_products.original_price, store_products.discount_percentage) are the store's own promotional style: they are NOT a
--    discount, are never shown and never decide anything. The new view exposes only the message, never those numbers.
-- Nothing here touches the cart, the order flow, or any price.

-- 1. bundles: invoker views over granted definer functions ------------------------------------------------------------------------
CREATE FUNCTION private.fn_catalog_public_bundles()
RETURNS TABLE(
  id uuid,
  brand_id uuid,
  brand_name text,
  name text,
  slug text,
  description text,
  has_extra_items boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT b.id, b.brand_id, br.name, b.name, b.slug, b.description, b.has_extra_items
    FROM public.bundles b
    LEFT JOIN public.brands br ON br.id = b.brand_id
   WHERE b.status = 'published'
     AND b.is_active
     AND EXISTS (SELECT 1 FROM private.fn_catalog_eligible_bundle_offers() o WHERE o.bundle_id = b.id);
$function$;

CREATE FUNCTION private.fn_catalog_public_bundle_items()
RETURNS TABLE(
  bundle_id uuid,
  product_size_id uuid,
  quantity integer,
  product_id uuid,
  product_name text,
  brand_name text,
  size_ml integer,
  size_label text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT bi.bundle_id, bi.product_size_id, bi.quantity, p.id, p.name, br.name, ps.size_ml, ps.size_label
    FROM public.bundle_items bi
    JOIN private.fn_catalog_public_bundles() pb ON pb.id = bi.bundle_id
    JOIN public.product_sizes ps ON ps.id = bi.product_size_id
    JOIN public.products p ON p.id = ps.product_id
    LEFT JOIN public.brands br ON br.id = p.brand_id
   ORDER BY bi.bundle_id, p.name, ps.size_ml, bi.product_size_id;
$function$;

REVOKE ALL ON FUNCTION private.fn_catalog_public_bundles() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fn_catalog_public_bundle_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_bundles() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_bundle_items() TO anon, authenticated, service_role;

DROP VIEW public.public_bundle_items;
DROP VIEW public.public_bundles;

CREATE VIEW public.public_bundles WITH (security_invoker = true) AS
SELECT id, brand_id, brand_name, name, slug, description, has_extra_items
  FROM private.fn_catalog_public_bundles();

CREATE VIEW public.public_bundle_items WITH (security_invoker = true) AS
SELECT bundle_id, product_size_id, quantity, product_id, product_name, brand_name, size_ml, size_label
  FROM private.fn_catalog_public_bundle_items();

ALTER VIEW public.catalog_eligible_bundle_offers SET (security_invoker = true);
ALTER VIEW public.catalog_platform_bundle_offers SET (security_invoker = true);

GRANT SELECT ON public.public_bundles, public.public_bundle_items TO anon, authenticated, service_role;

-- 2. offers: what the store declared, and the public message -----------------------------------------------------------------------
ALTER TABLE public.offers ADD COLUMN kind text NOT NULL DEFAULT 'offer';
ALTER TABLE public.offers ADD CONSTRAINT offers_kind_check CHECK (kind IN ('offer', 'discount'));

-- "kind" must be written by the server only. Measured on the live table: the signed-in role holds the TABLE-wide INSERT/UPDATE
-- (plus DELETE) on public.offers, so without this step a store member could write kind = 'discount' on its own message from the
-- dashboard. The table-wide write is replaced by the same write on exactly the twelve columns that existed before, so what a store
-- member can do today stays the same (still bounded by the member_all row policy); only the new column is left out. DELETE and
-- the column-level SELECT of the browser roles are untouched.
REVOKE INSERT, UPDATE ON public.offers FROM authenticated;
GRANT INSERT (id, store_id, product_size_id, title, description, discount_type, discount_value, start_date, end_date, is_active, created_at, updated_at),
      UPDATE (id, store_id, product_size_id, title, description, discount_type, discount_value, start_date, end_date, is_active, created_at, updated_at)
  ON public.offers TO authenticated;

-- the public part of an offer: who, on which size (NULL = the whole store), what kind, the message and when it ends.
-- Same visibility as the existing public_read policy of public.offers (active, inside its dates, active store - it even calls the
-- same private.store_is_active), and a message on a perfume that is not published is hidden with it; the text is trimmed and
-- capped for display (the table itself already refuses a blank title, a title over 200 and a description over 2000 characters);
-- no discount number is exposed.
-- "kind" is deliberately NOT granted to the browser roles (see the column grants above): a store member cannot label its own
-- message a "discount" from the dashboard. Only the server (service_role: catalog receiving) declares a discount, which is what
-- makes the declaration explicit.
CREATE FUNCTION private.fn_catalog_public_offer_messages()
RETURNS TABLE(
  offer_id uuid,
  store_id uuid,
  store_name text,
  product_size_id uuid,
  kind text,
  title text,
  description text,
  ends_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, private, pg_temp
AS $function$
  SELECT o.id,
         o.store_id,
         s.name,
         o.product_size_id,
         o.kind,
         left(btrim(o.title), 120),
         NULLIF(left(btrim(o.description), 500), ''),
         o.end_date
    FROM public.offers o
    JOIN public.stores s ON s.id = o.store_id
   WHERE o.is_active
     AND (o.start_date IS NULL OR o.start_date <= now())
     AND (o.end_date IS NULL OR o.end_date >= now())
     AND private.store_is_active(o.store_id)
     AND (
       o.product_size_id IS NULL
       OR EXISTS (
         SELECT 1
           FROM public.product_sizes ps
           JOIN public.products p ON p.id = ps.product_id
          WHERE ps.id = o.product_size_id
            AND p.status = 'published'
            AND p.is_active
       )
     );
$function$;

REVOKE ALL ON FUNCTION private.fn_catalog_public_offer_messages() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.fn_catalog_public_offer_messages() TO anon, authenticated, service_role;

CREATE VIEW public.catalog_offer_messages WITH (security_invoker = true) AS
SELECT offer_id, store_id, store_name, product_size_id, kind, title, description, ends_at
  FROM private.fn_catalog_public_offer_messages();

GRANT SELECT ON public.catalog_offer_messages TO anon, authenticated, service_role;
