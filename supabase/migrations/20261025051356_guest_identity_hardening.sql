begin;

-- Visitor identity hardening (review of 2026-10-24). The visitor fingerprint only decides how many different people
-- are counted; it never moves a basket from one guest to another. Nothing here changes that, and nothing touches a
-- customer, an order or a price. These changes bound what an anonymous caller can make the database store, and
-- make the "same person" estimate harder to blow up.

-- 1. The old two-argument claim function is removed. It moved the basket but left the browser's anonymous counters,
--    visits and stored fingerprints behind and recorded no conversion, so a person could be counted as a guest and
--    as a customer. The API only called it as a fallback when the three-argument function answered 400 or 404.
drop function if exists public.claim_guest_browser_cart(text, uuid);

-- 2. One person never groups more than 8 browsers. The earlier cap (each browser linked to at most 5 others) did not
--    bound a chain of links: A-B, B-C, C-D ... could join any number of browsers into one "person".
create or replace function public.guest_identity_link(p_a text, p_b text, p_score numeric, p_reasons jsonb)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lo text := least(p_a, p_b);
  v_hi text := greatest(p_a, p_b);
  v_size integer;
begin
  if coalesce(p_a,'') !~ '^[a-f0-9]{64}$' or coalesce(p_b,'') !~ '^[a-f0-9]{64}$' or p_a = p_b then return false; end if;
  if not exists (select 1 from public.guest_identity_links where hash_a = v_lo and hash_b = v_hi) then
    -- one guest may be linked to at most 5 others
    if (select count(*) from public.guest_identity_links where hash_a in (v_lo, v_hi) or hash_b in (v_lo, v_hi)) >= 5 then
      return false;
    end if;
    -- and the group these two would form may hold at most 8 browsers
    with recursive comp(h) as (
      select v_lo
      union
      select v_hi
      union
      select case when l.hash_a = comp.h then l.hash_b else l.hash_a end
      from comp join public.guest_identity_links l on l.hash_a = comp.h or l.hash_b = comp.h
    )
    select count(*) into v_size from (select h from comp limit 20) t;
    if v_size > 8 then return false; end if;
  end if;
  insert into public.guest_identity_links (hash_a, hash_b, score, reasons)
  values (v_lo, v_hi, p_score, coalesce(p_reasons, '[]'::jsonb))
  on conflict (hash_a, hash_b) do update set score = excluded.score, reasons = excluded.reasons, last_confirmed_at = now();
  return true;
end;
$function$;

-- 3. Candidates for a match: the browsers that carry exactly the same overall fingerprint come first, then the
--    weaker device matches (same graphics card and screen), most recent first. Before, only the recency decided, so
--    fifty recent look-alike phones could push the one real match out of the fifty rows that are returned.
create or replace function public.guest_signal_candidates(p_analytics_hash text, p_fp_hash text, p_gpu text, p_screen text)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(jsonb_agg(row_to_json(c)::jsonb), '[]'::jsonb) from (
    select g.analytics_hash as "analyticsHash", g.fp_hash as fp, g.parts, g.ip_hash as "ipHash",
           g.ip_prefix_hash as "ipPrefixHash", g.cart_hash as "cartHash", g.last_seen_at as "lastSeenAt",
           (select count(distinct x.analytics_hash) from public.guest_fingerprints x where x.fp_hash = g.fp_hash) as popularity,
           coalesce((select jsonb_agg(distinct gc.user_id) from public.guest_conversions gc where gc.visitor_hash = g.analytics_hash), '[]'::jsonb) as "convertedUserIds"
    from public.guest_fingerprints g
    where g.analytics_hash <> p_analytics_hash
      and (g.fp_hash = p_fp_hash or (p_gpu is not null and p_screen is not null and g.parts->>'gpu' = p_gpu and g.parts->>'screen' = p_screen))
    order by (g.fp_hash = p_fp_hash) desc, g.last_seen_at desc
    limit 50
  ) c;
$function$;

-- 4. A fingerprint is stored only for a browser the server has already seen (it has a visit row). Without this, a
--    script could invent any number of browser identifiers and fill guest_fingerprints without ever creating a guest.
create or replace function public.guest_signal_store(p_analytics_hash text, p_fp_hash text, p_parts jsonb, p_ip_hash text, p_ip_prefix_hash text, p_ua_hash text, p_lang_hash text, p_cart_hash text, p_interactions integer, p_active_seconds integer, p_pages integer)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if coalesce(p_analytics_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_fp_hash,'') !~ '^[a-f0-9]{16,64}$'
     or jsonb_typeof(coalesce(p_parts,'{}'::jsonb)) <> 'object' then
    return false;
  end if;
  if not exists (select 1 from public.guest_analytics_visits v where v.visitor_hash = p_analytics_hash) then
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
$function$;

-- 5. A budget for brand-new guests: at most 2000 new guest rows in any hour. A real store does not come near it; a
--    script inventing visitor keys is stopped at that number instead of filling the table (each guest row can carry
--    a basket of up to 100 lines). A visitor who is over the budget gets an empty answer: their own basket still
--    works in their browser, they are just not recorded server-side until the hour has room again. Guests who
--    already exist are never affected.
create index if not exists guest_visitors_first_seen_idx on public.guest_visitors (first_seen_at desc);

create or replace function public.resolve_guest_browser(p_fingerprint_hash text, p_analytics_hash text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_guest public.guest_visitors;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid visitor identifier';
  end if;

  if not exists (select 1 from public.guest_visitors where fingerprint_hash = p_fingerprint_hash)
     and (select count(*) from public.guest_visitors where first_seen_at > now() - interval '1 hour') >= 2000 then
    return jsonb_build_object('visitorId', null, 'status', 'guest', 'cart', '[]'::jsonb, 'limited', true);
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
$function$;

create or replace function public.save_guest_browser_cart(p_fingerprint_hash text, p_analytics_hash text, p_cart_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare v_guest public.guest_visitors; v_item jsonb; v_size_id uuid; v_store_product_id uuid; v_product_id uuid; v_quantity integer; v_snapshot jsonb; v_cart jsonb:='[]'::jsonb; v_today date:=(now() at time zone 'Africa/Cairo')::date;
begin
 if coalesce(p_fingerprint_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash,'') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid visitor identifier'; end if;
 if jsonb_typeof(coalesce(p_cart_snapshot,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_cart_snapshot,'[]'::jsonb))>100 then raise exception 'Invalid guest cart'; end if;
 if not exists (select 1 from public.guest_visitors where fingerprint_hash = p_fingerprint_hash)
    and (select count(*) from public.guest_visitors where first_seen_at > now() - interval '1 hour') >= 2000 then
   return jsonb_build_object('visitorId', null, 'status', 'guest', 'cart', '[]'::jsonb, 'limited', true);
 end if;
 for v_item in select value from jsonb_array_elements(coalesce(p_cart_snapshot,'[]'::jsonb)) loop
  if coalesce(v_item->>'sid','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then continue; end if;
  v_size_id:=(v_item->>'sid')::uuid;
  v_store_product_id:=case when coalesce(v_item->>'storeProductId','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (v_item->>'storeProductId')::uuid else null end;
  v_quantity:=case when coalesce(v_item->>'q',v_item->>'quantity','')~'^[0-9]{1,3}$' then greatest(1,least(99,coalesce(v_item->>'q',v_item->>'quantity')::integer)) else 1 end;
  select ps.product_id into v_product_id from public.product_sizes ps where ps.id=v_size_id;
  if v_product_id is null then continue; end if;
  if v_store_product_id is not null and not exists(select 1 from public.store_products sp where sp.id=v_store_product_id and sp.product_size_id=v_size_id) then v_store_product_id:=null; end if;
  v_snapshot:=public.capture_product_snapshot(v_product_id,v_size_id,v_store_product_id,'guest_cart');
  if v_snapshot is null then continue; end if;
  v_cart:=v_cart||jsonb_build_array(jsonb_build_object('sid',v_size_id,'storeProductId',v_store_product_id,'q',v_quantity,'productSnapshot',v_snapshot));
 end loop;
 insert into public.guest_visitors(fingerprint_hash,identity_version,cart_snapshot,last_seen_at) values(p_fingerprint_hash,2,v_cart,now())
 on conflict(fingerprint_hash) do update set identity_version=2,cart_snapshot=excluded.cart_snapshot,last_seen_at=now() returning * into v_guest;
 if v_guest.status='guest' then insert into public.guest_analytics_visits(visitor_hash,activity_date) values(p_analytics_hash,v_today) on conflict(visitor_hash,activity_date) do update set last_seen_at=now(); end if;
 return jsonb_build_object('visitorId',v_guest.id,'status',v_guest.status,'cart',coalesce(v_guest.cart_snapshot,'[]'::jsonb));
end;
$function$;

commit;
