begin;

-- A short-lived, server-only barrier for browser identities that were refused or claimed.
-- Values are purpose-separated HMACs, never the raw browser UUID or raw fingerprint.
create table private.guest_identity_blocks (
  fingerprint_hash text primary key check (fingerprint_hash ~ '^[a-f0-9]{64}$'),
  analytics_hash text not null unique check (analytics_hash ~ '^[a-f0-9]{64}$'),
  reason text not null check (reason in ('refused', 'claimed')),
  blocked_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at > blocked_at)
);
create index guest_identity_blocks_expiry_idx on private.guest_identity_blocks (expires_at);
alter table private.guest_identity_blocks enable row level security;
revoke all on table private.guest_identity_blocks from public, anon, authenticated, service_role;

create or replace function private.guest_identity_lock(p_fingerprint_hash text, p_analytics_hash text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, pg_temp
as $$
begin
  -- Every writer takes the same pair in the same order. A forget waits for an earlier write,
  -- then deletes it; a later write waits for forget and sees the block.
  if coalesce(p_fingerprint_hash, '') ~ '^[a-f0-9]{64}$' then
    perform pg_advisory_xact_lock(hashtextextended('guest-fingerprint:' || p_fingerprint_hash, 0));
  end if;
  if coalesce(p_analytics_hash, '') ~ '^[a-f0-9]{64}$' then
    perform pg_advisory_xact_lock(hashtextextended('guest-analytics:' || p_analytics_hash, 0));
  end if;
end;
$$;

create or replace function private.guest_identity_lock_merge(
  p_from_fingerprint text, p_to_fingerprint text,
  p_from_analytics text, p_to_analytics text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, pg_temp
as $$
declare v_hash text;
begin
  for v_hash in
    select distinct h from unnest(array[p_from_fingerprint, p_to_fingerprint]) as x(h)
    where coalesce(h, '') ~ '^[a-f0-9]{64}$' order by h
  loop
    perform pg_advisory_xact_lock(hashtextextended('guest-fingerprint:' || v_hash, 0));
  end loop;
  for v_hash in
    select distinct h from unnest(array[p_from_analytics, p_to_analytics]) as x(h)
    where coalesce(h, '') ~ '^[a-f0-9]{64}$' order by h
  loop
    perform pg_advisory_xact_lock(hashtextextended('guest-analytics:' || v_hash, 0));
  end loop;
end;
$$;

create or replace function private.guest_identity_lock_analytics_pair(p_a text, p_b text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, pg_temp
as $$
declare v_hash text;
begin
  for v_hash in
    select distinct h from unnest(array[p_a, p_b]) as x(h)
    where coalesce(h, '') ~ '^[a-f0-9]{64}$' order by h
  loop
    perform pg_advisory_xact_lock(hashtextextended('guest-analytics:' || v_hash, 0));
  end loop;
end;
$$;

create or replace function private.guest_identity_lock_links(p_links jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, pg_temp
as $$
declare v_hash text;
begin
  if jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' then return; end if;
  for v_hash in
    select distinct candidate.hash_value
    from jsonb_array_elements(p_links) as link(value)
    cross join lateral (values (link.value->>'a'), (link.value->>'b')) as candidate(hash_value)
    where coalesce(candidate.hash_value, '') ~ '^[a-f0-9]{64}$'
    order by candidate.hash_value
  loop
    perform pg_advisory_xact_lock(hashtextextended('guest-analytics:' || v_hash, 0));
  end loop;
end;
$$;

create or replace function private.guest_identity_is_blocked(p_fingerprint_hash text, p_analytics_hash text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, private, pg_temp
as $$
begin
  -- VOLATILE is intentional: after advisory-lock wait, READ COMMITTED must take a fresh snapshot
  -- so this check sees a tombstone committed by the transaction that held the same lock first.
  return exists (
    select 1 from private.guest_identity_blocks b
    where b.expires_at > clock_timestamp()
      and ((coalesce(p_fingerprint_hash, '') <> '' and b.fingerprint_hash = p_fingerprint_hash)
        or (coalesce(p_analytics_hash, '') <> '' and b.analytics_hash = p_analytics_hash))
  );
end;
$$;

revoke all on function private.guest_identity_lock(text, text) from public, anon, authenticated, service_role;
revoke all on function private.guest_identity_lock_merge(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.guest_identity_lock_analytics_pair(text, text) from public, anon, authenticated, service_role;
revoke all on function private.guest_identity_lock_links(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.guest_identity_is_blocked(text, text) from public, anon, authenticated, service_role;

-- Replace public RPCs with small SECURITY DEFINER gates. Their original implementations remain
-- private-by-ACL under a different name; all existing business validation and write logic is kept.
alter function public.forget_guest_browser(text, text) rename to forget_guest_browser_pre_barrier_20261114;
revoke all on function public.forget_guest_browser_pre_barrier_20261114(text, text) from public, anon, authenticated, service_role;
create function public.forget_guest_browser(p_fingerprint_hash text, p_analytics_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$' then
    return public.forget_guest_browser_pre_barrier_20261114(p_fingerprint_hash, p_analytics_hash);
  end if;
  perform private.guest_identity_lock(p_fingerprint_hash, p_analytics_hash);
  insert into private.guest_identity_blocks(fingerprint_hash, analytics_hash, reason, blocked_at, expires_at)
  values (p_fingerprint_hash, p_analytics_hash, 'refused', clock_timestamp(), clock_timestamp() + interval '24 hours')
  on conflict (fingerprint_hash) do update
    set analytics_hash = excluded.analytics_hash, reason = 'refused', blocked_at = excluded.blocked_at, expires_at = excluded.expires_at;
  return public.forget_guest_browser_pre_barrier_20261114(p_fingerprint_hash, p_analytics_hash);
end;
$$;
revoke all on function public.forget_guest_browser(text, text) from public, anon, authenticated;
grant execute on function public.forget_guest_browser(text, text) to service_role;

alter function public.resolve_guest_browser(text, text) rename to resolve_guest_browser_pre_barrier_20261114;
revoke all on function public.resolve_guest_browser_pre_barrier_20261114(text, text) from public, anon, authenticated, service_role;
create function public.resolve_guest_browser(p_fingerprint_hash text, p_analytics_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  perform private.guest_identity_lock(p_fingerprint_hash, p_analytics_hash);
  if private.guest_identity_is_blocked(p_fingerprint_hash, p_analytics_hash) then
    return jsonb_build_object('blocked', true, 'visitorId', null, 'status', 'guest', 'cart', '[]'::jsonb);
  end if;
  return public.resolve_guest_browser_pre_barrier_20261114(p_fingerprint_hash, p_analytics_hash);
end;
$$;
revoke all on function public.resolve_guest_browser(text, text) from public, anon, authenticated;
grant execute on function public.resolve_guest_browser(text, text) to service_role;

alter function public.save_guest_browser_cart(text, text, jsonb) rename to save_guest_browser_cart_pre_barrier_20261114;
revoke all on function public.save_guest_browser_cart_pre_barrier_20261114(text, text, jsonb) from public, anon, authenticated, service_role;
create function public.save_guest_browser_cart(p_fingerprint_hash text, p_analytics_hash text, p_cart_snapshot jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  perform private.guest_identity_lock(p_fingerprint_hash, p_analytics_hash);
  if private.guest_identity_is_blocked(p_fingerprint_hash, p_analytics_hash) then
    return jsonb_build_object('blocked', true, 'visitorId', null, 'status', 'guest', 'cart', '[]'::jsonb);
  end if;
  return public.save_guest_browser_cart_pre_barrier_20261114(p_fingerprint_hash, p_analytics_hash, p_cart_snapshot);
end;
$$;
revoke all on function public.save_guest_browser_cart(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_guest_browser_cart(text, text, jsonb) to service_role;

alter function public.merge_guest_browser(text, text, text, text) rename to merge_guest_browser_pre_barrier_20261114;
revoke all on function public.merge_guest_browser_pre_barrier_20261114(text, text, text, text) from public, anon, authenticated, service_role;
create function public.merge_guest_browser(p_from_fingerprint text, p_to_fingerprint text, p_from_analytics text, p_to_analytics text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  perform private.guest_identity_lock_merge(p_from_fingerprint, p_to_fingerprint, p_from_analytics, p_to_analytics);
  if private.guest_identity_is_blocked(p_from_fingerprint, p_from_analytics)
     or private.guest_identity_is_blocked(p_to_fingerprint, p_to_analytics) then
    return jsonb_build_object('merged', false, 'reason', 'blocked');
  end if;
  return public.merge_guest_browser_pre_barrier_20261114(p_from_fingerprint, p_to_fingerprint, p_from_analytics, p_to_analytics);
end;
$$;
revoke all on function public.merge_guest_browser(text, text, text, text) from public, anon, authenticated;
grant execute on function public.merge_guest_browser(text, text, text, text) to service_role;

alter function public.claim_guest_browser_cart(text, text, uuid) rename to claim_guest_browser_cart_pre_barrier_20261114;
revoke all on function public.claim_guest_browser_cart_pre_barrier_20261114(text, text, uuid) from public, anon, authenticated, service_role;
create function public.claim_guest_browser_cart(p_fingerprint_hash text, p_analytics_hash text, p_user_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare v_result jsonb;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$'
     or coalesce(p_analytics_hash, '') !~ '^[a-f0-9]{64}$'
     or not exists (select 1 from public.profiles pr where pr.id = p_user_id and pr.role = 'customer') then
    return public.claim_guest_browser_cart_pre_barrier_20261114(p_fingerprint_hash, p_analytics_hash, p_user_id);
  end if;
  perform private.guest_identity_lock(p_fingerprint_hash, p_analytics_hash);
  if private.guest_identity_is_blocked(p_fingerprint_hash, p_analytics_hash) then
    return jsonb_build_object('claimed', false, 'cart', 0, 'blocked', true);
  end if;
  v_result := public.claim_guest_browser_cart_pre_barrier_20261114(p_fingerprint_hash, p_analytics_hash, p_user_id);
  insert into private.guest_identity_blocks(fingerprint_hash, analytics_hash, reason, blocked_at, expires_at)
  values (p_fingerprint_hash, p_analytics_hash, 'claimed', clock_timestamp(), clock_timestamp() + interval '24 hours')
  on conflict (fingerprint_hash) do update
    set analytics_hash = excluded.analytics_hash, reason = 'claimed', blocked_at = excluded.blocked_at, expires_at = excluded.expires_at;
  return v_result;
end;
$$;
revoke all on function public.claim_guest_browser_cart(text, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_guest_browser_cart(text, text, uuid) to service_role;

alter function public.record_customer_session(text, uuid, uuid, text) rename to record_customer_session_pre_barrier_20261114;
revoke all on function public.record_customer_session_pre_barrier_20261114(text, uuid, uuid, text) from public, anon, authenticated, service_role;
create function public.record_customer_session(p_fingerprint_hash text, p_user_id uuid, p_session_id uuid, p_action text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if p_user_id is null then
    perform private.guest_identity_lock(p_fingerprint_hash, null);
    if private.guest_identity_is_blocked(p_fingerprint_hash, null) then return false; end if;
  end if;
  return public.record_customer_session_pre_barrier_20261114(p_fingerprint_hash, p_user_id, p_session_id, p_action);
end;
$$;
revoke all on function public.record_customer_session(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_customer_session(text, uuid, uuid, text) to service_role;

alter function public.record_customer_product_event(text, text, uuid, uuid, text, uuid, uuid, uuid, integer) rename to record_customer_product_event_pre_barrier_20261114;
revoke all on function public.record_customer_product_event_pre_barrier_20261114(text, text, uuid, uuid, text, uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;
create function public.record_customer_product_event(
  p_fingerprint_hash text, p_analytics_hash text, p_user_id uuid, p_session_id uuid,
  p_event_type text, p_product_id uuid, p_product_size_id uuid, p_store_product_id uuid, p_quantity integer
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if p_user_id is null then
    perform private.guest_identity_lock(p_fingerprint_hash, p_analytics_hash);
    if private.guest_identity_is_blocked(p_fingerprint_hash, p_analytics_hash) then return false; end if;
  end if;
  return public.record_customer_product_event_pre_barrier_20261114(
    p_fingerprint_hash, p_analytics_hash, p_user_id, p_session_id,
    p_event_type, p_product_id, p_product_size_id, p_store_product_id, p_quantity
  );
end;
$$;
revoke all on function public.record_customer_product_event(text, text, uuid, uuid, text, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.record_customer_product_event(text, text, uuid, uuid, text, uuid, uuid, uuid, integer) to service_role;

alter function public.record_customer_search(text, text, uuid, uuid, text, jsonb) rename to record_customer_search_pre_barrier_20261114;
revoke all on function public.record_customer_search_pre_barrier_20261114(text, text, uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
create function public.record_customer_search(
  p_fingerprint_hash text, p_analytics_hash text, p_user_id uuid, p_session_id uuid, p_search_text text, p_results jsonb
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if p_user_id is null then
    perform private.guest_identity_lock(p_fingerprint_hash, p_analytics_hash);
    if private.guest_identity_is_blocked(p_fingerprint_hash, p_analytics_hash) then return false; end if;
  end if;
  return public.record_customer_search_pre_barrier_20261114(
    p_fingerprint_hash, p_analytics_hash, p_user_id, p_session_id, p_search_text, p_results
  );
end;
$$;
revoke all on function public.record_customer_search(text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_customer_search(text, text, uuid, uuid, text, jsonb) to service_role;

alter function public.record_guest_product_activity(text, text, uuid, text) rename to record_guest_product_activity_pre_barrier_20261114;
revoke all on function public.record_guest_product_activity_pre_barrier_20261114(text, text, uuid, text) from public, anon, authenticated, service_role;
create function public.record_guest_product_activity(p_fingerprint_hash text, p_analytics_hash text, p_product_id uuid, p_event_type text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  perform private.guest_identity_lock(p_fingerprint_hash, p_analytics_hash);
  if private.guest_identity_is_blocked(p_fingerprint_hash, p_analytics_hash) then return false; end if;
  return public.record_guest_product_activity_pre_barrier_20261114(p_fingerprint_hash, p_analytics_hash, p_product_id, p_event_type);
end;
$$;
revoke all on function public.record_guest_product_activity(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_guest_product_activity(text, text, uuid, text) to service_role;

alter function public.guest_signal_store(text, text, jsonb, text, text, text, text, text, integer, integer, integer) rename to guest_signal_store_pre_barrier_20261114;
revoke all on function public.guest_signal_store_pre_barrier_20261114(text, text, jsonb, text, text, text, text, text, integer, integer, integer) from public, anon, authenticated, service_role;
create function public.guest_signal_store(
  p_analytics_hash text, p_fp_hash text, p_parts jsonb, p_ip_hash text, p_ip_prefix_hash text,
  p_ua_hash text, p_lang_hash text, p_cart_hash text, p_interactions integer, p_active_seconds integer, p_pages integer
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  perform private.guest_identity_lock(null, p_analytics_hash);
  if private.guest_identity_is_blocked(null, p_analytics_hash) then return false; end if;
  return public.guest_signal_store_pre_barrier_20261114(
    p_analytics_hash, p_fp_hash, p_parts, p_ip_hash, p_ip_prefix_hash,
    p_ua_hash, p_lang_hash, p_cart_hash, p_interactions, p_active_seconds, p_pages
  );
end;
$$;
revoke all on function public.guest_signal_store(text, text, jsonb, text, text, text, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.guest_signal_store(text, text, jsonb, text, text, text, text, text, integer, integer, integer) to service_role;

alter function public.guest_identity_link(text, text, numeric, jsonb) rename to guest_identity_link_pre_barrier_20261114;
revoke all on function public.guest_identity_link_pre_barrier_20261114(text, text, numeric, jsonb) from public, anon, authenticated, service_role;
create function public.guest_identity_link(p_a text, p_b text, p_score numeric, p_reasons jsonb)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  perform private.guest_identity_lock_analytics_pair(p_a, p_b);
  if private.guest_identity_is_blocked(null, p_a) or private.guest_identity_is_blocked(null, p_b) then return false; end if;
  return public.guest_identity_link_pre_barrier_20261114(p_a, p_b, p_score, p_reasons);
end;
$$;
revoke all on function public.guest_identity_link(text, text, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.guest_identity_link(text, text, numeric, jsonb) to service_role;

alter function public.guest_identity_link_many(jsonb) rename to guest_identity_link_many_pre_barrier_20261114;
revoke all on function public.guest_identity_link_many_pre_barrier_20261114(jsonb) from public, anon, authenticated, service_role;
create function public.guest_identity_link_many(p_links jsonb)
returns integer language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare v_allowed jsonb;
begin
  perform private.guest_identity_lock_links(p_links);
  if jsonb_typeof(coalesce(p_links, '[]'::jsonb)) <> 'array' then return 0; end if;
  select coalesce(jsonb_agg(link.value), '[]'::jsonb) into v_allowed
  from jsonb_array_elements(p_links) as link(value)
  where not private.guest_identity_is_blocked(null, link.value->>'a')
    and not private.guest_identity_is_blocked(null, link.value->>'b');
  return public.guest_identity_link_many_pre_barrier_20261114(v_allowed);
end;
$$;
revoke all on function public.guest_identity_link_many(jsonb) from public, anon, authenticated;
grant execute on function public.guest_identity_link_many(jsonb) to service_role;

alter function public.guest_signal_behavior(text) rename to guest_signal_behavior_pre_barrier_20261114;
revoke all on function public.guest_signal_behavior_pre_barrier_20261114(text) from public, anon, authenticated, service_role;
create function public.guest_signal_behavior(p_fingerprint_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  perform private.guest_identity_lock(p_fingerprint_hash, null);
  if private.guest_identity_is_blocked(p_fingerprint_hash, null) then
    return jsonb_build_object('interactions', 0, 'activeSeconds', 0);
  end if;
  return public.guest_signal_behavior_pre_barrier_20261114(p_fingerprint_hash);
end;
$$;
revoke all on function public.guest_signal_behavior(text) from public, anon, authenticated;
grant execute on function public.guest_signal_behavior(text) to service_role;

alter function public.purge_expired_guest_fingerprints(interval) rename to purge_expired_guest_fingerprints_pre_barrier_20261114;
revoke all on function public.purge_expired_guest_fingerprints_pre_barrier_20261114(interval) from public, anon, authenticated, service_role;
create function public.purge_expired_guest_fingerprints(p_retention interval default interval '400 days')
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare v_result jsonb;
begin
  v_result := public.purge_expired_guest_fingerprints_pre_barrier_20261114(p_retention);
  delete from private.guest_identity_blocks where expires_at <= clock_timestamp();
  return v_result;
end;
$$;
revoke all on function public.purge_expired_guest_fingerprints(interval) from public, anon, authenticated;
grant execute on function public.purge_expired_guest_fingerprints(interval) to service_role;

comment on table private.guest_identity_blocks is
  'Short-lived service-only HMAC tombstones for refused or claimed browser identities. Expires after 24 hours to reject delayed in-flight writes, then the existing daily guest-retention job removes the rows. Never stores raw browser identifiers or fingerprint inputs.';

notify pgrst, 'reload schema';
commit;
