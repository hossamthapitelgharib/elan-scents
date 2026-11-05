-- Favourites follow the customer's account: one row per (customer, size card the heart is on).
-- The table was made per product and the storefront never wrote to it (it has no rows). The storefront now saves the heart of each
-- size card (product_sizes.id), so the unique key becomes (customer, size): two sizes of one perfume can both be favourites.
-- product_id stays (it carries the foreign key to products) and a trigger fills it from the size, so a row can never name a size
-- together with another product. Policies and grants are unchanged: a customer reads and writes only their own rows.
alter table public.favorites add column if not exists product_size_id uuid references public.product_sizes (id) on delete cascade;

update public.favorites f
   set product_size_id = (select ps.id from public.product_sizes ps where ps.product_id = f.product_id order by ps.size_ml nulls last, ps.id limit 1)
 where f.product_size_id is null;

-- fails, and takes the whole migration back, if a row still has no size (none today: the table is empty)
alter table public.favorites alter column product_size_id set not null;

alter table public.favorites drop constraint if exists favorites_user_id_product_id_key;
alter table public.favorites add constraint favorites_user_id_product_size_id_key unique (user_id, product_size_id);
create index if not exists idx_favorites_product_size_id on public.favorites (product_size_id);

create or replace function private.favorites_fill_product()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  select ps.product_id into new.product_id from public.product_sizes ps where ps.id = new.product_size_id;
  return new;
end $function$;

drop trigger if exists favorites_fill_product on public.favorites;
create trigger favorites_fill_product
  before insert or update of product_size_id, product_id on public.favorites
  for each row execute function private.favorites_fill_product();
