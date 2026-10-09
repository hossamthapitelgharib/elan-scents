create or replace function public.notifications_on_store_order_change() returns trigger language plpgsql security definer set search_path=public,private as $$
begin
  if tg_op='INSERT' then
    perform public.emit_order_notification(new,'order_initial','طلب جديد','تم إرسال طلب جديد إلى المتجر.',jsonb_build_object('status',new.status,'subtotal',new.subtotal,'currency',new.currency));
  elsif new.status='store_cancelled' and old.status is distinct from new.status then
    perform public.emit_order_notification(new,'store_cancelled','تم إلغاء طلب المتجر','تم إلغاء الطلب وإعادة منتجاته إلى سلة العميل.',jsonb_build_object('status',new.status,'reason',new.failure_reason,'reconciliationStatus',new.reconciliation_status,'mismatchFields',new.mismatch_fields));
  elsif new.status is distinct from old.status and new.status in ('store_confirmed','processing','shipped','delivered','store_rejected') then
    perform public.emit_order_notification(new,'order_update','تحديث حالة الطلب','تم تحديث حالة طلب المتجر إلى: '||new.status,jsonb_build_object('status',new.status,'shippingAmount',new.shipping_amount,'totalAmount',new.total_amount));
  end if;
  return new;
end; $$;
drop trigger if exists store_order_notifications_realtime_trigger on public.store_order_requests;
create trigger store_order_notifications_realtime_trigger after insert or update on public.store_order_requests for each row execute function public.notifications_on_store_order_change();