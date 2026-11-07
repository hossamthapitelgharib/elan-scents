-- Rollback of storefront_activity_from_customer_tables: public.public_products reads the three figures from
-- public.product_stats again (the hand-entered sample numbers, which this migration never touched) and the helper
-- function is dropped. No data is lost either way.
begin;

create or replace view public.public_products with (security_invoker = true) as
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
    ( SELECT min(co.price) AS min
           FROM cheapest_offers co
          WHERE co.product_id = p.id) AS min_price,
    ( SELECT count(*) AS count
           FROM cheapest_offers co
          WHERE co.product_id = p.id) AS available_sizes,
    ps.views_count,
    ps.sales_count,
    ps.search_count,
    ps.request_count,
    ps.average_rating,
    ps.reviews_count,
    ps.distinctiveness_score,
    COALESCE(( SELECT bool_or(sp.is_catalog_bestseller) AS bool_or
           FROM store_products sp
             JOIN product_sizes sps ON sps.id = sp.product_size_id
          WHERE sps.product_id = p.id AND sp.sync_status = 'synced'::text), false) AS catalog_bestseller
   FROM products p
     JOIN brands b ON b.id = p.brand_id
     LEFT JOIN product_stats ps ON ps.product_id = p.id
  WHERE p.status = 'published'::text AND p.is_active AND (EXISTS ( SELECT 1
           FROM cheapest_offers co
          WHERE co.product_id = p.id));

drop function if exists private.fn_product_public_activity();

commit;
