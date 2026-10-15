begin;

create table if not exists public.customer_searches (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid references public.guest_visitors(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  session_id uuid references public.customer_sessions(session_id) on delete set null,
  search_text text not null check (char_length(btrim(search_text)) between 1 and 200),
  result_products jsonb not null default '[]'::jsonb check (jsonb_typeof(result_products) = 'array' and jsonb_array_length(result_products) <= 10),
  result_count integer not null default 0 check (result_count between 0 and 10),
  occurred_at timestamptz not null default now(),
  constraint customer_searches_exactly_one_actor check ((guest_id is not null) <> (user_id is not null))
);

create index if not exists customer_searches_guest_time_idx
  on public.customer_searches (guest_id, occurred_at desc) where guest_id is not null;
create index if not exists customer_searches_user_time_idx
  on public.customer_searches (user_id, occurred_at desc) where user_id is not null;

alter table public.customer_searches enable row level security;
revoke all on public.customer_searches from public, anon, authenticated;
grant all on public.customer_searches to service_role;

create or replace function public.record_customer_search(
  p_fingerprint_hash text,
  p_analytics_hash text,
  p_user_id uuid,
  p_session_id uuid,
  p_search_text text,
  p_results jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_product_size_id uuid;
  v_store_product_id uuid;
  v_snapshot jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if (p_user_id is null) = (p_fingerprint_hash is null) then return false; end if;
  if p_session_id is null or coalesce(btrim(p_search_text), '') = '' or char_length(btrim(p_search_text)) > 200 then return false; end if;
  if jsonb_typeof(coalesce(p_results, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_results, '[]'::jsonb)) > 10 then return false; end if;

  if p_user_id is not null then
    if not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.role = 'customer') then return false; end if;
  else
    if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$' then return false; end if;
    select gv.id into v_guest_id from public.guest_visitors gv
      where gv.fingerprint_hash = p_fingerprint_hash and gv.status = 'guest' and gv.identity_version = 2;
    if v_guest_id is null then return false; end if;
  end if;

  perform public.record_customer_session(p_fingerprint_hash, p_user_id, p_session_id, 'start');
  if not exists (
    select 1 from public.customer_sessions cs where cs.session_id = p_session_id
      and cs.guest_id is not distinct from v_guest_id and cs.user_id is not distinct from p_user_id
  ) then return false; end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    if coalesce(v_item->>'productId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then continue; end if;
    v_product_id := (v_item->>'productId')::uuid;
    v_product_size_id := case when coalesce(v_item->>'productSizeId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (v_item->>'productSizeId')::uuid else null end;
    v_store_product_id := case when coalesce(v_item->>'storeProductId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (v_item->>'storeProductId')::uuid else null end;
    if v_product_size_id is null and v_store_product_id is not null then
      select sp.product_size_id into v_product_size_id from public.store_products sp where sp.id = v_store_product_id;
    end if;
    if not public.record_customer_product_event(
      p_fingerprint_hash, p_analytics_hash, p_user_id, p_session_id,
      'search', v_product_id, v_product_size_id, v_store_product_id, null
    ) then continue; end if;
    v_snapshot := public.capture_product_snapshot(v_product_id, v_product_size_id, v_store_product_id, 'search_result');
    if v_snapshot is null then continue; end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'productId', v_product_id, 'productSizeId', v_product_size_id,
      'storeProductId', v_store_product_id, 'product', v_snapshot
    ));
    v_count := v_count + 1;
  end loop;

  insert into public.customer_searches(guest_id, user_id, session_id, search_text, result_products, result_count)
  values (v_guest_id, p_user_id, p_session_id, btrim(p_search_text), v_results, v_count);
  if v_guest_id is not null then
    update public.guest_visitors set last_seen_at = now() where id = v_guest_id;
  end if;
  return true;
end;
$$;

create or replace function public.platform_customer_search_detail(
  p_guest_id uuid,
  p_user_id uuid,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total bigint := 0;
  v_searches jsonb := '[]'::jsonb;
begin
  if (p_guest_id is null) = (p_user_id is null) then raise exception 'exactly one customer id is required'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 then raise exception 'invalid page'; end if;
  if p_guest_id is not null then
    select count(*) into v_total from public.customer_searches cs where cs.guest_id = p_guest_id;
    select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x."occurredAt" desc, x.id desc), '[]'::jsonb)
      into v_searches from (
        select cs.id, cs.search_text as "searchText", cs.occurred_at as "occurredAt",
          cs.result_count as "resultCount", cs.result_products as results, cs.session_id as "sessionId"
        from public.customer_searches cs where cs.guest_id = p_guest_id
        order by cs.occurred_at desc, cs.id desc limit p_limit offset p_offset
      ) x;
  else
    select count(*) into v_total from public.customer_searches cs where cs.user_id = p_user_id;
    select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x."occurredAt" desc, x.id desc), '[]'::jsonb)
      into v_searches from (
        select cs.id, cs.search_text as "searchText", cs.occurred_at as "occurredAt",
          cs.result_count as "resultCount", cs.result_products as results, cs.session_id as "sessionId"
        from public.customer_searches cs where cs.user_id = p_user_id
        order by cs.occurred_at desc, cs.id desc limit p_limit offset p_offset
      ) x;
  end if;
  return jsonb_build_object('searches', v_searches, 'searchTotal', v_total, 'hasMore', p_offset + p_limit < v_total);
end;
$$;

-- Transfer the browser's search history to the authenticated customer before removing the guest.
create or replace function public.claim_guest_browser_cart(p_fingerprint_hash text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest public.guest_visitors%rowtype;
  v_item jsonb;
  v_moved integer := 0;
  v_cart jsonb := '[]'::jsonb;
  v_size_id uuid;
  v_store_product_id uuid;
  v_quantity integer;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or p_user_id is null then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.role = 'customer') then
    return jsonb_build_object('claimed', false, 'cart', 0);
  end if;
  select * into v_guest from public.guest_visitors
    where fingerprint_hash = p_fingerprint_hash and status = 'guest' and identity_version = 2
    for update;
  if not found then return jsonb_build_object('claimed', false, 'cart', 0); end if;

  for v_item in select value from jsonb_array_elements(coalesce(v_guest.cart_snapshot, '[]'::jsonb)) loop
    begin v_size_id := nullif(v_item->>'sid', '')::uuid; exception when others then v_size_id := null; end;
    begin v_store_product_id := nullif(v_item->>'storeProductId', '')::uuid; exception when others then v_store_product_id := null; end;
    begin v_quantity := greatest(1, least(99, coalesce((v_item->>'q')::integer, 1))); exception when others then v_quantity := 1; end;
    if v_size_id is not null and v_store_product_id is not null and exists (
      select 1 from public.store_products sp where sp.id = v_store_product_id and sp.product_size_id = v_size_id
    ) then
      insert into public.cart_items(user_id, store_product_id, quantity)
      values (p_user_id, v_store_product_id, v_quantity)
      on conflict (user_id, store_product_id) do update
        set quantity = least(99, public.cart_items.quantity + excluded.quantity), updated_at = now();
      v_moved := v_moved + 1;
    end if;
  end loop;

  update public.customer_sessions set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;
  update public.customer_product_events set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;
  update public.customer_searches set guest_id = null, user_id = p_user_id where guest_id = v_guest.id;
  delete from public.guest_visitors where id = v_guest.id;
  select coalesce(jsonb_agg(jsonb_build_object('sid', sp.product_size_id, 'storeProductId', sp.id, 'q', ci.quantity)), '[]'::jsonb)
    into v_cart from public.cart_items ci join public.store_products sp on sp.id = ci.store_product_id
    where ci.user_id = p_user_id;
  return jsonb_build_object('claimed', true, 'cart', v_moved, 'items', jsonb_array_length(v_cart), 'snapshot', v_cart);
end;
$$;

revoke all on function public.record_customer_search(text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_customer_search(text, text, uuid, uuid, text, jsonb) to service_role;
revoke all on function public.platform_customer_search_detail(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.platform_customer_search_detail(uuid, uuid, integer, integer) to service_role;
revoke all on function public.claim_guest_browser_cart(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_guest_browser_cart(text, uuid) to service_role;

comment on table public.customer_searches is 'One row per submitted storefront search, including exact query and server-built complete product snapshots for up to ten results; admin/service only.';
comment on column public.customer_searches.search_text is 'Trimmed storefront search query (maximum 200 characters), retained with its matching result snapshots.';
comment on column public.customer_searches.result_products is 'Authoritative server-captured full product and offer snapshots for products returned by this search.';

commit;
