-- A new customer account now tells the platform dashboard.
-- The sign-up trigger already creates the profile row; when it really creates one, it also writes one notification for the
-- platform admins (same table and shape the order notifications use: no user, recipient_role = 'platform_admin'). The dashboard's
-- bell (GET /api/notifications, polled every 30 s) shows it, and the "registered customers" count is the number of customer profiles,
-- so it grows by the same insert. The notice can never make a sign-up fail: if writing it errors, a warning is logged and the sign-up goes on.
-- The name is cut to the profile column ceiling (120) as before; the notification body is shown escaped by the dashboard.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_name text := left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120);
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id, v_name, left(new.phone, 32))
  on conflict (id) do nothing;
  if found then
    begin
      insert into public.notifications (user_id, recipient_role, type, title, body, payload)
      values (null, 'platform_admin', 'customer_registered', 'تم تسجيل عميل جديد بنجاح',
              concat_ws(' — ', nullif(v_name, ''), nullif(new.email, '')),
              jsonb_build_object('customer_id', new.id));
    exception when others then
      raise warning 'customer_registered notification skipped: %', sqlerrm;
    end;
  end if;
  return new;
end $function$;
