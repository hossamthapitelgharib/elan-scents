-- ROLLBACK for supabase/migrations/<version>_harden_anon_grants_rls_initplan_and_order_pricing.sql
-- Snapshot taken from the live project immediately before the migration was applied (2026-10-10).
-- It is ADDITIVE: it only re-grants privileges and restores the previous policy/function bodies. It never revokes,
-- because REVOKE ... ON TABLE would also drop the column-level SELECT grants the public catalog relies on.
-- Run manually, only if the project owner asks for the previous behaviour back.
begin;

-- 1) table privileges as they were
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.analytics_events to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.aromatic_notes to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.cart_items to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.categories to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.cheapest_offers to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.commissions to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.contact_messages to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.favorites to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.marketing_phrases to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.media_library to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.occasions to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.offers to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.order_items to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.orders to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.product_categories to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.product_images to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.product_notes to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.product_occasions to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.product_sizes to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.product_stats to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.products to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.profiles to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.public_brands to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.public_products to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.public_stores to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.reviews to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.site_settings to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.store_accounts to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.store_products to anon, authenticated;
grant DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE on public.sync_logs to anon, authenticated;
grant DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE on public.brands to anon, authenticated;
grant DELETE, INSERT, REFERENCES, TRIGGER, TRUNCATE, UPDATE on public.stores to anon, authenticated;
grant REFERENCES, SELECT, TRIGGER, TRUNCATE on public.checkout_sessions to anon, authenticated;
grant REFERENCES, SELECT, TRIGGER, TRUNCATE on public.notifications to anon, authenticated;
grant REFERENCES, SELECT, TRIGGER, TRUNCATE on public.order_operation_events to anon, authenticated;
grant REFERENCES, SELECT, TRIGGER, TRUNCATE on public.order_reconciliation_checks to anon, authenticated;
grant REFERENCES, SELECT, TRIGGER, TRUNCATE on public.store_order_cart_restorations to anon, authenticated;
grant REFERENCES, SELECT, TRIGGER, TRUNCATE on public.store_order_notifications to anon, authenticated;
grant REFERENCES, SELECT, TRIGGER, TRUNCATE on public.store_order_request_items to anon, authenticated;
grant REFERENCES, SELECT, TRIGGER, TRUNCATE on public.store_order_requests to anon, authenticated;
grant DELETE, INSERT, SELECT, UPDATE on public.editor_archive to authenticated;
grant DELETE, INSERT, SELECT, UPDATE on public.editor_saved_elements to authenticated;
grant DELETE, INSERT, SELECT, UPDATE on public.editor_section_items to authenticated;
grant DELETE, INSERT, SELECT, UPDATE on public.editor_sections to authenticated;
grant SELECT on public.editor_section_items, public.editor_sections to anon;
grant SELECT on public.guest_visitors to authenticated;

-- default privileges for objects created by postgres in schema public
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;

-- 2) policies with the previous (per-row auth.uid()) expressions
alter policy checkout_sessions_owner_read on public.checkout_sessions using ((user_id = auth.uid()));
alter policy notifications_realtime_user_read on public.notifications using ((user_id = auth.uid()));
alter policy notifications_realtime_store_read on public.notifications using ((exists (select 1 from store_accounts sa where ((sa.user_id = auth.uid()) and (sa.store_id = notifications.store_id)))));
alter policy store_order_cart_restorations_owner_read on public.store_order_cart_restorations using ((user_id = auth.uid()));
alter policy store_order_notifications_owner_read on public.store_order_notifications using ((exists (select 1 from store_order_requests r where ((r.id = store_order_notifications.request_id) and (r.user_id = auth.uid())))));
alter policy store_order_request_items_owner_read on public.store_order_request_items using ((exists (select 1 from store_order_requests r where ((r.id = store_order_request_items.request_id) and (r.user_id = auth.uid())))));
alter policy store_order_requests_owner_read on public.store_order_requests using ((user_id = auth.uid()));

-- 3) create_store_order_request as it was live before (20261010014304_harden_order_user_binding)
create or replace function public.create_store_order_request(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
declare
  v_request public.store_order_requests;
  v_item jsonb;
  v_store_id uuid;
  v_user_id uuid := auth.uid();
  v_checkout_session_id uuid := nullif(p_payload->>'checkoutSessionId', '')::uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  v_store_id := (p_payload->>'storeId')::uuid;
  if not exists (
    select 1 from public.stores s
    where s.id = v_store_id and s.status = 'active'
  ) then
    raise exception 'Invalid or inactive store';
  end if;
  if v_checkout_session_id is not null and not exists (
    select 1 from public.checkout_sessions c
    where c.id = v_checkout_session_id and c.user_id = v_user_id
  ) then
    raise exception 'Checkout session does not belong to the authenticated user';
  end if;
  if coalesce(trim(p_payload->'customer'->>'name'),'') = ''
     or coalesce(trim(p_payload->'customer'->>'phone'),'') = ''
     or coalesce(trim(p_payload->'customer'->>'address'),'') = '' then
    raise exception 'Customer details are required';
  end if;
  insert into public.store_order_requests
    (tracking_number, checkout_tracking_number, checkout_session_id, store_id,
     user_id, customer_name, customer_phone, customer_email, customer_address,
     customer_notes, subtotal, currency, initial_payload)
  values
    (p_payload->>'trackingNumber',
     coalesce(nullif(p_payload->>'checkoutTrackingNumber', ''), p_payload->>'trackingNumber'),
     v_checkout_session_id, v_store_id, v_user_id,
     trim(p_payload->'customer'->>'name'),
     trim(p_payload->'customer'->>'phone'),
     nullif(trim(p_payload->'customer'->>'email'), ''),
     trim(p_payload->'customer'->>'address'),
     nullif(trim(p_payload->'customer'->>'notes'), ''),
     coalesce((p_payload->>'subtotal')::numeric, 0),
     coalesce(nullif(p_payload->>'currency', ''), 'EGP'), p_payload)
  returning * into v_request;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb))
  loop
    insert into public.store_order_request_items
      (request_id, store_product_id, product_size_id, product_name,
       brand_name, size_label, quantity, unit_price, line_total, currency)
    values
      (v_request.id,
       nullif(v_item->>'storeProductId', '')::uuid,
       nullif(v_item->>'productSizeId', '')::uuid,
       v_item->>'name', v_item->>'brand', nullif(v_item->>'size', ''),
       (v_item->>'quantity')::integer,
       (v_item->>'unitPrice')::numeric,
       (v_item->>'total')::numeric,
       coalesce(nullif(v_item->>'currency', ''), 'EGP'));
  end loop;

  insert into public.store_order_notifications
    (request_id, tracking_number, event_type, store_status, match_status, payload)
  values
    (v_request.id, v_request.tracking_number, 'initial_submitted',
     'awaiting_store_confirmation', 'matched', p_payload);

  return jsonb_build_object(
    'id', v_request.id,
    'trackingNumber', v_request.tracking_number,
    'checkoutTrackingNumber', v_request.checkout_tracking_number,
    'checkoutSessionId', v_request.checkout_session_id,
    'status', v_request.status);
end;
$function$;
grant execute on function public.create_store_order_request(jsonb) to authenticated;

commit;
