begin;

-- Private evidence storage for commission payment receipts.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('commission-payment-evidence', 'commission-payment-evidence', false, 10485760,
        array['application/pdf','image/jpeg','image/png']::text[])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.commission_settlement_evidence (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.commission_settlements(id) on delete restrict,
  storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|png)$'),
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  mime_type text not null check (mime_type in ('application/pdf','image/jpeg','image/png')),
  file_size integer not null check (file_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid references public.profiles(id) on delete set null,
  uploaded_at timestamptz not null default now()
);

create index commission_settlement_evidence_settlement_idx
  on public.commission_settlement_evidence(settlement_id, uploaded_at desc);

alter table public.commission_settlement_evidence enable row level security;
revoke all on table public.commission_settlement_evidence from public, anon, authenticated;
grant select, insert on table public.commission_settlement_evidence to service_role;

-- Keep the bucket private even if an administrator later changes dashboard settings.
drop policy if exists commission_evidence_service_role_select on storage.objects;
drop policy if exists commission_evidence_service_role_insert on storage.objects;
drop policy if exists commission_evidence_service_role_delete on storage.objects;
create policy commission_evidence_service_role_select on storage.objects
  for select to service_role using (bucket_id = 'commission-payment-evidence');
create policy commission_evidence_service_role_insert on storage.objects
  for insert to service_role with check (bucket_id = 'commission-payment-evidence');
create policy commission_evidence_service_role_delete on storage.objects
  for delete to service_role using (bucket_id = 'commission-payment-evidence');

comment on table public.commission_settlement_evidence is
  'Private payment evidence metadata; objects are stored in commission-payment-evidence and served only by short-lived signed URLs.';
comment on column public.commission_settlement_evidence.file_size is
  'Maximum 10 MiB; accepted MIME types are application/pdf, image/jpeg, and image/png.';

commit;
