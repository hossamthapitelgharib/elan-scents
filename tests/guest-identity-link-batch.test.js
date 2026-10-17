const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api', 'guest-cart.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'pending', '20261017024500_batch_guest_identity_links.sql'), 'utf8');
const sqlTest = fs.readFileSync(path.join(__dirname, 'guest-identity-link-batch.sql'), 'utf8');

test('guest identify batches accepted links and preserves a pre-migration fallback', () => {
  assert.match(api, /links\.push\(\{\s*a:\s*analyticsUse,\s*b:\s*c\.analyticsHash/s);
  assert.match(api, /rpc\/guest_identity_link_many/);
  assert.match(api, /rpc\/guest_identity_link'\s*,\s*\{\s*p_a:\s*link\.a/);
  assert.match(api, /for \(const link of links\)/);
});

test('batch RPC is service-role-only, bounds payload size, and delegates each edge to the existing validator', () => {
  assert.match(migration, /create or replace function public\.guest_identity_link_many\(p_links jsonb\)/i);
  assert.match(migration, /jsonb_array_length\(p_links\) > 50/i);
  assert.match(migration, /guest_identity_link\(v_a, v_b, v_score, v_reasons\)/i);
  assert.match(migration, /revoke all on function public\.guest_identity_link_many\(jsonb\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.guest_identity_link_many\(jsonb\) to service_role/i);
});

test('the SQL integration fixture uses fake hashes and always rolls back', () => {
  assert.match(sqlTest, /^-- يُشغّل بعد/m);
  assert.match(sqlTest, /md5\('identity-batch-/);
  assert.match(sqlTest, /guest_identity_link_many/);
  assert.match(sqlTest, /rollback\s*;\s*$/i);
});
