-- Rollback for 20261105073319_customer_mail_welcome_kind.sql.
-- The welcome rows go (they only exist for the single welcome mail); the function and the check go back to the three older kinds.
delete from public.customer_mail_log where kind = 'welcome';
alter table public.customer_mail_log drop constraint if exists customer_mail_log_kind_check;
alter table public.customer_mail_log add constraint customer_mail_log_kind_check check (kind in ('login', 'logout', 'registered'));

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
