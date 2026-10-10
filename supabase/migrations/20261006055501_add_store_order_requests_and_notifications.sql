create table if not exists public.store_order_requests (
  id uuid primary key default gen_random_uuid(),
  tracking_number text not null unique,
  store_id uuid not null references public.stores(id),
  user_id uuid references auth.users(id),
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  customer_address text not null,
  customer_notes text,
  status text not null default 'awaiting_store_confirmation' check (status in ('awaiting_store_confirmation','store_confirmed','store_rejected','needs_review','completed','cancelled')),
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  shipping_amount numeric(12,2) check (shipping_amount is null or shipping_amount >= 0),
  total_amount numeric(12,2) check (total_amount is null or total_amount >= 0),
  currency text not null default 'EGP',
  store_order_reference text,
  failure_reason text,
  initial_payload jsonb not null default '{}'::jsonb,
  latest_store_payload jsonb,
  reconciliation_status text not null default 'pending' check (reconciliation_status in ('pending','matched','mismatched')),
  mismatch_fields jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_order_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.store_order_requests(id) on delete cascade,
  store_product_id uuid references public.store_products(id),
  product_size_id uuid references public.product_sizes(id),
  product_name text not null,
  brand_name text,
  size_label text,
  quantity integer not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_total numeric(12,2) not null check (line_total >= 0),
  currency text not null default 'EGP',
  created_at timestamptz not null default now(),
  unique (request_id, product_size_id)
);

create table if not exists public.store_order_notifications (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.store_order_requests(id) on delete set null,
  tracking_number text not null,
  event_type text not null check (event_type in ('initial_submitted','store_completed','store_rejected','store_update')),
  store_status text,
  match_status text not null default 'pending' check (match_status in ('pending','matched','mismatched','unmatched')),
  mismatch_fields jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create index if not exists store_order_requests_store_status_idx on public.store_order_requests(store_id, status, created_at desc);
create index if not exists store_order_notifications_tracking_idx on public.store_order_notifications(tracking_number, received_at desc);

alter table public.store_order_requests enable row level security;
alter table public.store_order_request_items enable row level security;
alter table public.store_order_notifications enable row level security;

create policy store_order_requests_public_insert on public.store_order_requests for insert to anon, authenticated with check (user_id is null or user_id = auth.uid());
create policy store_order_requests_admin_all on public.store_order_requests for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy store_order_requests_owner_read on public.store_order_requests for select to authenticated using (user_id = auth.uid());
create policy store_order_requests_store_read on public.store_order_requests for select to authenticated using (private.is_store_member(store_id));
create policy store_order_requests_store_update on public.store_order_requests for update to authenticated using (private.is_store_member(store_id)) with check (private.is_store_member(store_id));

create policy store_order_request_items_public_insert on public.store_order_request_items for insert to anon, authenticated with check (exists (select 1 from public.store_order_requests r where r.id = request_id and (r.user_id is null or r.user_id = auth.uid())));
create policy store_order_request_items_admin_all on public.store_order_request_items for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy store_order_request_items_owner_read on public.store_order_request_items for select to authenticated using (exists (select 1 from public.store_order_requests r where r.id = request_id and r.user_id = auth.uid()));
create policy store_order_request_items_store_read on public.store_order_request_items for select to authenticated using (exists (select 1 from public.store_order_requests r where r.id = request_id and private.is_store_member(r.store_id)));

create policy store_order_notifications_admin_all on public.store_order_notifications for all to authenticated using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy store_order_notifications_store_read on public.store_order_notifications for select to authenticated using (exists (select 1 from public.store_order_requests r where r.id = request_id and private.is_store_member(r.store_id)));
create policy store_order_notifications_owner_read on public.store_order_notifications for select to authenticated using (exists (select 1 from public.store_order_requests r where r.id = request_id and r.user_id = auth.uid()));

insert into public.site_settings (key, value) values ('order_notification_endpoint', null) on conflict (key) do nothing;