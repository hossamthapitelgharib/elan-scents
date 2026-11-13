-- Roll back temporary mail leases and their RPCs. Keep customer_mail_log intact:
-- it is the durable idempotency/audit record and must not be deleted by rollback.
drop function if exists public.claim_customer_mail(uuid, text, uuid, interval);
drop function if exists public.complete_customer_mail(uuid, text, uuid);
drop function if exists public.release_customer_mail(uuid, text, uuid);
drop table if exists public.customer_mail_claims;
