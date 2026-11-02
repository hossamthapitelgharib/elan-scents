-- Run after migration as the project owner. Every state change is rolled back.
begin;

do $test$
declare
  v_key text := repeat('a', 64);
  v_first jsonb;
  v_second jsonb;
  v_hits bigint;
begin
  v_first := public.consume_edge_rate_limit(v_key, 60000);
  v_second := public.consume_edge_rate_limit(v_key, 60000);

  assert (v_first->>'count')::bigint = 1, 'first atomic hit is one';
  assert (v_second->>'count')::bigint = 2, 'second atomic hit increments';
  assert (v_second->>'ttlMs')::bigint > 0, 'window has positive remaining time';

  select hit_count into v_hits
  from private.edge_rate_limit_buckets
  where bucket_key = v_key
  limit 1;
  assert v_hits = 2, 'database row contains the serialized count';

  assert not has_function_privilege('anon', 'public.consume_edge_rate_limit(text,integer)', 'EXECUTE'), 'anon cannot execute the counter';
  assert not has_function_privilege('authenticated', 'public.consume_edge_rate_limit(text,integer)', 'EXECUTE'), 'authenticated cannot execute the counter';
  assert has_function_privilege('service_role', 'public.consume_edge_rate_limit(text,integer)', 'EXECUTE'), 'service_role can execute the counter';
  assert not has_table_privilege('anon', 'private.edge_rate_limit_buckets', 'SELECT'), 'anon cannot read buckets';
  assert not has_table_privilege('authenticated', 'private.edge_rate_limit_buckets', 'SELECT'), 'authenticated cannot read buckets';
  assert not has_table_privilege('service_role', 'private.edge_rate_limit_buckets', 'SELECT'), 'service_role cannot bypass the RPC';
end;
$test$;

rollback;
