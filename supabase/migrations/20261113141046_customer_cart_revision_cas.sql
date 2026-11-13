-- The browser never reads or writes this table. Each account's monotonic revision
-- makes a cart replacement conditional on the snapshot the caller actually read.
create table if not exists public.customer_cart_revisions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
revoke all on table public.customer_cart_revisions from public, anon, authenticated, service_role;

create or replace function private.bump_customer_cart_revision()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user_id uuid;
begin
  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  insert into public.customer_cart_revisions(user_id, revision, updated_at)
  values (v_user_id, 1, now())
  on conflict (user_id) do update
    set revision = public.customer_cart_revisions.revision + 1,
        updated_at = now();
  if tg_op = 'UPDATE' and old.user_id <> new.user_id then
    insert into public.customer_cart_revisions(user_id, revision, updated_at)
    values (old.user_id, 1, now())
    on conflict (user_id) do update
      set revision = public.customer_cart_revisions.revision + 1, updated_at = now();
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function private.bump_customer_cart_revision() from public, anon, authenticated, service_role;

drop trigger if exists customer_cart_revision_changed on public.cart_items;
create trigger customer_cart_revision_changed
after insert or update or delete on public.cart_items
for each row execute function private.bump_customer_cart_revision();

create or replace function public.read_customer_cart_server(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_revision bigint;
  v_items jsonb;
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  insert into public.customer_cart_revisions(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select revision into v_revision from public.customer_cart_revisions where user_id = p_user_id;
  select coalesce(jsonb_agg(jsonb_build_object('storeProductId', ci.store_product_id, 'quantity', ci.quantity)
    order by ci.store_product_id), '[]'::jsonb)
    into v_items from public.cart_items ci where ci.user_id = p_user_id;
  return jsonb_build_object('items', v_items, 'revision', v_revision);
end;
$function$;

create or replace function public.replace_customer_cart_server_cas(
  p_items jsonb, p_expected_revision bigint, p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_revision bigint;
  v_items jsonb;
begin
  if p_user_id is null then raise exception 'Authentication required'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid cart revision'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  insert into public.customer_cart_revisions(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select revision into v_revision from public.customer_cart_revisions where user_id = p_user_id for update;

  if v_revision <> p_expected_revision then
    select coalesce(jsonb_agg(jsonb_build_object('storeProductId', ci.store_product_id, 'quantity', ci.quantity)
      order by ci.store_product_id), '[]'::jsonb)
      into v_items from public.cart_items ci where ci.user_id = p_user_id;
    return jsonb_build_object('ok', false, 'conflict', true, 'items', v_items, 'revision', v_revision);
  end if;

  perform * from public.replace_customer_cart(coalesce(p_items, '[]'::jsonb));
  -- Increment even if the replacement is identical or the cart is empty. Row triggers
  -- also account for each actual cart-row change, including changes made by other RPCs.
  update public.customer_cart_revisions
    set revision = revision + 1, updated_at = now()
    where user_id = p_user_id
    returning revision into v_revision;
  select coalesce(jsonb_agg(jsonb_build_object('storeProductId', ci.store_product_id, 'quantity', ci.quantity)
    order by ci.store_product_id), '[]'::jsonb)
    into v_items from public.cart_items ci where ci.user_id = p_user_id;
  return jsonb_build_object('ok', true, 'items', v_items, 'revision', v_revision);
end;
$function$;

revoke all on function public.read_customer_cart_server(uuid) from public, anon, authenticated;
revoke all on function public.replace_customer_cart_server_cas(jsonb, bigint, uuid) from public, anon, authenticated;
grant execute on function public.read_customer_cart_server(uuid) to service_role;
grant execute on function public.replace_customer_cart_server_cas(jsonb, bigint, uuid) to service_role;
