begin;

alter table public.guest_visitors rename column consent_at to captured_at;
comment on column public.guest_visitors.captured_at is 'Timestamp when this pseudonymous visitor record was first captured.';

commit;
