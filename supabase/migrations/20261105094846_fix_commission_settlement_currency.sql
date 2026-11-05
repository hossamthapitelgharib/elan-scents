begin;

-- public.commissions has no currency column. Store-order lines do, so snapshot
-- settlement currency from the linked line. Legacy order_items/orders have no
-- currency field and the existing platform checkout currency is EGP.
create or replace function public.platform_request_commission_settlement(
  p_commission_id uuid, p_actor uuid default null)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare
  v_comm public.commissions;
  v_settlement public.commission_settlements;
  v_currency text := 'EGP';
begin
  select * into v_comm from public.commissions where id = p_commission_id for update;
  if not found then raise exception 'Commission not found'; end if;
  if v_comm.status <> 'payable' then raise exception 'Commission is not payable'; end if;

  if v_comm.store_order_request_item_id is not null then
    select upper(coalesce(nullif(trim(i.currency),''), nullif(trim(r.currency),''), 'EGP'))
      into v_currency
    from public.store_order_request_items i
    join public.store_order_requests r on r.id = i.request_id
    where i.id = v_comm.store_order_request_item_id;
    if not found then raise exception 'Commission line currency source not found'; end if;
  end if;
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'Invalid commission currency'; end if;

  select * into v_settlement
  from public.commission_settlements
  where commission_id = p_commission_id
  for update;
  if found then
    if v_settlement.status = 'paid' then
      return jsonb_build_object('id',v_settlement.id,'commissionId',v_comm.id,'status',v_settlement.status,'duplicate',true);
    end if;
    if v_settlement.status not in ('rejected','cancelled') then
      return jsonb_build_object('id',v_settlement.id,'commissionId',v_comm.id,'status',v_settlement.status,'duplicate',true);
    end if;
    update public.commission_settlements
    set store_id=v_comm.store_id, amount=v_comm.amount, currency=v_currency,
        status='payment_requested', requested_at=now(), requested_by=p_actor,
        submitted_at=null, submitted_by=null, verified_at=null, verified_by=null,
        paid_at=null, paid_by=null, payment_reference=null, evidence_reference=null,
        failure_reason=null
    where id=v_settlement.id returning * into v_settlement;
  else
    insert into public.commission_settlements(commission_id,store_id,amount,currency,requested_by)
    values(v_comm.id,v_comm.store_id,v_comm.amount,v_currency,p_actor)
    returning * into v_settlement;
  end if;

  insert into public.platform_audit_log(actor_id,action,target_type,target_id,details)
  values(p_actor,'commission_settlement_requested','commission_settlement',v_settlement.id,
         jsonb_build_object('commission_id',v_comm.id,'store_id',v_comm.store_id,
                            'amount',v_comm.amount,'currency',v_currency));
  return jsonb_build_object('id',v_settlement.id,'commissionId',v_comm.id,
                            'status',v_settlement.status,'amount',v_settlement.amount,
                            'currency',v_settlement.currency,'duplicate',false);
end;
$function$;

revoke all on function public.platform_request_commission_settlement(uuid,uuid) from public,anon,authenticated;
grant execute on function public.platform_request_commission_settlement(uuid,uuid) to service_role;

comment on function public.platform_request_commission_settlement(uuid,uuid) is
  'Creates a settlement using the linked store-order line currency; legacy commissions default to EGP because legacy orders have no currency field.';

commit;
