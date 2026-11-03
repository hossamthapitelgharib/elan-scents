-- Rolls back migrations/20261102184350_customer_mail_log.sql.
-- Removes the memory the customer e-mails use to avoid repeating (api/customer-mail.js). With it gone the endpoint answers 502 and no
-- e-mail is sent until the migration is applied again; nothing else depends on it. The rows only record «when was this mail last sent»,
-- so losing them means at worst one extra welcome or goodbye mail per customer after it is re-applied.
begin;

drop function if exists public.release_customer_mail(uuid, text);
drop function if exists public.claim_customer_mail(uuid, text, interval);
drop table if exists public.customer_mail_log;

commit;
