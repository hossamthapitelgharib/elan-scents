begin;

-- A settlement is the financial record for one payable commission. The commission
-- ledger remains the source of the earned amount; this table owns payment state.
create table public.commission_settlements (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null unique references public.commissions(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'payment_requested' check (status in ('payment_requested','payment_submitted','payment_verified','paid','rejected','cancelled')),
  requested_at timestamptz not null default now(),
  requested_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz,
  submitted_by uuid references public.profiles(id) on delete set null,
  verified_at timestamptz,
  verified_by uuid references public.profiles(id) on delete set null,
  paid_at timestamptz,
  paid_by uuid references public.profiles(id) on delete set null,
  payment_reference text check (payment_reference is null or char_length(payment_reference) between 1 and 160),
  evidence_reference text check (evidence_reference is null or char_length(evidence_reference) between 1 and 200),
  failure_reason text check (failure_reason is null or char_length(failure_reason) between 1 and 400),
  notes text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commission_settlements_dates_check check (
    (submitted_at is null or submitted_at >= requested_at) and
    (verified_at is null or submitted_at is not null and verified_at >= submitted_at) and
    (paid_at is null or verified_at is not null and paid_at >= verified_at)
  ),
  constraint commission_settlements_status_fields_check check (
    (status = 'payment_requested' and submitted_at is null and verified_at is null and paid_at is null) or
    (status = 'payment_submitted' and submitted_at is not null and verified_at is null and paid_at is null) or
    (status = 'payment_verified' and submitted_at is not null and verified_at is not null and paid_at is null) or
    (status = 'paid' and submitted_at is not null and verified_at is not null and paid_at is not null and payment_reference is not null and paid_by is not null) or
    (status in ('rejected','cancelled'))
  )
);

create index commission_settlements_store_status_idx
  on public.commission_settlements(store_id, status, updated_at desc);
create index commission_settlements_status_due_idx
  on public.commission_settlements(status, updated_at desc)
  where status in ('payment_requested','payment_submitted','payment_verified');

alter table public.commission_settlements enable row level security;
revoke all on table public.commission_settlements from public, anon, authenticated;
grant select on table public.commission_settlements to service_role;

create or replace function private.commission_settlement_touch_updated_at()
returns trigger language plpgsql security invoker
set search_path to 'public','private','pg_temp' as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;
drop trigger if exists commission_settlements_updated_at on public.commission_settlements;
create trigger commission_settlements_updated_at
before update on public.commission_settlements
for each row execute function private.commission_settlement_touch_updated_at();

create or replace function private.guard_commission_settlement_transition()
returns trigger language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
begin
  if new.commission_id is distinct from old.commission_id
     or new.store_id is distinct from old.store_id
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.requested_at is distinct from old.requested_at then
    raise exception 'Settlement financial snapshot is immutable';
  end if;
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'Paid settlement cannot be reopened';
  end if;
  if old.status = 'payment_requested' and new.status not in ('payment_requested','payment_submitted','cancelled') then
    raise exception 'Invalid settlement transition';
  end if;
  if old.status = 'payment_submitted' and new.status not in ('payment_submitted','payment_verified','rejected') then
    raise exception 'Invalid settlement transition';
  end if;
  if old.status = 'payment_verified' and new.status not in ('payment_verified','paid','rejected') then
    raise exception 'Invalid settlement transition';
  end if;
  if old.status in ('rejected','cancelled') and new.status not in ('payment_requested',old.status) then
    raise exception 'Invalid settlement transition';
  end if;
  return new;
end;
$function$;
drop trigger if exists guard_commission_settlement_transition on public.commission_settlements;
create trigger guard_commission_settlement_transition
before update on public.commission_settlements
for each row execute function private.guard_commission_settlement_transition();

create or replace function private.guard_commission_paid_transition()
returns trigger language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
begin
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'Paid commission cannot be reopened';
  end if;
  if new.status = 'paid' and old.status <> 'paid' then
    if not exists (
      select 1 from public.commission_settlements s
      where s.commission_id = new.id and s.status = 'paid'
    ) then
      raise exception 'Commission requires a paid settlement';
    end if;
    if new.paid_at is null or nullif(trim(new.payment_reference), '') is null or new.paid_by is null then
      raise exception 'Paid commission requires payment metadata';
    end if;
  end if;
  return new;
end;
$function$;
drop trigger if exists guard_commission_paid_transition on public.commissions;
create trigger guard_commission_paid_transition
before update of status on public.commissions
for each row execute function private.guard_commission_paid_transition();

create or replace function public.platform_request_commission_settlement(
  p_commission_id uuid, p_actor uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare
  v_comm public.commissions;
  v_settlement public.commission_settlements;
begin
  select * into v_comm from public.commissions where id = p_commission_id for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status <> 'payable' then raise exception 'Commission is not payable'; end if;

  select * into v_settlement from public.commission_settlements where commission_id = p_commission_id for update;
  if found then
    if v_settlement.status = 'paid' then
      return jsonb_build_object('id',v_settlement.id,'commissionId',v_comm.id,'status',v_settlement.status,'duplicate',true);
    end if;
    if v_settlement.status not in ('rejected','cancelled') then
      return jsonb_build_object('id',v_settlement.id,'commissionId',v_comm.id,'status',v_settlement.status,'duplicate',true);
    end if;
    update public.commission_settlements
    set store_id=v_comm.store_id, amount=v_comm.amount, currency=v_comm.currency,
        status='payment_requested', requested_at=now(), requested_by=p_actor,
        submitted_at=null, submitted_by=null, verified_at=null, verified_by=null,
        paid_at=null, paid_by=null, payment_reference=null, evidence_reference=null,
        failure_reason=null
    where id=v_settlement.id returning * into v_settlement;
  else
    insert into public.commission_settlements(commission_id,store_id,amount,currency,requested_by)
    values(v_comm.id,v_comm.store_id,v_comm.amount,v_comm.currency,p_actor)
    returning * into v_settlement;
  end if;

  insert into public.platform_audit_log(actor_id,action,target_type,target_id,details)
  values(p_actor,'commission_settlement_requested','commission_settlement',v_settlement.id,
         jsonb_build_object('commission_id',v_comm.id,'store_id',v_comm.store_id,'amount',v_comm.amount,'currency',v_comm.currency));
  return jsonb_build_object('id',v_settlement.id,'commissionId',v_comm.id,'status',v_settlement.status,'amount',v_settlement.amount,'currency',v_settlement.currency,'duplicate',false);
end;
$function$;

create or replace function public.platform_submit_commission_settlement(
  p_settlement_id uuid, p_payment_reference text, p_evidence_reference text default null, p_actor uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare v_settlement public.commission_settlements; v_ref text := nullif(trim(coalesce(p_payment_reference,'')), ''); v_evidence text := nullif(trim(coalesce(p_evidence_reference,'')), '');
begin
  if v_ref is null or char_length(v_ref)>160 then raise exception 'Payment reference is required'; end if;
  select * into v_settlement from public.commission_settlements where id=p_settlement_id for update;
  if not found then raise exception 'Settlement not found'; end if;
  if v_settlement.status = 'payment_submitted' and v_settlement.payment_reference=v_ref then
    return jsonb_build_object('id',v_settlement.id,'status',v_settlement.status,'duplicate',true);
  end if;
  if v_settlement.status <> 'payment_requested' then raise exception 'Settlement is not awaiting submission'; end if;
  update public.commission_settlements
  set status='payment_submitted', submitted_at=now(), submitted_by=p_actor,
      payment_reference=v_ref, evidence_reference=v_evidence, failure_reason=null
  where id=p_settlement_id returning * into v_settlement;
  insert into public.platform_audit_log(actor_id,action,target_type,target_id,details)
  values(p_actor,'commission_settlement_submitted','commission_settlement',v_settlement.id,
         jsonb_build_object('commission_id',v_settlement.commission_id,'payment_reference',v_ref,'evidence_reference',v_evidence));
  return jsonb_build_object('id',v_settlement.id,'commissionId',v_settlement.commission_id,'status',v_settlement.status,'paymentReference',v_settlement.payment_reference,'evidenceReference',v_settlement.evidence_reference,'duplicate',false);
end;
$function$;

create or replace function public.platform_verify_commission_settlement(
  p_settlement_id uuid, p_actor uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare v_settlement public.commission_settlements;
begin
  select * into v_settlement from public.commission_settlements where id=p_settlement_id for update;
  if not found then raise exception 'Settlement not found'; end if;
  if v_settlement.status = 'payment_verified' then
    return jsonb_build_object('id',v_settlement.id,'status',v_settlement.status,'duplicate',true);
  end if;
  if v_settlement.status <> 'payment_submitted' then raise exception 'Settlement is not submitted'; end if;
  if nullif(trim(coalesce(v_settlement.payment_reference,'')),'') is null or nullif(trim(coalesce(v_settlement.evidence_reference,'')),'') is null then
    raise exception 'Settlement evidence is required';
  end if;
  update public.commission_settlements
  set status='payment_verified', verified_at=now(), verified_by=p_actor
  where id=p_settlement_id returning * into v_settlement;
  insert into public.platform_audit_log(actor_id,action,target_type,target_id,details)
  values(p_actor,'commission_settlement_verified','commission_settlement',v_settlement.id,
         jsonb_build_object('commission_id',v_settlement.commission_id,'payment_reference',v_settlement.payment_reference,'evidence_reference',v_settlement.evidence_reference));
  return jsonb_build_object('id',v_settlement.id,'commissionId',v_settlement.commission_id,'status',v_settlement.status,'duplicate',false);
end;
$function$;

create or replace function public.platform_mark_commission_settlement_paid(
  p_settlement_id uuid, p_payment_reference text default null, p_actor uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare v_settlement public.commission_settlements; v_comm public.commissions; v_ref text := nullif(trim(coalesce(p_payment_reference,'')), '');
begin
  select * into v_settlement from public.commission_settlements where id=p_settlement_id for update;
  if not found then raise exception 'Settlement not found'; end if;
  if v_settlement.status = 'paid' then
    return jsonb_build_object('id',v_settlement.id,'commissionId',v_settlement.commission_id,'status',v_settlement.status,'paymentReference',v_settlement.payment_reference,'duplicate',true);
  end if;
  if v_settlement.status <> 'payment_verified' then raise exception 'Settlement is not verified'; end if;
  v_ref := coalesce(v_ref, v_settlement.payment_reference);
  if v_ref is null or char_length(v_ref)>160 then raise exception 'Payment reference is required'; end if;
  select * into v_comm from public.commissions where id=v_settlement.commission_id for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status <> 'payable' then raise exception 'Commission is not payable'; end if;
  update public.commission_settlements
  set status='paid', paid_at=now(), paid_by=p_actor, payment_reference=v_ref
  where id=p_settlement_id returning * into v_settlement;
  update public.commissions
  set status='paid', paid_at=v_settlement.paid_at, payment_reference=v_ref, paid_by=p_actor, updated_at=now()
  where id=v_comm.id;
  insert into public.platform_audit_log(actor_id,action,target_type,target_id,details)
  values(p_actor,'commission_settled','commission_settlement',v_settlement.id,
         jsonb_build_object('commission_id',v_comm.id,'store_id',v_comm.store_id,'amount',v_comm.amount,'payment_reference',v_ref,'evidence_reference',v_settlement.evidence_reference));
  return jsonb_build_object('id',v_settlement.id,'commissionId',v_comm.id,'status',v_settlement.status,'paidAt',v_settlement.paid_at,'paymentReference',v_ref,'duplicate',false);
end;
$function$;

-- Preserve the existing API contract, but make it a finalization step only after
-- a settlement has been submitted and independently verified.
create or replace function public.platform_mark_commission_paid(
  p_commission_id uuid, p_payment_reference text, p_actor uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare v_comm public.commissions; v_settlement_id uuid;
begin
  select * into v_comm from public.commissions where id=p_commission_id for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status <> 'payable' then raise exception 'Commission is not payable'; end if;
  select id into v_settlement_id from public.commission_settlements where commission_id=p_commission_id;
  if v_settlement_id is null then raise exception 'Commission settlement is not verified'; end if;
  return public.platform_mark_commission_settlement_paid(v_settlement_id,p_payment_reference,p_actor);
end;
$function$;

revoke all on function private.commission_settlement_touch_updated_at() from public,anon,authenticated;
revoke all on function private.guard_commission_settlement_transition() from public,anon,authenticated;
revoke all on function private.guard_commission_paid_transition() from public,anon,authenticated;
revoke all on function public.platform_request_commission_settlement(uuid,uuid) from public,anon,authenticated;
revoke all on function public.platform_submit_commission_settlement(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.platform_verify_commission_settlement(uuid,uuid) from public,anon,authenticated;
revoke all on function public.platform_mark_commission_settlement_paid(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.platform_mark_commission_paid(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.platform_request_commission_settlement(uuid,uuid) to service_role;
grant execute on function public.platform_submit_commission_settlement(uuid,text,text,uuid) to service_role;
grant execute on function public.platform_verify_commission_settlement(uuid,uuid) to service_role;
grant execute on function public.platform_mark_commission_settlement_paid(uuid,text,uuid) to service_role;
grant execute on function public.platform_mark_commission_paid(uuid,text,uuid) to service_role;

comment on table public.commission_settlements is 'Financial settlement workflow for public.commissions; payable eligibility remains on commissions, payment state lives here.';
comment on column public.commission_settlements.amount is 'Immutable-at-creation payable commission snapshot; changes require a new commission, not silent settlement mutation.';
comment on column public.commission_settlements.evidence_reference is 'External proof reference required before payment verification.';

commit;
