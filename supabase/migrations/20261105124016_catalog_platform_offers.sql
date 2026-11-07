-- Make the comparison scope explicit: offers from active stores registered on this platform only.
-- catalog_global_offers remains as a compatibility alias during migration of older clients.
CREATE OR REPLACE VIEW public.catalog_platform_offers AS
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
WHERE offer.store_status = 'active'
ORDER BY offer.product_size_id,
         offer.price ASC,
         offer.commission_rate DESC,
         offer.priority_rank ASC,
         offer.store_id ASC,
         offer.store_product_id ASC;

GRANT SELECT ON public.catalog_platform_offers TO anon, authenticated, service_role;
