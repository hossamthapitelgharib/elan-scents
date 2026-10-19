ALTER TABLE public.store_order_request_items
  DROP CONSTRAINT IF EXISTS store_order_request_items_source_cart_item_id_fkey;

COMMENT ON COLUMN public.store_order_request_items.source_cart_item_id IS
  'Original cart_items.id used to create this order item; retained as an immutable lineage identifier after the cart row is cleared.';
