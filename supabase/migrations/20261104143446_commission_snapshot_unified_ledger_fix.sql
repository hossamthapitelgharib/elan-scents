begin;

-- The unified ledger migration is already deployed. Re-define its accrual function
-- after the order-rate snapshot migration so existing orders keep their original
-- rate while new orders can use future commercial agreements.
create or replace function private.accrue_store_order_commission(
  p_request_id uuid, p_evidence text, p_review boolean, p_reason text default null)
returns void language plpgsql security definer
set search_path to 'public','private','pg_temp' as $function$
declare
  v_req public.store_order_requests;
  v_rate numeric(5,2);
  v_return_days integer;
  v_items jsonb;
begin
  select * into v_req from public.store_order_requests where id=p_request_id for update;
  if not found or v_req.reconciliation_status<>'matched' or v_req.status not in ('completed','shipped','delivered')
    or lower(coalesce(v_req.latest_store_payload->>'status','')) not in ('completed','success','succeeded','paid','confirmed') then return; end if;
  v_items:=coalesce(v_req.latest_store_payload->'items','[]'::jsonb);
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items)=0
    or jsonb_array_length(v_items)<>(select count(*) from public.store_order_request_items i where i.request_id=v_req.id)
    or exists(select 1 from public.store_order_request_items i where i.request_id=v_req.id and not exists(
      select 1 from jsonb_array_elements(v_items) j where j->>'platformOrderNumber'=i.platform_order_number
      and (j->>'quantity')::integer=i.quantity and (j->>'unitPrice')::numeric=i.unit_price
      and (j->>'total')::numeric=i.line_total and coalesce(j->>'currency','EGP')=i.currency)) then return; end if;
  if nullif(trim(coalesce(v_req.latest_store_payload->>'storeOrderReference','')),'') is null and exists(
      select 1 from jsonb_array_elements(v_items) j where nullif(trim(coalesce(j->>'merchantOrderReference','')),'') is null) then return; end if;

  -- Never read the current store rate for an existing order. The request snapshot
  -- is authoritative and excludes shipping because amounts use item line_total.
  v_rate := v_req.commission_rate;
  select return_window_days into v_return_days from public.stores where id=v_req.store_id;
  if v_rate is null or v_return_days is null then return; end if;

  update public.store_order_request_items i set merchant_order_reference=nullif(trim(j->>'merchantOrderReference'),'')
    from jsonb_array_elements(v_items) j where i.request_id=v_req.id and j->>'platformOrderNumber'=i.platform_order_number;
  insert into public.commissions(store_id,order_item_id,store_order_request_item_id,rate,amount,status,return_window_days,return_deadline_at)
  select v_req.store_id,null,i.id,v_rate,
    round(greatest(i.line_total-least(i.line_total,coalesce(adj.returned_amount,0)),0)*v_rate/100,2),'pending',v_return_days,
    case when sh.delivery_verified_at is not null and v_return_days is not null then sh.delivered_at+make_interval(days=>v_return_days) else null end
  from public.store_order_request_items i
  left join lateral(select sum(case when a.quantity>0 then least(a.quantity,i.quantity)*i.unit_price else a.amount end) returned_amount
    from public.store_order_item_adjustments a where a.request_item_id=i.id and a.status='completed') adj on true
  left join public.store_shipments sh on sh.request_id=v_req.id
  where i.request_id=v_req.id and round(greatest(i.line_total-least(i.line_total,coalesce(adj.returned_amount,0)),0)*v_rate/100,2)>0
  on conflict(store_order_request_item_id) where store_order_request_item_id is not null do nothing;
end;$function$;

revoke all on function private.accrue_store_order_commission(uuid, text, boolean, text) from public, anon, authenticated;

commit;
