begin;

-- Initial platform policy: 15% of merchandise only. Shipping is deliberately excluded.
-- The per-store column remains configurable for a future signed commercial agreement,
-- but every order snapshots the rate that applied when the order was created.
alter table public.stores
  alter column commission_rate set default 15.00;

-- No store has a signed commercial agreement yet; normalize the existing catalog
-- rows to the initial policy instead of relying on the column default (which only
-- affects future inserts).
update public.stores
set commission_rate = 15.00
where commission_rate is distinct from 15.00;

alter table public.store_order_requests
  add column if not exists commission_rate numeric(5,2) not null default 15.00
    check (commission_rate >= 0 and commission_rate <= 100);

create or replace function private.snapshot_store_commission_rate()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_rate numeric(5,2);
begin
  select coalesce(s.commission_rate, 15.00) into v_rate
  from public.stores s where s.id = new.store_id;
  new.commission_rate := coalesce(v_rate, 15.00);
  return new;
end;
$function$;

revoke all on function private.snapshot_store_commission_rate() from public, anon, authenticated;
drop trigger if exists snapshot_store_commission_rate on public.store_order_requests;
create trigger snapshot_store_commission_rate
before insert on public.store_order_requests
for each row execute function private.snapshot_store_commission_rate();

create or replace function private.protect_order_commission_rate()
returns trigger
language plpgsql
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if new.commission_rate is distinct from old.commission_rate then
    raise exception 'The order commission rate is immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

revoke all on function private.protect_order_commission_rate() from public, anon, authenticated;
drop trigger if exists protect_order_commission_rate on public.store_order_requests;
create trigger protect_order_commission_rate
before update on public.store_order_requests
for each row execute function private.protect_order_commission_rate();

-- Rebuild the accrual function so a later store-rate edit cannot rewrite an old order's economics.
create or replace function private.accrue_store_order_commission(
  p_request_id uuid, p_evidence text, p_review boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_req public.store_order_requests;
  v_gross numeric;
  v_returned numeric;
begin
  select * into v_req from public.store_order_requests where id = p_request_id for update;
  if not found then return; end if;
  select a.gross, a.returned into v_gross, v_returned
  from private.commission_amounts(p_request_id) a;

  -- commission_amounts sums immutable product line totals. Shipping is never included.
  insert into public.store_order_commissions
    (request_id, store_id, rate, gross_amount, returned_amount, commission_amount,
     currency, evidence, review_required, review_reason)
  values
    (p_request_id, v_req.store_id, v_req.commission_rate, v_gross, v_returned,
     round(greatest(v_gross - v_returned, 0) * v_req.commission_rate / 100, 2),
     v_req.currency, p_evidence, coalesce(p_review, false),
     case when coalesce(p_review, false) then left(p_reason, 200) end)
  on conflict (request_id) do update
    set review_required = public.store_order_commissions.review_required or excluded.review_required,
        review_reason = coalesce(public.store_order_commissions.review_reason, excluded.review_reason),
        updated_at = now()
    where public.store_order_commissions.status = 'accrued';
end;
$function$;

revoke all on function private.accrue_store_order_commission(uuid, text, boolean, text) from public, anon, authenticated;

comment on column public.store_order_requests.commission_rate is
  'Immutable-at-creation commercial rate snapshot. Initial policy is 15% of merchandise subtotal, excluding shipping.';

commit;
