create table if not exists public.store_shipments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.store_order_requests(id) on delete cascade,
  store_id uuid not null references public.stores(id),
  carrier_name text,
  tracking_code text,
  shipping_status text not null default 'preparing' check (shipping_status in ('preparing','handed_to_carrier','in_transit','out_for_delivery','delivered','delayed','returned','cancelled')),
  status_note text,
  estimated_delivery_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(coalesce(carrier_name, '')) <= 120),
  check (length(coalesce(tracking_code, '')) <= 160),
  check (length(coalesce(status_note, '')) <= 500)
);

create index if not exists store_shipments_store_status_idx on public.store_shipments(store_id, shipping_status, updated_at desc);
create index if not exists store_shipments_request_idx on public.store_shipments(request_id);

alter table public.store_shipments enable row level security;

create policy store_shipments_admin_all on public.store_shipments
  for all to authenticated
  using (private.is_platform_admin())
  with check (private.is_platform_admin());

create policy store_shipments_owner_read on public.store_shipments
  for select to authenticated
  using (exists (select 1 from public.store_order_requests r where r.id = request_id and r.user_id = auth.uid()));

create policy store_shipments_store_read on public.store_shipments
  for select to authenticated
  using (private.is_store_member(store_id));

create or replace function private.validate_store_shipment_store()
returns trigger
language plpgsql
security invoker
set search_path = public, private
as $$
begin
  if not exists (select 1 from public.store_order_requests r where r.id = new.request_id and r.store_id = new.store_id) then
    raise exception 'shipment_store_mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_store_shipment_store on public.store_shipments;
create trigger validate_store_shipment_store
before insert or update on public.store_shipments
for each row execute function private.validate_store_shipment_store();

create or replace function private.set_store_shipments_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, private
as $$
begin
  new.updated_at = now();
  if new.shipping_status = 'delivered' and new.delivered_at is null then
    new.delivered_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists set_store_shipments_updated_at on public.store_shipments;
create trigger set_store_shipments_updated_at
before update on public.store_shipments
for each row execute function private.set_store_shipments_updated_at();

revoke all on public.store_shipments from anon;
revoke insert, update, delete on public.store_shipments from authenticated;
grant select on public.store_shipments to authenticated;
