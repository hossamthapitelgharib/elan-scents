begin;

-- The browser now calls /api/* handlers. The handlers authenticate the Supabase access token,
-- then call these service-role-only wrappers with the verified user id. The wrappers set the
-- transaction-local JWT claims expected by the existing customer functions, so their ownership
-- checks remain in one place without granting the browser access to SECURITY DEFINER functions.

create or replace function public.replace_customer_cart_server(p_items jsonb, p_user_id uuid)
returns setof public.cart_items
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  return query select * from public.replace_customer_cart(p_items);
end;
$function$;

create or replace function public.place_store_order_server(p_payload jsonb, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  return public.place_store_order(p_payload);
end;
$function$;

create or replace function public.request_store_order_cancellation_server(p_request_id uuid, p_reason text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  return public.request_store_order_cancellation(p_request_id, p_reason);
end;
$function$;

create or replace function public.confirm_store_order_purchase_server(p_request_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  return public.confirm_store_order_purchase(p_request_id);
end;
$function$;

-- No public or authenticated role may invoke either the original customer functions or the
-- server wrappers. service_role is the only database caller; the browser never receives it.
revoke all on function public.replace_customer_cart(jsonb) from public, anon, authenticated;
revoke all on function public.place_store_order(jsonb) from public, anon, authenticated;
revoke all on function public.request_store_order_cancellation(uuid, text) from public, anon, authenticated;
revoke all on function public.confirm_store_order_purchase(uuid) from public, anon, authenticated;

grant execute on function public.replace_customer_cart(jsonb) to service_role;
grant execute on function public.place_store_order(jsonb) to service_role;
grant execute on function public.request_store_order_cancellation(uuid, text) to service_role;
grant execute on function public.confirm_store_order_purchase(uuid) to service_role;

grant execute on function public.replace_customer_cart_server(jsonb, uuid) to service_role;
grant execute on function public.place_store_order_server(jsonb, uuid) to service_role;
grant execute on function public.request_store_order_cancellation_server(uuid, text, uuid) to service_role;
grant execute on function public.confirm_store_order_purchase_server(uuid, uuid) to service_role;

commit;
