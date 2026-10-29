-- Rolls back migrations/20261028163408_store_phase_hardening.sql.
-- Puts back the two legacy insert policies and the client grant on the three older order functions, removes the data
-- rules, the platform-only flag trigger, the account functions and the audit log table (the audit rows are lost: export
-- them first if they matter). Store accounts already linked keep working; their profile role is left as it is.
begin;

drop function if exists public.platform_unlink_store_account(uuid, uuid);
drop function if exists public.platform_link_store_account(uuid, text, uuid);
drop function if exists public.platform_store_accounts(uuid);
drop table if exists public.platform_audit_log;

drop trigger if exists guard_platform_columns on public.store_products;
drop function if exists private.guard_store_product_platform_columns();

alter table public.store_products drop constraint if exists store_products_link_is_http;
alter table public.stores drop constraint if exists stores_links_are_http;
alter table public.offers
  drop constraint if exists offers_dates_in_order,
  drop constraint if exists offers_discount_value_range,
  drop constraint if exists offers_description_length,
  drop constraint if exists offers_title_length;

grant execute on function public.create_checkout_session(jsonb) to authenticated;
grant execute on function public.create_store_order_request(jsonb) to authenticated;
grant execute on function public.create_store_order_request_from_cart(jsonb) to authenticated;

create policy own_insert on public.orders
  for insert to authenticated
  with check ((user_id = (select auth.uid())) and (status = 'pending'::text));
create policy own_insert on public.order_items
  for insert to authenticated
  with check (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id and o.user_id = (select auth.uid()) and o.status = 'pending'::text
  ));

commit;
