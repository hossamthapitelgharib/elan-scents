CREATE INDEX IF NOT EXISTS store_order_requests_best_seller_scope_idx
  ON public.store_order_requests (created_at, status, reconciliation_status)
  INCLUDE (id, user_id, checkout_session_id, store_id);

CREATE INDEX IF NOT EXISTS store_order_request_items_best_seller_join_idx
  ON public.store_order_request_items (request_id, product_id, size_label)
  INCLUDE (quantity, product_name, brand_name);

COMMENT ON VIEW public.registered_customer_best_sellers IS
  'Derived ranking of registered-customer best sellers. Uses eligible completed/delivered store order requests, aggregates by base product, and orders by net units then purchase count.';
