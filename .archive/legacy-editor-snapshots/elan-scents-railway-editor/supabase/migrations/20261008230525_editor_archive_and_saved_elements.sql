-- Archive: a deleted/expired element stored whole so it can be restored.
-- payload is capped at ~1MB so media binaries can never be embedded; files live in Storage and payload keeps URLs only.
create table if not exists public.editor_archive (
  id uuid primary key default gen_random_uuid(),
  element_id text not null,
  kind text not null check (length(btrim(kind)) > 0),
  name text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 1048576),
  archived_reason text check (archived_reason is null or archived_reason in ('manual','timer_expired')),
  archived_at timestamptz not null default now(),
  restored_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.editor_saved_elements (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  kind text not null check (length(btrim(kind)) > 0),
  category text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 1048576),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_editor_archive_archived_at on public.editor_archive (archived_at desc);
create index if not exists idx_editor_archive_element on public.editor_archive (element_id);
create index if not exists idx_editor_archive_created_by on public.editor_archive (created_by);
create index if not exists idx_editor_saved_kind_created on public.editor_saved_elements (kind, created_at desc);
create index if not exists idx_editor_saved_created_by on public.editor_saved_elements (created_by);

create trigger set_updated_at before update on public.editor_archive
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.editor_saved_elements
  for each row execute function private.set_updated_at();

alter table public.editor_archive enable row level security;
alter table public.editor_saved_elements enable row level security;

-- Admin only. No public policy and no anon grants at all.
create policy admin_all on public.editor_archive for all to authenticated
  using ((select private.is_platform_admin()))
  with check ((select private.is_platform_admin()));
create policy admin_all on public.editor_saved_elements for all to authenticated
  using ((select private.is_platform_admin()))
  with check ((select private.is_platform_admin()));

revoke all on public.editor_archive, public.editor_saved_elements from anon, authenticated;
grant select, insert, update, delete on public.editor_archive, public.editor_saved_elements to authenticated;
