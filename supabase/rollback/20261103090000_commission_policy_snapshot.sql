begin;

drop trigger if exists snapshot_store_commission_rate on public.store_order_requests;
drop function if exists private.snapshot_store_commission_rate();
drop trigger if exists protect_order_commission_rate on public.store_order_requests;
drop function if exists private.protect_order_commission_rate();
alter table public.store_order_requests drop column if exists commission_rate;
alter table public.stores alter column commission_rate set default 0;

commit;
