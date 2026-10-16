const { loadCoreSource } = require('./load-core');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'guest-cart'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() {}, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const visitorKey = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const productId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';

test('guest cart API rejects invalid methods and non-random browser keys', async () => {
  const a = recorder(); await handler({ method: 'GET', headers: {} }, a); assert.equal(a.out.status, 405);
  const b = recorder(); await handler({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey: 'screen-1440x900' } }, b); assert.equal(b.out.status, 400);
  assert.equal(b.out.body.error, 'invalid_browser_key');
});

test('resolve stores only server HMACs and returns this browser basket', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return response({ visitorId: productId, status: 'guest', cart: [{ sid: productId, storeProductId: productId, q: 2, productSnapshot: { name: 'private snapshot' } }] });
  };
  const res = recorder();
  await handler({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.visitorId, productId); assert.equal(res.out.body.cart[0].q, 2);
  assert.equal(Object.hasOwn(res.out.body.cart[0], 'productSnapshot'), false);
  assert.match(calls[0].url, /rpc\/resolve_guest_browser$/);
  const payload = JSON.parse(calls[0].options.body);
  assert.match(payload.p_fingerprint_hash, /^[a-f0-9]{64}$/); assert.match(payload.p_analytics_hash, /^[a-f0-9]{64}$/);
});

test('claim transfers both server HMACs with the authenticated customer ID', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response({ id: 'a6d53c31-c9d7-428a-82f4-c742bf923690' });
    return response({ claimed: true, cart: 2, items: 1 });
  };
  const res = recorder();
  await handler({ method: 'POST', headers: { authorization: 'Bearer unit-test-token' }, body: { action: 'claim', visitorKey } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.claimed, true);
  assert.match(calls[1].url, /rpc\/claim_guest_browser_cart$/);
  const payload = JSON.parse(calls[1].options.body);
  assert.match(payload.p_fingerprint_hash, /^[a-f0-9]{64}$/);
  assert.match(payload.p_analytics_hash, /^[a-f0-9]{64}$/);
  assert.equal(payload.p_user_id, 'a6d53c31-c9d7-428a-82f4-c742bf923690');
});

test('legacy guest activity route accepts cart removal and writes to the unified detailed ledger', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const calls = [];
  global.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return response(true); };
  const res = recorder();
  await handler({ method: 'POST', headers: {}, body: { action: 'track', visitorKey, eventType: 'cart_remove', productId } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.tracked, true);
  assert.match(calls[0].url, /rpc\/record_guest_product_activity$/);
  assert.equal(JSON.parse(calls[0].options.body).p_event_type, 'cart_remove');
});

test('guest capture is automatic, browser-local, and its migration keeps only isolated analytics after claim', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const identity = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');
  const core = loadCoreSource();
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261010014327_guest_browser_identity_analytics.sql'), 'utf8');
  assert.match(html, /guest-identity\.js\?v=[0-9A-Za-z-]+/);
  assert.match(identity, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(identity, /randomUUID/);
  assert.match(identity, /setTimeout\(function \(\) \{ startSession\(\)/);
  assert.doesNotMatch(identity, /navigator\.userAgent|screenWidth|fingerprint\(\)/);
  assert.match(identity, /track: track/);
  assert.match(core, /GuestIdentity\.claim/);
  assert.match(core, /trackGuestProduct\('cart_add'/);
  assert.match(core, /trackGuestProduct\('view'/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /guest_analytics_visits/);
  assert.match(migration, /guest_product_analytics/);
  assert.match(migration, /delete from public\.guest_visitors/i);
  assert.match(migration, /guest_analytics_summary/);
});
