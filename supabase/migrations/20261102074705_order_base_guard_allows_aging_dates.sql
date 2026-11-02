create or replace function private.protect_order_base()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
begin
  if tg_table_name = 'store_order_request_items' then
    if tg_op = 'DELETE' then
      if exists (select 1 from public.store_order_commissions c where c.request_id = old.request_id) then
        raise exception 'Order lines of a sold order cannot be deleted' using errcode = 'P0001';
      end if;
      return old;
    end if;
    if new.request_id is distinct from old.request_id or new.quantity is distinct from old.quantity
       or new.unit_price is distinct from old.unit_price or new.line_total is distinct from old.line_total
       or new.currency is distinct from old.currency then
      raise exception 'Order lines are immutable; use an adjustment' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.subtotal is distinct from old.subtotal or new.store_id is distinct from old.store_id
     or new.tracking_number is distinct from old.tracking_number or new.currency is distinct from old.currency
     or (old.user_id is not null and new.user_id is not null and new.user_id is distinct from old.user_id) then
    raise exception 'The order base is immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
