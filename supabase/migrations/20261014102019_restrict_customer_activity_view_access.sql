begin;

revoke all privileges on table
  public.customer_product_view_events,
  public.customer_product_search_events,
  public.customer_product_cart_add_events,
  public.customer_product_cart_remove_events,
  public.guest_current_cart_items,
  public.registered_customer_current_cart_items
from public, anon, authenticated, service_role;

grant select on table
  public.customer_product_view_events,
  public.customer_product_search_events,
  public.customer_product_cart_add_events,
  public.customer_product_cart_remove_events,
  public.guest_current_cart_items,
  public.registered_customer_current_cart_items
to service_role;

commit;
