-- «حسابي»: the address is written in the parts a courier reads: governorate, city, street and area, then building, floor and flat.
-- The columns are optional in the table (a row saved before this change stays valid); the page asks for the city and the building.
-- Nothing is renamed or removed: `address` keeps the street and area text, and the order form composes the full line from the parts.
alter table public.customer_details
  add column city               text,
  add column building_no        text,
  add column floor_no           text,
  add column apartment_no       text,
  add column ship_city          text,
  add column ship_building_no   text,
  add column ship_floor_no      text,
  add column ship_apartment_no  text,
  add constraint customer_details_city_len check (char_length(city) <= 80 and char_length(ship_city) <= 80),
  add constraint customer_details_unit_len check (
    char_length(building_no) <= 20 and char_length(floor_no) <= 20 and char_length(apartment_no) <= 20
    and char_length(ship_building_no) <= 20 and char_length(ship_floor_no) <= 20 and char_length(ship_apartment_no) <= 20);

comment on column public.customer_details.city is 'City or markaz of the home address (the "حسابي" page).';
comment on column public.customer_details.building_no is 'Building number of the home address; floor_no and apartment_no follow it. ship_* are the delivery address copies.';

-- Same trigger as before plus the new columns: trimmed, empty becomes null, and a delivery address that is "the same" is a copy of the home one.
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
  new.city := nullif(btrim(regexp_replace(coalesce(new.city, ''), '\s+', ' ', 'g')), '');
  new.address := btrim(coalesce(new.address, ''));
  new.building_no := nullif(btrim(coalesce(new.building_no, '')), '');
  new.floor_no := nullif(btrim(coalesce(new.floor_no, '')), '');
  new.apartment_no := nullif(btrim(coalesce(new.apartment_no, '')), '');
  new.recipient_name := nullif(btrim(regexp_replace(coalesce(new.recipient_name, ''), '\s+', ' ', 'g')), '');
  new.recipient_phone := nullif(regexp_replace(btrim(coalesce(new.recipient_phone, '')), '[\s-]', '', 'g'), '');
  new.delivery_notes := nullif(btrim(coalesce(new.delivery_notes, '')), '');
  if new.ship_same then
    new.ship_governorate := new.governorate;
    new.ship_city := new.city;
    new.ship_address := new.address;
    new.ship_building_no := new.building_no;
    new.ship_floor_no := new.floor_no;
    new.ship_apartment_no := new.apartment_no;
    new.ship_lat := new.address_lat;
    new.ship_lng := new.address_lng;
  else
    new.ship_governorate := nullif(btrim(coalesce(new.ship_governorate, '')), '');
    new.ship_city := nullif(btrim(regexp_replace(coalesce(new.ship_city, ''), '\s+', ' ', 'g')), '');
    new.ship_address := btrim(coalesce(new.ship_address, ''));
    new.ship_building_no := nullif(btrim(coalesce(new.ship_building_no, '')), '');
    new.ship_floor_no := nullif(btrim(coalesce(new.ship_floor_no, '')), '');
    new.ship_apartment_no := nullif(btrim(coalesce(new.ship_apartment_no, '')), '');
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
