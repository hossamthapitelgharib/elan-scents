begin;

do $$
begin
  if has_table_privilege('anon', 'public.guest_visitors', 'SELECT') then
    raise exception 'anon must not read guest_visitors';
  end if;
  if has_table_privilege('authenticated', 'public.guest_visitors', 'SELECT') then
    raise exception 'authenticated users must not read guest_visitors directly';
  end if;
  if has_table_privilege('anon', 'public.customer_product_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.customer_product_events', 'SELECT') then
    raise exception 'customer activity events must be server-only';
  end if;
  if has_table_privilege('anon', 'public.profiles', 'SELECT')
     or has_table_privilege('anon', 'public.cart_items', 'SELECT') then
    raise exception 'anonymous users must not directly read customer profiles or carts';
  end if;
  if has_function_privilege('anon', 'public.platform_store_summary()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.platform_store_summary()', 'EXECUTE') then
    raise exception 'store summary RPC must not be directly executable by clients';
  end if;
  if not has_function_privilege('service_role', 'public.platform_store_summary()', 'EXECUTE') then
    raise exception 'server API must be able to execute store summary RPC';
  end if;
end;
$$;

rollback;
