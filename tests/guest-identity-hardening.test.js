const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NAME = '20261025051356_guest_identity_hardening.sql';
const root = path.join(__dirname, '..');
const up = fs.readFileSync(path.join(root, 'supabase', 'migrations', NAME), 'utf8');
const down = fs.readFileSync(path.join(root, 'supabase', 'rollback', NAME), 'utf8');
const dbTest = fs.readFileSync(path.join(__dirname, 'guest-identity-hardening.test.sql'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api', 'guest-cart.js'), 'utf8');

test('the migration file is the statement recorded in the live ledger', () => {
  assert.equal(crypto.createHash('md5').update(up).digest('hex'), '993ac45b3af4940a3e2510ad4468ad53');
});

test('migration and rollback are single transactions', () => {
  for (const sql of [up, down]) {
    assert.match(sql, /^begin;/m);
    assert.match(sql, /^commit;/m);
  }
});

test('the legacy two-argument claim is dropped, restored by the rollback, and never called by the API', () => {
  assert.match(up, /drop function if exists public\.claim_guest_browser_cart\(text, uuid\);/);
  assert.match(down, /function public\.claim_guest_browser_cart\(p_fingerprint_hash text, p_user_id uuid\)/);
  assert.match(down, /revoke all on function public\.claim_guest_browser_cart\(text, uuid\) from public, anon, authenticated;/);
  assert.match(down, /grant execute on function public\.claim_guest_browser_cart\(text, uuid\) to service_role;/);
  assert.equal((api.match(/claim_guest_browser_cart/g) || []).length, 1, 'the API names the claim function once (the complete one)');
  assert.doesNotMatch(api, /p_user_id: user\.id \}\)/, 'no call with only two arguments is left');
});

test('one person never groups more than 8 browsers', () => {
  assert.match(up, /if v_size > 8 then return false; end if;/);
  assert.match(up, />= 5 then/);
});

test('exact fingerprint matches are ranked before recent look-alikes', () => {
  assert.match(up, /order by \(g\.fp_hash = p_fp_hash\) desc, g\.last_seen_at desc\s+limit 50/);
});

test('a fingerprint is stored only for a browser that already has a visit row', () => {
  assert.match(up, /from public\.guest_analytics_visits v where v\.visitor_hash = p_analytics_hash/);
});

test('new guests are capped per hour in both entry points, and existing guests are exempt', () => {
  const guard = /not exists \(select 1 from public\.guest_visitors where fingerprint_hash = p_fingerprint_hash\)\s+and \(select count\(\*\) from public\.guest_visitors where first_seen_at > now\(\) - interval '1 hour'\) >= 2000/g;
  assert.equal((up.match(guard) || []).length, 2, 'resolve_guest_browser and save_guest_browser_cart both carry the budget');
  assert.match(up, /create index if not exists guest_visitors_first_seen_idx on public\.guest_visitors \(first_seen_at desc\);/);
  assert.match(down, /drop index if exists public\.guest_visitors_first_seen_idx;/);
});

test('the guest functions stay server-only (create or replace keeps privileges, nothing is granted to clients)', () => {
  assert.doesNotMatch(up, /grant execute[^;]*\b(anon|authenticated)\b/i);
  assert.doesNotMatch(down, /grant execute[^;]*\b(anon|authenticated)\b/i);
});

test('the API tells the browser when a new guest was not recorded, without breaking its basket', async () => {
  const handler = require('../api/guest-cart.js');
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ visitorId: null, status: 'guest', cart: [], limited: true }) });
  const out = {};
  const res = {
    setHeader() { return this; },
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; }
  };
  try {
    await handler({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey: '0b4f5f0e-6a53-4d6a-9d58-7d2c9c0f0a11' } }, res);
  } finally { global.fetch = realFetch; }
  assert.equal(out.status, 200);
  assert.equal(out.body.limited, true);
  assert.deepEqual(out.body.cart, []);
  assert.equal(out.body.visitorId, null);
});

test('the real-database tests cover the changes and roll back', () => {
  for (const file of ['guest-identity-hardening.test.sql', 'guest-fingerprint-signals.test.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(sql, /^begin;/m, file);
    assert.match(sql, /^rollback;/m, file);
    assert.doesNotMatch(sql, /\bcommit\b\s*;/i, file);
  }
  for (const needle of ['claim_guest_browser_cart', 'guest_identity_link', 'guest_signal_candidates', 'guest_signal_store', 'resolve_guest_browser', 'save_guest_browser_cart', 'ALL CHECKS PASSED']) {
    assert.ok(dbTest.includes(needle), `the SQL test does not mention ${needle}`);
  }
});
