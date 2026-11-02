const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261102201001_shared_rate_limit_buckets.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rollback', '20261102201001_shared_rate_limit_buckets.sql'), 'utf8');

test('shared rate-limit migration restricts bucket access and RPC execution to the server role', () => {
  assert.match(migration, /create table private\.edge_rate_limit_buckets/);
  assert.match(migration, /bucket_key text primary key check \(bucket_key ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(migration, /alter table private\.edge_rate_limit_buckets enable row level security/);
  assert.match(migration, /revoke all on table private\.edge_rate_limit_buckets from public, anon, authenticated, service_role/);
  assert.match(migration, /security definer[\s\S]*?set search_path = pg_catalog, private/);
  assert.match(migration, /grant execute on function public\.consume_edge_rate_limit\(text, integer\) to service_role/);
  assert.match(migration, /revoke all on function public\.consume_edge_rate_limit\(text, integer\) from public, anon, authenticated/);
  assert.match(migration, /limit 500/);
  assert.match(rollback, /drop function if exists public\.consume_edge_rate_limit/);
  assert.match(rollback, /drop table if exists private\.edge_rate_limit_buckets/);
});
