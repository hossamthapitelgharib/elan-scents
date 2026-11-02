-- Rolls back migrations/20261102065502_customer_registered_notification.sql.
-- New sign-ups stop writing a notification for the platform dashboard (the function goes back to creating the profile only).
-- Notifications already written stay in public.notifications (type 'customer_registered'); delete them by hand if they are not wanted.
begin;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120), left(new.phone, 32))
  on conflict (id) do nothing;
  return new;
end $function$;

commit;
