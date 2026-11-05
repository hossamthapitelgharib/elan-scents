-- Run on the live database after catalog_data_foundation inside this same transaction.
-- All fixture rows are synthetic and are discarded by the final ROLLBACK.
BEGIN;

DO $test$
DECLARE
  v_brand uuid := gen_random_uuid();
  v_store_a uuid := gen_random_uuid();
  v_store_b uuid := gen_random_uuid();
  v_store_zero uuid := gen_random_uuid();
  v_store_stale uuid := gen_random_uuid();
  v_store_inactive uuid := gen_random_uuid();
  v_product uuid := gen_random_uuid();
  v_size uuid := gen_random_uuid();
  v_currency_test_size uuid := gen_random_uuid();
  v_global record;
BEGIN
  INSERT INTO public.brands (id, name, slug) VALUES (v_brand, 'Catalog Contract Test', 'catalog-contract-' || v_brand::text);
  INSERT INTO public.stores (id, name, slug, status, commission_rate, priority_rank) VALUES
    (v_store_a, 'Catalog Contract A', 'catalog-contract-a-' || v_store_a::text, 'active', 15, 100),
    (v_store_b, 'Catalog Contract B', 'catalog-contract-b-' || v_store_b::text, 'active', 15, 100),
    (v_store_zero, 'Catalog Contract Zero', 'catalog-contract-zero-' || v_store_zero::text, 'active', 15, 100),
    (v_store_stale, 'Catalog Contract Stale', 'catalog-contract-stale-' || v_store_stale::text, 'active', 15, 100),
    (v_store_inactive, 'Catalog Contract Inactive', 'catalog-contract-inactive-' || v_store_inactive::text, 'inactive', 15, 100);
  INSERT INTO public.products (id, brand_id, name, slug, gender, status, is_active)
    VALUES (v_product, v_brand, 'Catalog Contract Perfume', 'catalog-contract-' || v_product::text, 'men', 'published', true);
  INSERT INTO public.product_sizes (id, product_id, size_ml, size_label) VALUES
    (v_size, v_product, 50, '50 ml'),
    (v_currency_test_size, v_product, 100, '100 ml');

  INSERT INTO public.store_products (store_id, product_size_id, price, currency, stock_quantity, is_available, sync_status) VALUES
    (v_store_a, v_size, 100, 'EGP', NULL, true, 'synced'),
    (v_store_b, v_size, 120, 'EGP', 5, true, 'synced'),
    (v_store_zero, v_size, 1, 'EGP', 0, true, 'synced'),
    (v_store_stale, v_size, 2, 'EGP', 5, true, 'stale'),
    (v_store_inactive, v_size, 3, 'EGP', 5, true, 'synced');

  IF (SELECT count(*) FROM public.catalog_eligible_offers WHERE product_size_id = v_size) <> 2 THEN
    RAISE EXCEPTION 'eligible offer contract failed: expected active, available, synced A/B only';
  END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_eligible_offers WHERE product_size_id = v_size AND store_id = v_store_zero) THEN
    RAISE EXCEPTION 'zero stock offer must not be eligible';
  END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_eligible_offers WHERE product_size_id = v_size AND store_id = v_store_stale) THEN
    RAISE EXCEPTION 'unsynced offer must not be eligible';
  END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_eligible_offers WHERE product_size_id = v_size AND store_id = v_store_inactive) THEN
    RAISE EXCEPTION 'inactive store offer must not be eligible';
  END IF;

  SELECT store_product_id, store_id, price, currency
    INTO v_global FROM public.catalog_platform_offers WHERE product_size_id = v_size;
  IF v_global.store_id <> v_store_a OR v_global.price <> 100 OR v_global.currency <> 'EGP' THEN
    RAISE EXCEPTION 'global offer must be the exact 100 EGP A row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_products WHERE id = v_global.store_product_id AND product_size_id = v_size AND store_id = v_global.store_id AND price = v_global.price) THEN
    RAISE EXCEPTION 'global offer store_product_id and price must be from the same source row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_platform_offers WHERE product_size_id = v_size AND store_id = v_store_b) THEN
    RAISE EXCEPTION 'store B must not pass a store-owner filter when A owns the global offer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.public_products WHERE id = v_product AND gender = 'men') THEN
    RAISE EXCEPTION 'public product view must expose products.gender';
  END IF;

  BEGIN
    INSERT INTO public.store_products (store_id, product_size_id, price, currency, stock_quantity, is_available, sync_status)
      VALUES (v_store_a, v_currency_test_size, 10, 'USD', 1, true, 'synced');
    RAISE EXCEPTION 'single-currency constraint did not reject USD';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$test$;

ROLLBACK;
