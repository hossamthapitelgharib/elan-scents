begin;

create table if not exists public.store_integrations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null unique references public.stores(id) on delete cascade,
  enabled boolean not null default true,
  base_url text not null default '',
  cart_url text not null default '',
  api_base_url text not null default '',
  catalog_endpoint text not null default '',
  api_key text not null default '',
  webhook_secret text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_integrations_base_url_length check (char_length(base_url) <= 2048),
  constraint store_integrations_cart_url_length check (char_length(cart_url) <= 2048),
  constraint store_integrations_api_base_url_length check (char_length(api_base_url) <= 2048),
  constraint store_integrations_catalog_endpoint_length check (char_length(catalog_endpoint) <= 2048),
  constraint store_integrations_api_key_length check (char_length(api_key) <= 4096),
  constraint store_integrations_webhook_secret_length check (char_length(webhook_secret) <= 4096),
  constraint store_integrations_notes_length check (char_length(notes) <= 10000)
);

alter table public.store_integrations enable row level security;
revoke all privileges on table public.store_integrations from public, anon, authenticated;
grant all privileges on table public.store_integrations to service_role;

comment on table public.store_integrations is 'One normalized integration configuration per store. API credentials are server-only and must never be returned unmasked.';
comment on column public.store_integrations.api_key is 'Sensitive credential; access is restricted to service_role and server-side API code.';
comment on column public.store_integrations.webhook_secret is 'Sensitive credential; access is restricted to service_role and server-side API code.';

commit;
