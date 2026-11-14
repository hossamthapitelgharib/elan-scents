-- Fix (review of the orders page, 2026-11-13, finding 3): choosing a payment method again with the SAME retry key answered with the old attempt.
--
-- The page keeps one retry key per (order, method) for as long as it is open. select_order_payment_server looked the key up before looking at
-- anything else, so after a failed or cancelled attempt the same key returned that dead attempt: the customer was sent to the payment page
-- while the order still said «failed», and choosing card, then another method, then card again recorded the first method on the order.
--
-- Now an attempt that is still alive (initiated, paid, cod_selected) is answered as before (a double tap is the same choice), but a failed or
-- cancelled attempt under that key opens a NEW attempt with its own internal key (<key>:r<n>), cancelling any other open attempt and
-- recording the method that was just chosen.
begin;

create or replace function public.select_order_payment_server(p_request_id uuid, p_user_id uuid, p_method_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path to 'public', 'private', 'pg_temp' as $$
declare v_req public.store_order_requests; v_opt jsonb; v_pay public.order_payments; v_key text; v_kind text; v_n integer;
begin
  if p_user_id is null then raise exception 'Authentication required' using errcode = 'P0001'; end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'Invalid retry key' using errcode = 'P0001'; end if;
  select * into v_req from public.store_order_requests where id = p_request_id for update;
  if not found or v_req.user_id is distinct from p_user_id then raise exception 'Order not found' using errcode = 'P0001'; end if;
  v_key := p_request_id::text || ':' || p_idempotency_key;
  -- the latest attempt made under this key (the key itself, then its retries <key>:r2, <key>:r3 …)
  select * into v_pay from public.order_payments where idempotency_key = v_key or idempotency_key like v_key || ':r%' order by created_at desc, idempotency_key desc limit 1;
  if found and v_pay.status in ('initiated', 'paid', 'cod_selected') then return private.payment_instructions(v_pay, v_req); end if;
  if v_req.status <> 'store_confirmed' or v_req.approved_at is null then raise exception 'Order is not approved for payment' using errcode = 'P0001'; end if;
  if private.payment_executed(v_req.payment_status) then raise exception 'Payment is already settled' using errcode = 'P0001'; end if;
  if v_req.currency is distinct from 'EGP' then raise exception 'Only EGP orders are supported' using errcode = 'P0001'; end if;
  if v_req.payable_amount is null or v_req.payable_amount <= 0 then raise exception 'Order has no payable amount' using errcode = 'P0001'; end if;
  select o into v_opt from jsonb_array_elements(coalesce(v_req.payment_options, '[]'::jsonb)) o where o->>'id' = p_method_id::text;
  if v_opt is null then raise exception 'Payment method is not offered for this order' using errcode = 'P0001'; end if;
  v_kind := v_opt->>'kind';

  -- a key that already had a dead attempt gets the next internal key, so a retry is a real new attempt
  select count(*) into v_n from public.order_payments where idempotency_key = v_key or idempotency_key like v_key || ':r%';
  if v_n > 0 then v_key := v_key || ':r' || (v_n + 1); end if;

  update public.order_payments set status = 'cancelled', updated_at = now() where request_id = p_request_id and status = 'initiated';
  insert into public.order_payments (request_id, store_id, user_id, method_kind, mode, provider, status, amount, currency, idempotency_key, paid_at)
  values (v_req.id, v_req.store_id, p_user_id, v_kind, v_opt->>'mode', coalesce(v_opt->>'provider', 'merchant'),
          case when v_kind = 'cod' then 'cod_selected' else 'initiated' end, v_req.payable_amount, 'EGP', v_key, null)
  returning * into v_pay;

  perform set_config('elan.pay_write', 'on', true);
  update public.store_order_requests set payment_status = case when v_kind = 'cod' then 'cod_selected' else 'awaiting_payment' end,
         payment_method = v_kind, payment_provider = v_pay.provider, updated_at = now() where id = v_req.id;
  perform set_config('elan.pay_write', 'off', true);
  if v_kind = 'cod' then perform private.finalize_payment(v_req.id); end if;
  select * into v_req from public.store_order_requests where id = v_req.id;
  return private.payment_instructions(v_pay, v_req);
end; $$;

revoke all on function public.select_order_payment_server(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.select_order_payment_server(uuid, uuid, uuid, text) to service_role;

commit;
