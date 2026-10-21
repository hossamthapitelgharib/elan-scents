-- Rolls back migrations/20261021000100_guest_product_analytics_primary_key.sql (the version moves with the
-- migration when it is applied). Restores the UNIQUE constraint under its original name; the table then has
-- no primary key again, which re-opens the advisor finding on purpose.
begin;

alter table public.guest_product_analytics
  drop constraint guest_product_analytics_pkey;

alter table public.guest_product_analytics
  add constraint guest_product_analytics_visitor_hash_product_id_activity_da_key
  unique (visitor_hash, product_id, activity_date, event_type);

commit;
