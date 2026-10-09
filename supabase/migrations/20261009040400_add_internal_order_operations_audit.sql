begin;

create table if not exists public.order_operation_events (
  id uuid primary key default gen_random_uuid(),
  checkout_session_id uuid references public.checkout_sessions(id) on delete set null,
  request_id uuid references public.store_order_requests(id) on delete set null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  actor_role text not null default 'system',
  event_type text not null,
  source text not null default 'system',
  before_state jsonb,
  after_state jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.order_reconciliation_checks (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.store_order_requests(id) on delete cascade,
  notification_id uuid references public.store_order_notifications(id) on delete set null,
  tracking_number text not null,
  event_type text not null,
  initial_payload jsonb not null default '{}'::jsonb,
  store_payload jsonb not null default '{}'::jsonb,
  mismatch_fields jsonb not null default '[]'::jsonb,
  match_status text not null default 'pending' check (match_status in ('pending','matched','mismatched')),
  checked_at timestamptz not null default now()
);

create index if not exists order_operation_events_session_idx on public.order_operation_events(checkout_session_id,created_at desc);
create index if not exists order_operation_events_request_idx on public.order_operation_events(request_id,created_at desc);
create index if not exists order_operation_events_type_idx on public.order_operation_events(event_type,created_at desc);
create index if not exists order_reconciliation_checks_request_idx on public.order_reconciliation_checks(request_id,checked_at desc);
create index if not exists order_reconciliation_checks_tracking_idx on public.order_reconciliation_checks(tracking_number,checked_at desc);

alter table public.order_operation_events enable row level security;
alter table public.order_reconciliation_checks enable row level security;

drop policy if exists order_operation_events_platform_read on public.order_operation_events;
create policy order_operation_events_platform_read on public.order_operation_events for select to authenticated using (private.is_platform_admin());
drop policy if exists order_operation_events_store_read on public.order_operation_events;
create policy order_operation_events_store_read on public.order_operation_events for select to authenticated using (exists (select 1 from public.store_order_requests r where r.id=order_operation_events.request_id and private.is_store_member(r.store_id)));
drop policy if exists order_reconciliation_checks_platform_read on public.order_reconciliation_checks;
create policy order_reconciliation_checks_platform_read on public.order_reconciliation_checks for select to authenticated using (private.is_platform_admin());
drop policy if exists order_reconciliation_checks_store_read on public.order_reconciliation_checks;
create policy order_reconciliation_checks_store_read on public.order_reconciliation_checks for select to authenticated using (exists (select 1 from public.store_order_requests r where r.id=order_reconciliation_checks.request_id and private.is_store_member(r.store_id)));

revoke insert,update,delete on public.order_operation_events from anon,authenticated;
revoke insert,update,delete on public.order_reconciliation_checks from anon,authenticated;
grant select on public.order_operation_events, public.order_reconciliation_checks to authenticated;

create or replace function public.audit_store_order_request_change() returns trigger
language plpgsql security definer set search_path=public,private as $$
begin
  insert into public.order_operation_events(checkout_session_id,request_id,actor_user_id,actor_role,event_type,source,before_state,after_state,payload)
  values (
    coalesce(new.checkout_session_id,old.checkout_session_id), new.id,
    auth.uid(), coalesce((select role from public.profiles where id=auth.uid()),'system'),
    case when tg_op='INSERT' then 'request_created' else 'request_updated' end,
    case when auth.uid() is null then 'system' else 'user' end,
    case when tg_op='INSERT' then null else to_jsonb(old) end,
    to_jsonb(new), jsonb_build_object('operation',tg_op,'table','store_order_requests')
  );
  return new;
end;
$$;
drop trigger if exists store_order_request_audit_trigger on public.store_order_requests;
create trigger store_order_request_audit_trigger after insert or update on public.store_order_requests for each row execute function public.audit_store_order_request_change();

create or replace function public.record_order_reconciliation_check() returns trigger
language plpgsql security definer set search_path=public,private as $$
declare initial_data jsonb;
begin
  select initial_payload into initial_data from public.store_order_requests where id=new.request_id;
  insert into public.order_reconciliation_checks(request_id,notification_id,tracking_number,event_type,initial_payload,store_payload,mismatch_fields,match_status,checked_at)
  values(new.request_id,new.id,new.tracking_number,new.event_type,coalesce(initial_data,'{}'::jsonb),new.payload,coalesce(new.mismatch_fields,'[]'::jsonb),new.match_status,new.received_at);
  return new;
end;
$$;
drop trigger if exists store_order_notification_reconciliation_trigger on public.store_order_notifications;
create trigger store_order_notification_reconciliation_trigger after insert on public.store_order_notifications for each row execute function public.record_order_reconciliation_check();

revoke execute on function public.audit_store_order_request_change() from public,anon,authenticated;
revoke execute on function public.record_order_reconciliation_check() from public,anon,authenticated;
grant execute on function public.audit_store_order_request_change() to service_role;
grant execute on function public.record_order_reconciliation_check() to service_role;

commit;
