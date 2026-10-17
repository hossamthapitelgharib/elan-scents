begin;

-- Several fingerprints per guest, plus the server-side signals seen with them. Every value is a
-- keyed hash made by the server: no raw IP, user agent, language list or device value is stored.
create table if not exists public.guest_fingerprints (
  analytics_hash text not null check (analytics_hash ~ '^[a-f0-9]{64}$'),
  fp_hash text not null check (fp_hash ~ '^[a-f0-9]{16,64}$'),
  parts jsonb not null default '{}'::jsonb check (jsonb_typeof(parts) = 'object'),
  ip_hash text check (ip_hash is null or ip_hash ~ '^[a-f0-9]{64}$'),
  ip_prefix_hash text check (ip_prefix_hash is null or ip_prefix_hash ~ '^[a-f0-9]{64}$'),
  ua_hash text check (ua_hash is null or ua_hash ~ '^[a-f0-9]{64}$'),
  lang_hash text check (lang_hash is null or lang_hash ~ '^[a-f0-9]{64}$'),
  cart_hash text check (cart_hash is null or cart_hash ~ '^[a-f0-9]{64}$'),
  interactions integer not null default 0 check (interactions >= 0),
  active_seconds integer not null default 0 check (active_seconds >= 0),
  pages integer not null default 0 check (pages >= 0),
  seen_count integer not null default 1 check (seen_count >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (analytics_hash, fp_hash)
);
create index if not exists guest_fingerprints_fp_idx on public.guest_fingerprints (fp_hash);
create index if not exists guest_fingerprints_device_idx on public.guest_fingerprints ((parts->>'gpu'), (parts->>'screen'));

-- "These two guests are very probably one device/person". Used only for counting people.
-- Nothing here moves a basket, a session or an event.
create table if not exists public.guest_identity_links (
  hash_a text not null check (hash_a ~ '^[a-f0-9]{64}$'),
  hash_b text not null check (hash_b ~ '^[a-f0-9]{64}$'),
  score numeric not null,
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  primary key (hash_a, hash_b),
  check (hash_a < hash_b)
);
create index if not exists guest_identity_links_b_idx on public.guest_identity_links (hash_b);

alter table public.guest_fingerprints enable row level security;
alter table public.guest_identity_links enable row level security;
revoke all on table public.guest_fingerprints, public.guest_identity_links from anon, authenticated;
grant all on table public.guest_fingerprints, public.guest_identity_links to service_role;
drop policy if exists guest_fingerprints_no_client_access on public.guest_fingerprints;
create policy guest_fingerprints_no_client_access on public.guest_fingerprints for all to anon, authenticated using (false) with check (false);
drop policy if exists guest_identity_links_no_client_access on public.guest_identity_links;
create policy guest_identity_links_no_client_access on public.guest_identity_links for all to anon, authenticated using (false) with check (false);

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

-- Candidates are other guests whose device parts (graphics + screen) are equal, or whose whole
-- fingerprint is equal. The decision itself is made by the server code (lib/guest-match.js).
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

-- The smallest hash of the linked group: one stable id for everything the group contains.
create or replace function public.guest_final_id(p_hash text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recursive grp(h) as (
    select p_hash
    union
    select case when l.hash_a = grp.h then l.hash_b else l.hash_a end
    from grp join public.guest_identity_links l on l.hash_a = grp.h or l.hash_b = grp.h
  )
  select min(h) from grp;
$$;

-- People among the guests seen in a period: linked guests count once.
create or replace function public.guest_unique_people(p_period text default 'today')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_end date := (now() at time zone 'Africa/Cairo')::date;
  v_start date;
  v_browsers bigint := 0;
  v_people bigint := 0;
begin
  if p_period not in ('today','week','month','year') then raise exception 'invalid period'; end if;
  v_start := case p_period when 'today' then v_end when 'week' then v_end-6 when 'month' then v_end-29 else v_end-364 end;

  with seen as (
    select distinct visitor_hash as h from public.guest_analytics_visits where activity_date between v_start and v_end
  )
  select count(*) into v_browsers from seen;

  with recursive seen as (
    select distinct visitor_hash as h from public.guest_analytics_visits where activity_date between v_start and v_end
  ), reach(root, h) as (
    select h, h from seen
    union
    select reach.root, case when l.hash_a = reach.h then l.hash_b else l.hash_a end
    from reach join public.guest_identity_links l on l.hash_a = reach.h or l.hash_b = reach.h
  )
  select count(distinct gid) into v_people from (select root, min(h) as gid from reach group by root) t;

  return jsonb_build_object('period', p_period, 'browsers', v_browsers, 'people', least(v_people, v_browsers));
end;
$$;

revoke all on function public.guest_signal_store(text,text,jsonb,text,text,text,text,text,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.guest_signal_candidates(text,text,text,text) from public, anon, authenticated;
revoke all on function public.guest_identity_link(text,text,numeric,jsonb) from public, anon, authenticated;
revoke all on function public.guest_final_id(text) from public, anon, authenticated;
revoke all on function public.guest_unique_people(text) from public, anon, authenticated;
grant execute on function public.guest_signal_store(text,text,jsonb,text,text,text,text,text,integer,integer,integer) to service_role;
grant execute on function public.guest_signal_candidates(text,text,text,text) to service_role;
grant execute on function public.guest_identity_link(text,text,numeric,jsonb) to service_role;
grant execute on function public.guest_final_id(text) to service_role;
grant execute on function public.guest_unique_people(text) to service_role;

commit;
