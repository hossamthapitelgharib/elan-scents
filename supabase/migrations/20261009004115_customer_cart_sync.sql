create or replace function public.replace_customer_cart(p_items jsonb)
returns setof public.cart_items
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_user_id uuid := auth.uid();
  v_item jsonb;
  v_store_product_id uuid;
  v_quantity integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  delete from public.cart_items where user_id = v_user_id;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    begin
      v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid;
      v_quantity := (v_item->>'quantity')::integer;
    exception when others then
      v_store_product_id := null;
      v_quantity := null;
    end;

    if v_store_product_id is null or coalesce(v_quantity, 0) < 1 then
      continue;
    end if;

    if exists (select 1 from public.store_products sp where sp.id = v_store_product_id) then
      insert into public.cart_items (user_id, store_product_id, quantity)
      values (v_user_id, v_store_product_id, v_quantity)
      on conflict (user_id, store_product_id)
      do update set quantity = excluded.quantity, updated_at = now();
    end if;
  end loop;

  return query
  select c.*
  from public.cart_items c
  where c.user_id = v_user_id
  order by c.updated_at desc;
end;
$$;

revoke all on function public.replace_customer_cart(jsonb) from public;
grant execute on function public.replace_customer_cart(jsonb) to authenticated;