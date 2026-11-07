begin;

alter table public.categories
  add column if not exists category_type text not null default 'catalog';

alter table public.categories
  drop constraint if exists categories_category_type_check;
alter table public.categories
  add constraint categories_category_type_check
  check (category_type in ('catalog', 'gender_legacy'));

update public.categories
set category_type = 'gender_legacy'
where id in (
  'cbc5baa5-b571-4b44-b704-4f72d3b53024'::uuid,
  '43353def-afea-4ab0-8da1-8e7941783fe3'::uuid,
  '2fe3c288-ccd2-4585-8b74-0ddf6ff828e1'::uuid
)
  and name in ('رجالي', 'نسائي', 'عطر يجمعنا');

create index if not exists products_gender_catalog_idx
  on public.products (gender)
  where status = 'published' and is_active;

drop policy if exists public_read on public.categories;
create policy public_read on public.categories
  for select to anon, authenticated
  using (category_type = 'catalog');

comment on column public.categories.category_type is
  'catalog is a real product taxonomy; gender_legacy is retained only for historical audit because products.gender is authoritative.';
comment on column public.products.gender is
  'Authoritative storefront gender filter: men, women, or unisex.';

commit;