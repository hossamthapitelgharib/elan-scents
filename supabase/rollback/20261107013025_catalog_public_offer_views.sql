-- Restore the pre-wrapper catalog views and remove the public wrapper functions.
BEGIN;

CREATE OR REPLACE VIEW public.catalog_eligible_offers AS
SELECT store_product_id, product_size_id, product_id, brand_id, store_id,
       store_name, price, currency, stock_quantity, price_includes_tax,
       price_includes_shipping, last_synced_at, is_available, sync_status,
       store_status, is_new_arrival, is_coming_soon, is_catalog_bestseller
FROM private.fn_catalog_eligible_offers();

CREATE OR REPLACE VIEW public.catalog_platform_offers AS
SELECT DISTINCT ON (offer.product_size_id)
       offer.store_product_id, offer.product_size_id, offer.product_id,
       offer.brand_id, offer.store_id, offer.store_name, offer.price,
       offer.currency, offer.stock_quantity, offer.price_includes_tax,
       offer.price_includes_shipping, offer.last_synced_at, offer.is_available,
       offer.sync_status, offer.store_status, offer.is_new_arrival,
       offer.is_coming_soon, offer.is_catalog_bestseller
FROM private.fn_catalog_eligible_offers() AS offer
WHERE offer.store_status = 'active'
ORDER BY offer.product_size_id, offer.price ASC,
         offer.commission_rate DESC, offer.priority_rank ASC,
         offer.store_id ASC, offer.store_product_id ASC;

CREATE OR REPLACE VIEW public.catalog_global_offers AS
SELECT store_product_id, product_size_id, product_id, brand_id, store_id,
       store_name, price, currency, stock_quantity, price_includes_tax,
       price_includes_shipping, last_synced_at, is_available, sync_status,
       store_status, is_new_arrival, is_coming_soon, is_catalog_bestseller
FROM public.catalog_platform_offers;

GRANT SELECT ON public.catalog_eligible_offers, public.catalog_platform_offers,
  public.catalog_global_offers TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS private.fn_catalog_public_eligible_offers();
DROP FUNCTION IF EXISTS private.fn_catalog_public_platform_offers();
COMMIT;
