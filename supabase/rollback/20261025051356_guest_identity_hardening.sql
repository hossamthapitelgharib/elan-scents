-- Rolls back migrations/20261025051356_guest_identity_hardening.sql.
-- Restores the previous bodies of guest_identity_link, guest_signal_candidates, guest_signal_store, resolve_guest_browser and
-- save_guest_browser_cart (the text of their last earlier definitions), brings back the legacy two-argument
-- claim_guest_browser_cart, and drops the index that the hourly budget used. create or replace keeps each function's
-- privileges (server-only), and the restored claim function is granted to service_role only, as it was.
begin;

create or replace function public.guest_identity_link(p_a text, p_b text, p_score numeric, p_reasons jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lo text := least(p_a, p_b);
  v_hi text := greatest(p_a, p_b);
begin
  if coalesce(p_a,'') !~ '^[a-f0-9]{64}$' or coalesce(p_b,'') !~ '^[a-f0-9]{64}$' or p_a = p_b then return false; end if;
  -- one guest may be linked to at most 5 others, so a chain can never swallow unrelated guests
  if not exists (select 1 from public.guest_identity_links where hash_a = v_lo and hash_b = v_hi)
     and ((select count(*) from public.guest_identity_links where hash_a in (v_lo, v_hi) or hash_b in (v_lo, v_hi)) >= 5) then
    return false;
  end if;
  insert into public.guest_identity_links (hash_a, hash_b, score, reasons)
  values (v_lo, v_hi, p_score, coalesce(p_reasons, '[]'::jsonb))
  on conflict (hash_a, hash_b) do update set score = excluded.score, reasons = excluded.reasons, last_confirmed_at = now();
  return true;
end;
$$;

create or replace function public.guest_signal_candidates(p_analytics_hash text, p_fp_hash text, p_gpu text, p_screen text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(row_to_json(c)::jsonb), '[]'::jsonb) from (
    select g.analytics_hash as "analyticsHash", g.fp_hash as fp, g.parts, g.ip_hash as "ipHash",
           g.ip_prefix_hash as "ipPrefixHash", g.cart_hash as "cartHash", g.last_seen_at as "lastSeenAt",
           (select count(distinct x.analytics_hash) from public.guest_fingerprints x where x.fp_hash = g.fp_hash) as popularity,
           coalesce((select jsonb_agg(distinct gc.user_id) from public.guest_conversions gc where gc.visitor_hash = g.analytics_hash), '[]'::jsonb) as "convertedUserIds"
    from public.guest_fingerprints g
    where g.analytics_hash <> p_analytics_hash
      and (g.fp_hash = p_fp_hash or (p_gpu is not null and p_screen is not null and g.parts->>'gpu' = p_gpu and g.parts->>'screen' = p_screen))
    order by g.last_seen_at desc
    limit 50
  ) c;
$$;

create or replace function public.guest_signal_store(
  p_analytics_hash text, p_fp_hash text, p_parts jsonb,
  p_ip_hash text, p_ip_prefix_hash text, p_ua_hash text, p_lang_hash text, p_cart_hash text,
  p_interactions integer, p_active_seconds integer, p_pages integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_analytics_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_fp_hash,'') !~ '^[a-f0-9]{16,64}$'
     or jsonb_typeof(coalesce(p_parts,'{}'::jsonb)) <> 'object' then
    return false;
  end if;

  insert into public.guest_fingerprints as g
    (analytics_hash, fp_hash, parts, ip_hash, ip_prefix_hash, ua_hash, lang_hash, cart_hash, interactions, active_seconds, pages)
  values (p_analytics_hash, p_fp_hash, coalesce(p_parts,'{}'::jsonb), p_ip_hash, p_ip_prefix_hash, p_ua_hash, p_lang_hash, p_cart_hash,
          greatest(0, coalesce(p_interactions,0)), greatest(0, coalesce(p_active_seconds,0)), greatest(0, coalesce(p_pages,0)))
  on conflict (analytics_hash, fp_hash) do update
    set parts = excluded.parts,
        ip_hash = coalesce(excluded.ip_hash, g.ip_hash),
        ip_prefix_hash = coalesce(excluded.ip_prefix_hash, g.ip_prefix_hash),
        ua_hash = coalesce(excluded.ua_hash, g.ua_hash),
        lang_hash = coalesce(excluded.lang_hash, g.lang_hash),
        cart_hash = coalesce(excluded.cart_hash, g.cart_hash),
        interactions = greatest(g.interactions, excluded.interactions),
        active_seconds = greatest(g.active_seconds, excluded.active_seconds),
        pages = greatest(g.pages, excluded.pages),
        seen_count = least(g.seen_count + 1, 1000000),
        last_seen_at = now();

  -- keep the 10 most recent fingerprints of one guest
  delete from public.guest_fingerprints d
   where d.analytics_hash = p_analytics_hash
     and d.fp_hash in (
       select fp_hash from public.guest_fingerprints
        where analytics_hash = p_analytics_hash
        order by last_seen_at desc offset 10);
  return true;
end;
$$;

create or replace function public.resolve_guest_browser(
  p_fingerprint_hash text,
  p_analytics_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_guest public.guest_visitors;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid visitor identifier';
  end if;

  insert into public.guest_visitors (fingerprint_hash, identity_version, last_seen_at)
  values (p_fingerprint_hash, 2, now())
  on conflict (fingerprint_hash) do update
    set identity_version = 2, last_seen_at = now()
  returning * into v_guest;

  if v_guest.status = 'guest' then
    insert into public.guest_analytics_visits (visitor_hash, activity_date)
    values (p_analytics_hash, v_today)
    on conflict (visitor_hash, activity_date) do update
      set last_seen_at = now();
  end if;

  return jsonb_build_object(
    'visitorId', v_guest.id,
    'status', v_guest.status,
    'cart', coalesce(v_guest.cart_snapshot, '[]'::jsonb)
  );
end;
$$;

create or replace function public.save_guest_browser_cart(
  p_fingerprint_hash text,
  p_analytics_hash text,
  p_cart_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_guest public.guest_visitors;
  v_item jsonb;
  v_size_id uuid;
  v_store_product_id uuid;
  v_product_id uuid;
  v_quantity integer;
  v_snapshot jsonb;
  v_cart jsonb := '[]'::jsonb;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if coalesce(p_fingerprint_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash,'') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid visitor identifier';
  end if;
  if jsonb_typeof(coalesce(p_cart_snapshot,'[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_cart_snapshot,'[]'::jsonb)) > 100 then
    raise exception 'Invalid guest cart';
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_cart_snapshot,'[]'::jsonb)) loop
    if coalesce(v_item->>'sid','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then continue; end if;
    v_size_id := (v_item->>'sid')::uuid;
    v_store_product_id := case
      when coalesce(v_item->>'storeProductId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (v_item->>'storeProductId')::uuid else null end;
    v_quantity := case when coalesce(v_item->>'q',v_item->>'quantity','') ~ '^[0-9]{1,3}$'
      then greatest(1,least(99,coalesce(v_item->>'q',v_item->>'quantity')::integer)) else 1 end;
    select ps.product_id into v_product_id from public.product_sizes ps where ps.id = v_size_id;
    if v_product_id is null then continue; end if;
    if v_store_product_id is not null and not exists (
      select 1 from public.store_products sp where sp.id = v_store_product_id and sp.product_size_id = v_size_id
    ) then v_store_product_id := null; end if;
    v_snapshot := public.capture_product_snapshot(v_product_id,v_size_id,v_store_product_id,'guest_cart');
    if v_snapshot is null then continue; end if;
    v_cart := v_cart || jsonb_build_array(jsonb_build_object(
      'sid',v_size_id,'storeProductId',v_store_product_id,'q',v_quantity,'productSnapshot',v_snapshot));
  end loop;

  insert into public.guest_visitors(fingerprint_hash,identity_version,cart_snapshot,last_seen_at)
  values(p_fingerprint_hash,2,v_cart,now())
  on conflict(fingerprint_hash) do update set identity_version=2,cart_snapshot=excluded.cart_snapshot,last_seen_at=now()
  returning * into v_guest;
  if v_guest.status = 'guest' then
    insert into public.guest_analytics_visits(visitor_hash,activity_date)
    values(p_analytics_hash,v_today)
    on conflict(visitor_hash,activity_date) do update set last_seen_at=now();
  end if;
  return jsonb_build_object('visitorId',v_guest.id,'status',v_guest.status,'cart',coalesce(v_guest.cart_snapshot,'[]'::jsonb));
end;
$$;

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

revoke all on function public.claim_guest_browser_cart(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_guest_browser_cart(text, uuid) to service_role;

drop index if exists public.guest_visitors_first_seen_idx;

commit;
