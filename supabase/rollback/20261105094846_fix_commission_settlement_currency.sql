begin;

-- Emergency rollback to the prior function definition from
-- 20261105060349_commission_settlements.sql. This restores the known currency
-- lookup defect; apply only as part of a coordinated rollback of the settlement feature.
create or replace function public.platform_request_commission_settlement(
  p_commission_id uuid, p_actor uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare v_comm public.commissions; v_settlement public.commission_settlements;
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
         jsonb_build_object('commission_id',v_comm.id,'store_id',v_comm.store_id,
                            'amount',v_comm.amount,'currency',v_comm.currency));
  return jsonb_build_object('id',v_settlement.id,'commissionId',v_comm.id,
                            'status',v_settlement.status,'amount',v_settlement.amount,
                            'currency',v_settlement.currency,'duplicate',false);
end;
$function$;

revoke all on function public.platform_request_commission_settlement(uuid,uuid) from public,anon,authenticated;
grant execute on function public.platform_request_commission_settlement(uuid,uuid) to service_role;

commit;
