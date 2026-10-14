begin;

-- Keep one canonical event ledger while exposing the four requested event tables
-- as read-only, non-duplicating category views for service-side dashboards.
create or replace view public.customer_product_view_events
with (security_invoker = true) as
select id, guest_id, user_id, session_id, product_id, product_size_id,
       store_product_id, quantity, occurred_at, product_snapshot
from public.customer_product_events
where event_type = 'view';

create or replace view public.customer_product_search_events
with (security_invoker = true) as
select id, guest_id, user_id, session_id, product_id, product_size_id,
       store_product_id, quantity, occurred_at, product_snapshot
from public.customer_product_events
where event_type = 'search';

create or replace view public.customer_product_cart_add_events
with (security_invoker = true) as
select id, guest_id, user_id, session_id, product_id, product_size_id,
       store_product_id, quantity, occurred_at, product_snapshot
from public.customer_product_events
where event_type = 'cart_add';

create or replace view public.customer_product_cart_remove_events
with (security_invoker = true) as
select id, guest_id, user_id, session_id, product_id, product_size_id,
       store_product_id, quantity, occurred_at, product_snapshot
from public.customer_product_events
where event_type = 'cart_remove';

-- Guest baskets are JSON snapshots; expand them into item rows without trusting
-- browser-supplied product data. The complete server-built product stays intact.
create or replace view public.guest_current_cart_items
with (security_invoker = true) as
select gv.id as guest_id,
       gv.fingerprint_hash,
       gv.first_seen_at,
       gv.last_seen_at,
       item.ordinality::integer as item_position,
       case when coalesce(item.value->>'sid','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then (item.value->>'sid')::uuid else null end as product_size_id,
       case when coalesce(item.value->>'storeProductId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then (item.value->>'storeProductId')::uuid else null end as store_product_id,
       case when coalesce(item.value->>'q',item.value->>'quantity','') ~ '^[0-9]{1,3}$'
            then greatest(1,least(99,coalesce(item.value->>'q',item.value->>'quantity')::integer)) else 1 end as quantity,
       item.value->'productSnapshot' as product_snapshot,
       item.value as cart_item_snapshot
from public.guest_visitors gv
cross join lateral jsonb_array_elements(gv.cart_snapshot) with ordinality as item(value, ordinality)
where gv.status = 'guest' and gv.identity_version = 2;

-- Registered current basket rows retain their authoritative product snapshot.
create or replace view public.registered_customer_current_cart_items
with (security_invoker = true) as
select ci.id as cart_item_id,
       ci.user_id,
       sp.store_id,
       ci.store_product_id,
       sp.product_size_id,
       ps.product_id,
       ci.quantity,
       ci.created_at,
       ci.updated_at,
       ci.product_snapshot
from public.cart_items ci
join public.store_products sp on sp.id = ci.store_product_id
join public.product_sizes ps on ps.id = sp.product_size_id;

comment on view public.customer_product_view_events is 'Read-only view of product view events from the canonical customer_product_events ledger; guest and registered actors are distinguished by guest_id/user_id.';
comment on view public.customer_product_search_events is 'Read-only view of product search-result events from the canonical customer_product_events ledger.';
comment on view public.customer_product_cart_add_events is 'Read-only view of product cart-add events from the canonical customer_product_events ledger.';
comment on view public.customer_product_cart_remove_events is 'Read-only view of product cart-remove events from the canonical customer_product_events ledger.';
comment on view public.guest_current_cart_items is 'Expanded read-only rows for the current guest cart, including authoritative product snapshots.';
comment on view public.registered_customer_current_cart_items is 'Read-only rows for registered customers current cart, including authoritative product snapshots.';

revoke all privileges on table
  public.customer_product_view_events,
  public.customer_product_search_events,
  public.customer_product_cart_add_events,
  public.customer_product_cart_remove_events,
  public.guest_current_cart_items,
  public.registered_customer_current_cart_items
from public, anon, authenticated;

grant select on table
  public.customer_product_view_events,
  public.customer_product_search_events,
  public.customer_product_cart_add_events,
  public.customer_product_cart_remove_events,
  public.guest_current_cart_items,
  public.registered_customer_current_cart_items
to service_role;

commit;
