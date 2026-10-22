begin;

-- guest_product_analytics has no primary key (Supabase advisor 0004_no_primary_key). It already enforces a
-- UNIQUE constraint over (visitor_hash, product_id, activity_date, event_type), and all four columns are
-- NOT NULL, so that natural key becomes the PRIMARY KEY. Every upsert in the schema infers its target from
-- the column list (ON CONFLICT (visitor_hash, product_id, activity_date, event_type)), which a primary key
-- satisfies, and no function or policy names the old constraint. The drop and the add run in one transaction
-- under the same lock, so no writer can insert a duplicate in between.
alter table public.guest_product_analytics
  drop constraint guest_product_analytics_visitor_hash_product_id_activity_da_key;

alter table public.guest_product_analytics
  add constraint guest_product_analytics_pkey
  primary key (visitor_hash, product_id, activity_date, event_type);

commit;
