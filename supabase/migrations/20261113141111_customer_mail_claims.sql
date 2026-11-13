-- Customer-mail leases are separate from the durable sent log: a claim never records
-- delivery. A successful SMTP send is recorded only by complete_customer_mail().
create table if not exists public.customer_mail_claims (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('login', 'logout', 'registered', 'welcome')),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (user_id, kind)
);

alter table public.customer_mail_claims enable row level security;
revoke all on public.customer_mail_claims from public, anon, authenticated;
grant select, insert, update, delete on public.customer_mail_claims to service_role;

create or replace function public.claim_customer_mail(
  p_user_id uuid,
  p_kind text,
  p_claim_token uuid,
  p_lease interval
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_claim_token is null
     or p_kind is null or p_kind not in ('login', 'logout', 'registered', 'welcome') then
    raise exception 'invalid_mail_claim' using errcode = '22023';
  end if;
  if p_lease is null or p_lease < interval '1 second' or p_lease > interval '15 minutes' then
    raise exception 'invalid_mail_lease' using errcode = '22023';
  end if;
  if exists (select 1 from public.customer_mail_log l where l.user_id = p_user_id and l.kind = p_kind) then
    return false;
  end if;

  insert into public.customer_mail_claims as c
    (user_id, kind, claim_token, lease_expires_at, completed_at, created_at)
  values (p_user_id, p_kind, p_claim_token, v_now + p_lease, null, v_now)
  on conflict (user_id, kind) do update
    set claim_token = excluded.claim_token,
        lease_expires_at = excluded.lease_expires_at,
        completed_at = null,
        created_at = excluded.created_at
    where c.completed_at is null
      and c.lease_expires_at <= v_now
      and not exists (
        select 1 from public.customer_mail_log l
        where l.user_id = excluded.user_id and l.kind = excluded.kind
      );
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end
$function$;

create or replace function public.complete_customer_mail(
  p_user_id uuid,
  p_kind text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  if p_user_id is null or p_claim_token is null
     or p_kind is null or p_kind not in ('login', 'logout', 'registered', 'welcome') then
    raise exception 'invalid_mail_claim' using errcode = '22023';
  end if;
  if exists (select 1 from public.customer_mail_log l where l.user_id = p_user_id and l.kind = p_kind) then
    return false;
  end if;

  update public.customer_mail_claims c
    set completed_at = clock_timestamp()
    where c.user_id = p_user_id and c.kind = p_kind
      and c.claim_token = p_claim_token
      and c.completed_at is null
      and c.lease_expires_at > clock_timestamp();
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return false; end if;

  insert into public.customer_mail_log (user_id, kind, sent_at)
    values (p_user_id, p_kind, clock_timestamp());
  return true;
end
$function$;

create or replace function public.release_customer_mail(
  p_user_id uuid,
  p_kind text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_rows integer;
begin
  if p_user_id is null or p_claim_token is null
     or p_kind is null or p_kind not in ('login', 'logout', 'registered', 'welcome') then
    raise exception 'invalid_mail_claim' using errcode = '22023';
  end if;
  delete from public.customer_mail_claims c
    where c.user_id = p_user_id and c.kind = p_kind
      and c.claim_token = p_claim_token and c.completed_at is null;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end
$function$;

revoke all on function public.claim_customer_mail(uuid, text, uuid, interval) from public, anon, authenticated;
revoke all on function public.complete_customer_mail(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.release_customer_mail(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_customer_mail(uuid, text, uuid, interval) to service_role;
grant execute on function public.complete_customer_mail(uuid, text, uuid) to service_role;
grant execute on function public.release_customer_mail(uuid, text, uuid) to service_role;
