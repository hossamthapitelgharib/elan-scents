begin;

-- Activity used to permit anonymous-device matching must come from server-recorded events,
-- not counters supplied by the browser. A qualifying session needs two validated product events
-- at least five seconds apart in the last 30 minutes, and must still be recently active.
create or replace function public.guest_signal_behavior(p_fingerprint_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_guest_id uuid;
  v_interactions bigint := 0;
  v_active_seconds bigint := 0;
begin
  if coalesce(p_fingerprint_hash, '') !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('interactions', 0, 'activeSeconds', 0);
  end if;

  select gv.id into v_guest_id
  from public.guest_visitors gv
  where gv.fingerprint_hash = p_fingerprint_hash
    and gv.status = 'guest'
    and gv.identity_version = 2;
  if v_guest_id is null then
    return jsonb_build_object('interactions', 0, 'activeSeconds', 0);
  end if;

  select coalesce(sum(e.event_count), 0), coalesce(max(e.span_seconds), 0)
    into v_interactions, v_active_seconds
  from (
    select count(*)::bigint as event_count,
           greatest(0, floor(extract(epoch from max(e.occurred_at) - min(e.occurred_at)))::bigint) as span_seconds
    from public.customer_product_events e
    join public.customer_sessions s on s.session_id = e.session_id
    where e.guest_id = v_guest_id
      and e.session_id is not null
      and e.occurred_at >= now() - interval '30 minutes'
      and s.guest_id = v_guest_id
      and s.ended_at is null
      and s.last_seen_at >= now() - interval '2 minutes'
    group by e.session_id
    having count(*) >= 2
       and max(e.occurred_at) - min(e.occurred_at) >= interval '5 seconds'
  ) e;

  return jsonb_build_object(
    'interactions', least(v_interactions, 100000),
    'activeSeconds', least(v_active_seconds, 86400)
  );
end;
$$;

revoke all on function public.guest_signal_behavior(text) from public, anon, authenticated;
grant execute on function public.guest_signal_behavior(text) to service_role;
comment on function public.guest_signal_behavior(text) is
  'Returns a conservative anonymous matching gate based on validated product events and active, server-timestamped sessions; ignores all browser-supplied activity counters.';

commit;
