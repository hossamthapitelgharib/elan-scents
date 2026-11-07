begin;

drop policy if exists public_read on public.categories;
create policy public_read on public.categories
  for select to anon, authenticated
  using (true);

alter table public.categories
  drop constraint if exists categories_category_type_check;
alter table public.categories
  drop column if exists category_type;

drop index if exists public.products_gender_catalog_idx;

commit;