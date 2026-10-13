-- Additive only: nullable columns so existing rows/queries are unaffected.
alter table public.media_library
  add column if not exists title text,
  add column if not exists category text,
  add column if not exists storage_path text,
  add column if not exists mime_type text,
  add column if not exists size_bytes bigint;

alter table public.media_library
  add constraint media_library_size_nonneg check (size_bytes is null or size_bytes >= 0);

create index if not exists idx_media_library_category_created on public.media_library (category, created_at desc);
create unique index if not exists uq_media_library_storage_path on public.media_library (storage_path) where storage_path is not null;
