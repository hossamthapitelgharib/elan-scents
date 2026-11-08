-- Rollback for the «حسابي» address-parts migration. It deletes the city, building, floor and flat every customer saved.
-- The trigger function returns to the version of 20261106211851_customer_account_details.sql.
create or replace function private.customer_details_normalize()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  new.full_name := btrim(regexp_replace(coalesce(new.full_name, ''), '\s+', ' ', 'g'));
  new.phone := regexp_replace(btrim(coalesce(new.phone, '')), '[\s-]', '', 'g');
  new.governorate := nullif(btrim(coalesce(new.governorate, '')), '');
  new.address := btrim(coalesce(new.address, ''));
  new.recipient_name := nullif(btrim(regexp_replace(coalesce(new.recipient_name, ''), '\s+', ' ', 'g')), '');
  new.recipient_phone := nullif(regexp_replace(btrim(coalesce(new.recipient_phone, '')), '[\s-]', '', 'g'), '');
  new.delivery_notes := nullif(btrim(coalesce(new.delivery_notes, '')), '');
  if new.ship_same then
    new.ship_governorate := new.governorate;
    new.ship_address := new.address;
    new.ship_lat := new.address_lat;
    new.ship_lng := new.address_lng;
  else
    new.ship_governorate := nullif(btrim(coalesce(new.ship_governorate, '')), '');
    new.ship_address := btrim(coalesce(new.ship_address, ''));
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $function$;

alter table public.customer_details
  drop constraint if exists customer_details_unit_len,
  drop constraint if exists customer_details_city_len,
  drop column if exists ship_apartment_no, drop column if exists ship_floor_no, drop column if exists ship_building_no, drop column if exists ship_city,
  drop column if exists apartment_no, drop column if exists floor_no, drop column if exists building_no, drop column if exists city;
