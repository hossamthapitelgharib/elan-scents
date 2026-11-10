const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migrationName = '20261110174755_guest_signal_server_trust.sql';
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', migrationName), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase', 'rollback', migrationName), 'utf8');
const api = fs.readFileSync(path.join(root, 'api', 'guest-cart.js'), 'utf8');
const browser = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');

test('the server-trust migration and rollback are transactional and change only one server-only RPC', () => {
  for (const sql of [migration, rollback]) {
    assert.match(sql, /^begin;/m);
    assert.match(sql, /^commit;/m);
  }
  assert.match(migration, /create or replace function public\.guest_signal_behavior\(p_fingerprint_hash text\)/i);
  assert.match(migration, /revoke all on function public\.guest_signal_behavior\(text\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.guest_signal_behavior\(text\) to service_role/i);
  assert.match(rollback, /drop function if exists public\.guest_signal_behavior\(text\)/i);
  assert.doesNotMatch(migration, /\b(delete|truncate)\s+from?\s+public\./i);
});

test('server behavior requires recent validated events spanning five seconds in one live session', () => {
  assert.match(migration, /public\.customer_product_events/);
  assert.match(migration, /public\.customer_sessions/);
  assert.match(migration, /e\.occurred_at >= now\(\) - interval '30 minutes'/);
  assert.match(migration, /s\.last_seen_at >= now\(\) - interval '2 minutes'/);
  assert.match(migration, /having count\(\*\) >= 2/);
  assert.match(migration, /max\(e\.occurred_at\) - min\(e\.occurred_at\) >= interval '5 seconds'/);
  assert.match(api, /rpc\/guest_signal_behavior/);
  assert.doesNotMatch(api, /body\.behavior/);
  assert.doesNotMatch(browser, /behaviorSnapshot|body\.behavior/);
});

test('device fingerprint and each part are keyed by the server before being stored', () => {
  assert.match(api, /h\('guest-device-fp', rawFp\)/);
  assert.match(api, /h\(`guest-device-part:\$\{key\}`, value\)/);
  assert.match(api, /p_fp_hash: fp, p_parts: parts/);
});

test('the existing 400-day scheduled retention path remains intact', () => {
  const rootMigrations = path.join(root, 'supabase', 'migrations');
  const retentionName = fs.readdirSync(rootMigrations).find((name) => name.endsWith('_guest_retention_delete_expired_guest_counters.sql'));
  assert.ok(retentionName);
  const retention = fs.readFileSync(path.join(rootMigrations, retentionName), 'utf8');
  assert.match(retention, /interval '400 days'/);
  assert.match(retention, /guest-fingerprint-retention-400d/);
});
