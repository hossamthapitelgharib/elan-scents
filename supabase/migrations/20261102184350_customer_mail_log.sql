-- Service e-mails to customers (welcome after sign-in, goodbye after sign-out) and the notice to the platform mailbox when an account is
-- confirmed are sent by the Worker (api/customer-mail.js) through the shop's own mailbox. This table is the memory that keeps them from
-- repeating: one row per (customer, kind) holding when it was last sent. claim_customer_mail() takes the slot and answers true only
-- when the previous send is older than the interval, in one atomic statement, so two tabs or two Worker instances cannot both send.
-- release_customer_mail() hands the slot back when the send itself failed. Only the server (service_role) can touch either.
-- Nothing deletes these rows on a schedule (a registered customer's data is never purged automatically); they go with the account.
create table if not exists public.customer_mail_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('login', 'logout', 'registered')),
  sent_at timestamptz not null default now(),
  primary key (user_id, kind)
);
alter table public.customer_mail_log enable row level security;
revoke all on public.customer_mail_log from public, anon, authenticated;
grant select, insert, update, delete on public.customer_mail_log to service_role;

create or replace function public.claim_customer_mail(p_user_id uuid, p_kind text, p_min_interval interval)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  if p_kind is null or p_kind not in ('login', 'logout', 'registered') then
    raise exception 'invalid_mail_kind' using errcode = '22023';
  end if;
  insert into public.customer_mail_log as l (user_id, kind, sent_at)
  values (p_user_id, p_kind, now())
  on conflict (user_id, kind) do update set sent_at = now()
    where l.sent_at <= now() - coalesce(p_min_interval, interval '0 seconds');
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $function$;

create or replace function public.release_customer_mail(p_user_id uuid, p_kind text)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  delete from public.customer_mail_log where user_id = p_user_id and kind = p_kind;
$function$;

revoke all on function public.claim_customer_mail(uuid, text, interval) from public, anon, authenticated;
revoke all on function public.release_customer_mail(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_customer_mail(uuid, text, interval) to service_role;
grant execute on function public.release_customer_mail(uuid, text) to service_role;
