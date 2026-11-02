begin;

create table private.edge_rate_limit_buckets (
  bucket_key text primary key check (bucket_key ~ '^[0-9a-f]{64}$'),
  hit_count bigint not null check (hit_count > 0),
  reset_at timestamptz not null
);

create index edge_rate_limit_buckets_reset_at_idx
  on private.edge_rate_limit_buckets (reset_at);

alter table private.edge_rate_limit_buckets enable row level security;
revoke all on table private.edge_rate_limit_buckets from public, anon, authenticated, service_role;

create or replace function public.consume_edge_rate_limit(p_bucket_key text, p_window_ms integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, private
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_reset_at timestamptz;
  v_count bigint;
  v_ttl_ms bigint;
  v_bucket numeric;
begin
  if p_bucket_key is null or p_bucket_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid rate-limit key';
  end if;
  if p_window_ms is null or p_window_ms < 1000 or p_window_ms > 86400000 then
    raise exception 'Invalid rate-limit window';
  end if;

  v_bucket := floor(extract(epoch from v_now) * 1000 / p_window_ms);
  v_reset_at := to_timestamp((v_bucket + 1) * p_window_ms / 1000.0);

  insert into private.edge_rate_limit_buckets (bucket_key, hit_count, reset_at)
  values (p_bucket_key, 1, v_reset_at)
  on conflict (bucket_key) do update
    set hit_count = case
          when private.edge_rate_limit_buckets.reset_at <= v_now then 1
          else private.edge_rate_limit_buckets.hit_count + 1
        end,
        reset_at = case
          when private.edge_rate_limit_buckets.reset_at <= v_now then excluded.reset_at
          else private.edge_rate_limit_buckets.reset_at
        end
  returning hit_count, greatest(1, ceil(extract(epoch from reset_at - clock_timestamp()) * 1000)::bigint)
  into v_count, v_ttl_ms;

  -- Opportunistic bounded cleanup; the HMAC key is uniformly distributed, so this runs about 1/256 calls.
  if left(p_bucket_key, 2) = '00' then
    delete from private.edge_rate_limit_buckets
    where bucket_key in (
      select bucket_key
      from private.edge_rate_limit_buckets
      where reset_at < v_now
      order by reset_at
      limit 500
    );
  end if;

  return jsonb_build_object('count', v_count, 'ttlMs', v_ttl_ms);
end;
$function$;

revoke all on function public.consume_edge_rate_limit(text, integer) from public, anon, authenticated;
grant execute on function public.consume_edge_rate_limit(text, integer) to service_role;

commit;
