begin;

-- Customer cancellation requests (owner decision of 2026-10-26): while an order is still waiting for the store to
-- confirm it, the customer can ask to cancel it. This is a REQUEST: nothing is cancelled automatically, the order keeps
-- its status, and the store decides with the actions it already has (reject, or confirm and so decline the request).
--
--   * public.store_order_cancellation_requests: one row per order (the primary key is the order), server-only like the
--     other order tables (RLS on, no client privilege): the customer page reads it through /api/customer-orders and the
--     store dashboard through /api/store-dashboard-orders, both with the service role.
--   * public.request_store_order_cancellation(order id, reason): callable by a signed-in customer for HIS OWN order, and
--     only while the order status is awaiting_store_confirmation. It locks the order row, so it cannot interleave with
--     the store's confirm/reject of the same order. A repeated call returns the existing request. It notifies the
--     customer, the platform admins and the store's accounts through the existing emit_order_notification.
-- The state shown to the customer (pending, accepted, declined) is derived from the order status, so nothing has to be
-- kept in step: waiting = request exists and the order still awaits the store; accepted = the store rejected or
-- cancelled it; declined = the store went on (confirmed, processing, ...).

create table public.store_order_cancellation_requests (
  request_id uuid primary key references public.store_order_requests (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now()
);
create index store_order_cancellation_requests_user_idx on public.store_order_cancellation_requests (user_id, created_at desc);
alter table public.store_order_cancellation_requests enable row level security;
revoke all on table public.store_order_cancellation_requests from public, anon, authenticated;
grant all on table public.store_order_cancellation_requests to service_role;

create or replace function public.request_store_order_cancellation(p_request_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_request public.store_order_requests;
  v_row public.store_order_cancellation_requests;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'Reason is too long';
  end if;

  -- The customer's own order, locked so that the store's confirm or reject of the same order waits for this call.
  select * into v_request
  from public.store_order_requests r
  where r.id = p_request_id and r.user_id = v_user_id
  for update;
  if not found then
    raise exception 'Order not found';
  end if;

  select * into v_row from public.store_order_cancellation_requests c where c.request_id = v_request.id;
  if found then
    return jsonb_build_object('requestId', v_request.id, 'trackingNumber', v_request.tracking_number,
                              'createdAt', v_row.created_at, 'duplicate', true);
  end if;

  if v_request.status <> 'awaiting_store_confirmation' then
    raise exception 'Order is no longer waiting for the store';
  end if;

  insert into public.store_order_cancellation_requests (request_id, user_id, reason)
  values (v_request.id, v_user_id, v_reason)
  returning * into v_row;

  perform public.emit_order_notification(
    v_request, 'customer_cancel_requested', 'طلب إلغاء الطلب',
    'طلب العميل إلغاء هذا الطلب قبل تأكيد المتجر، وهو بانتظار رد المتجر.',
    jsonb_build_object('status', v_request.status, 'reason', v_reason));

  return jsonb_build_object('requestId', v_request.id, 'trackingNumber', v_request.tracking_number,
                            'createdAt', v_row.created_at, 'duplicate', false);
end;
$function$;

revoke all on function public.request_store_order_cancellation(uuid, text) from public, anon;
grant execute on function public.request_store_order_cancellation(uuid, text) to authenticated, service_role;

commit;
