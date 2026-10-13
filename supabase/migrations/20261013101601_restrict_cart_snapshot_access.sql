revoke select, insert, update on public.cart_items from authenticated;
revoke select (id,user_id,store_product_id,quantity,created_at,updated_at,product_snapshot) on public.cart_items from authenticated;
revoke insert (id,user_id,store_product_id,quantity,created_at,updated_at,product_snapshot) on public.cart_items from authenticated;
revoke update (id,user_id,store_product_id,quantity,created_at,updated_at,product_snapshot) on public.cart_items from authenticated;

grant select (user_id,store_product_id,quantity) on public.cart_items to authenticated;
grant insert (user_id,store_product_id,quantity) on public.cart_items to authenticated;
grant update (store_product_id,quantity) on public.cart_items to authenticated;
grant delete on public.cart_items to authenticated;
