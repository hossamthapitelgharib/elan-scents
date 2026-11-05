-- Rollback for 20261104160507_favorites_by_size.sql (only safe while no customer has two sizes of the same product as favourites).
drop trigger if exists favorites_fill_product on public.favorites;
drop function if exists private.favorites_fill_product();
alter table public.favorites drop constraint if exists favorites_user_id_product_size_id_key;
drop index if exists public.idx_favorites_product_size_id;
alter table public.favorites drop column if exists product_size_id;
alter table public.favorites add constraint favorites_user_id_product_id_key unique (user_id, product_id);
