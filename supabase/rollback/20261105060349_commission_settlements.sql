begin;

do $check$
begin
  if exists (select 1 from public.commission_settlements limit 1) then
    raise exception 'Refusing rollback: commission settlement records exist';
  end if;
end;
$check$;

revoke all on function public.platform_request_commission_settlement(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.platform_submit_commission_settlement(uuid,text,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.platform_verify_commission_settlement(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.platform_mark_commission_settlement_paid(uuid,text,uuid) from public,anon,authenticated,service_role;
drop function if exists public.platform_request_commission_settlement(uuid,uuid);
drop function if exists public.platform_submit_commission_settlement(uuid,text,text,uuid);
drop function if exists public.platform_verify_commission_settlement(uuid,uuid);
drop function if exists public.platform_mark_commission_settlement_paid(uuid,text,uuid);

-- Restore the pre-settlement behavior only when no settlement data exists.
create or replace function public.platform_mark_commission_paid(
  p_commission_id uuid, p_payment_reference text, p_actor uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare v_comm public.commissions; v_ref text := nullif(trim(coalesce(p_payment_reference,'')), '');
begin
  if v_ref is null or char_length(v_ref)>160 then raise exception 'Payment reference is required'; end if;
  select * into v_comm from public.commissions where id=p_commission_id for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status <> 'payable' then raise exception 'Commission is not payable'; end if;
  update public.commissions set status='paid',paid_at=now(),payment_reference=v_ref,paid_by=p_actor,updated_at=now()
  where id=p_commission_id returning * into v_comm;
  insert into public.platform_audit_log(actor_id,action,target_type,target_id,details)
  values(p_actor,'commission_settled','commission',v_comm.id,jsonb_build_object('store_id',v_comm.store_id,'amount',v_comm.amount,'payment_reference',v_ref));
  return jsonb_build_object('id',v_comm.id,'status',v_comm.status,'paidAt',v_comm.paid_at,'paymentReference',v_comm.payment_reference);
end;
$function$;
revoke all on function public.platform_mark_commission_paid(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.platform_mark_commission_paid(uuid,text,uuid) to service_role;

drop trigger if exists guard_commission_paid_transition on public.commissions;
drop trigger if exists guard_commission_settlement_transition on public.commission_settlements;
drop trigger if exists commission_settlements_updated_at on public.commission_settlements;
drop function if exists private.guard_commission_paid_transition();
drop function if exists private.guard_commission_settlement_transition();
drop function if exists private.commission_settlement_touch_updated_at();
drop table if exists public.commission_settlements;
commit;
