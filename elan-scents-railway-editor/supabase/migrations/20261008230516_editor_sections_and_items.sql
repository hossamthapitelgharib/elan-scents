-- Editor sections: a section's identity, filters, selection mode and timer.
-- Layout/design lives in GitHub (design/home.json); element_id is the stable id of the element in the design file.
create table if not exists public.editor_sections (
  id uuid primary key default gen_random_uuid(),
  element_id text not null unique,
  name text not null check (length(btrim(name)) > 0),
  purpose text,
  selection_mode text not null default 'manual' check (selection_mode in ('manual','auto')),
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  timer_mode text not null default 'none' check (timer_mode in ('none','window','duration')),
  starts_at timestamptz,
  ends_at timestamptz,
  duration_hours integer check (duration_hours is null or duration_hours > 0),
  status text not null default 'active' check (status in ('active','archived')),
  archived_at timestamptz,
  archive_reason text check (archive_reason is null or archive_reason in ('manual','timer_expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint editor_sections_timer_valid check (
    timer_mode = 'none'
    or (timer_mode = 'window' and starts_at is not null and ends_at is not null and ends_at > starts_at)
    or (timer_mode = 'duration' and duration_hours is not null and ends_at is not null)
  ),
  constraint editor_sections_archive_valid check ((status = 'archived') = (archived_at is not null))
);

-- Manual picks: one row per perfume+size, duplicates blocked by the primary key.
create table if not exists public.editor_section_items (
  section_id uuid not null references public.editor_sections(id) on delete cascade,
  product_size_id uuid not null references public.product_sizes(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (section_id, product_size_id)
);

create index if not exists idx_editor_section_items_size on public.editor_section_items (product_size_id);
create index if not exists idx_editor_sections_status_ends on public.editor_sections (status, ends_at);

create trigger set_updated_at before update on public.editor_sections
  for each row execute function private.set_updated_at();

alter table public.editor_sections enable row level security;
alter table public.editor_section_items enable row level security;

create policy admin_all on public.editor_sections for all to authenticated
  using ((select private.is_platform_admin()))
  with check ((select private.is_platform_admin()));
create policy admin_all on public.editor_section_items for all to authenticated
  using ((select private.is_platform_admin()))
  with check ((select private.is_platform_admin()));

-- Public: only active, in-window sections (expiry is enforced at read time, even if the editor is closed).
create policy public_read on public.editor_sections for select to anon, authenticated
  using (
    status = 'active'
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now())
  );
-- Items are visible only when their section is visible (the subquery is filtered by the policy above).
create policy public_read on public.editor_section_items for select to anon, authenticated
  using (exists (select 1 from public.editor_sections s where s.id = section_id));

revoke all on public.editor_sections, public.editor_section_items from anon, authenticated;
grant select on public.editor_sections, public.editor_section_items to anon;
grant select, insert, update, delete on public.editor_sections, public.editor_section_items to authenticated;
