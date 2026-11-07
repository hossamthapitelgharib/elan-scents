-- «حسابي»: the customer's contact and delivery details, written once at the first order and reused by every later one.
-- One row per customer. The customer reads and writes only his own row (never deletes it: it goes with his account).
-- The e-mail is not stored here: it stays the account's own (auth.users) so the two can never differ.
create table public.customer_details (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  full_name         text not null,
  phone             text not null,
  governorate       text,
  address           text not null,
  address_lat       double precision,
  address_lng       double precision,
  ship_same         boolean not null default true,
  ship_governorate  text,
  ship_address      text not null,
  ship_lat          double precision,
  ship_lng          double precision,
  recipient_name    text,
  recipient_phone   text,
  delivery_notes    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint customer_details_full_name_len check (char_length(full_name) between 2 and 120),
  constraint customer_details_phone_fmt check (phone ~ '^\+?[0-9]{8,15}$'),
  constraint customer_details_governorate_len check (char_length(governorate) <= 60 and char_length(ship_governorate) <= 60),
  constraint customer_details_address_len check (char_length(address) between 5 and 300 and char_length(ship_address) between 5 and 300),
  constraint customer_details_point check (
    ((address_lat is null) = (address_lng is null)) and ((ship_lat is null) = (ship_lng is null))
    and (address_lat is null or (address_lat between -90 and 90 and address_lng between -180 and 180))
    and (ship_lat is null or (ship_lat between -90 and 90 and ship_lng between -180 and 180))),
  constraint customer_details_recipient check (
    (recipient_name is null or char_length(recipient_name) between 2 and 120)
    and (recipient_phone is null or recipient_phone ~ '^\+?[0-9]{8,15}$')),
  constraint customer_details_notes_len check (char_length(delivery_notes) <= 500)
);

comment on table public.customer_details is 'Customer contact and delivery details (the "حسابي" page): filled at the first order, reused by later ones. Own row only.';

-- The database, not the browser, makes the row consistent: text is trimmed, empty optional text becomes null, the delivery address
-- is a copy of the home address while ship_same is true, and the owner, the creation time and the update time cannot be set by the caller.
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

create trigger customer_details_normalize
  before insert or update on public.customer_details
  for each row execute function private.customer_details_normalize();

alter table public.customer_details enable row level security;

create policy own_all on public.customer_details
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- A table created from now on is read-only for clients; this one is written by the browser, so the grant is explicit and narrow.
revoke all on public.customer_details from public, anon, authenticated;
grant select, insert, update on public.customer_details to authenticated;
grant all on public.customer_details to service_role;
