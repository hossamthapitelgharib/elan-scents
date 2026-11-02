begin;

drop function if exists public.consume_edge_rate_limit(text, integer);
drop table if exists private.edge_rate_limit_buckets;

commit;
