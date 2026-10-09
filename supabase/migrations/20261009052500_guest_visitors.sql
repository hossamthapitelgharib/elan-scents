begin;

create table public.guest_visitors (
  id uuid primary key default gen_random_uuid(),
  fingerprint_hash text unique,
  cart_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(cart_snapshot) = 'array'),
  status text not null default 'guest' check (status in ('guest', 'converted')),
  consent_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  converted_user_id uuid references auth.users(id) on delete set null,
  converted_at timestamptz,
  constraint guest_visitors_fingerprint_hash_format check (fingerprint_hash is null or fingerprint_hash ~ '^[a-f0-9]{64}$')
);

create index guest_visitors_last_seen_idx on public.guest_visitors (last_seen_at desc);
create index guest_visitors_converted_user_idx on public.guest_visitors (converted_user_id) where converted_user_id is not null;

alter table public.guest_visitors enable row level security;
revoke all on table public.guest_visitors from anon, authenticated;
grant select on table public.guest_visitors to authenticated;
grant all on table public.guest_visitors to service_role;
create policy guest_visitors_platform_admin_read
  on public.guest_visitors
  for select to authenticated
  using (private.is_platform_admin());

commit;
