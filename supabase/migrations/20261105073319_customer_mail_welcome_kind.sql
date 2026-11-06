-- The customer's welcome e-mail is now sent once, when the account is created (not after every sign-in), and there is no goodbye e-mail any more.
-- customer_mail_log gets a 'welcome' kind for that single welcome: claim_customer_mail(user, 'welcome', '100 years') answers true once per account.
-- The older kinds stay allowed (rows already exist for them) but nothing sends them. A customer who already received the welcome after
-- signing in keeps that as the one welcome, so nobody is welcomed twice. Rows are only added here; none is changed or deleted.
alter table public.customer_mail_log drop constraint if exists customer_mail_log_kind_check;
alter table public.customer_mail_log add constraint customer_mail_log_kind_check check (kind in ('login', 'logout', 'registered', 'welcome'));

insert into public.customer_mail_log (user_id, kind, sent_at)
select l.user_id, 'welcome', l.sent_at from public.customer_mail_log l where l.kind = 'login'
on conflict (user_id, kind) do nothing;

create or replace function public.claim_customer_mail(p_user_id uuid, p_kind text, p_min_interval interval)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  if p_kind is null or p_kind not in ('login', 'logout', 'registered', 'welcome') then
    raise exception 'invalid_mail_kind' using errcode = '22023';
  end if;
  insert into public.customer_mail_log as l (user_id, kind, sent_at)
  values (p_user_id, p_kind, now())
  on conflict (user_id, kind) do update set sent_at = now()
    where l.sent_at <= now() - coalesce(p_min_interval, interval '0 seconds');
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $function$;
