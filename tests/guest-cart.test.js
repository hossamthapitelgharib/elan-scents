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
    return response({ visitorId: productId, status: 'guest', cart: [{ sid: productId, storeProductId: productId, q: 2 }] });
  };
  const res = recorder();
  await handler({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.visitorId, productId); assert.equal(res.out.body.cart[0].q, 2);
  assert.match(calls[0].url, /rpc\/resolve_guest_browser$/);
  const payload = JSON.parse(calls[0].options.body);
  assert.match(payload.p_fingerprint_hash, /^[a-f0-9]{64}$/); assert.match(payload.p_analytics_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(payload.p_fingerprint_hash, payload.p_analytics_hash);
  assert.equal(JSON.stringify(payload).includes(visitorKey), false);
});

test('product activity sends product IDs only, not raw search phrases or browser data', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  let call;
  global.fetch = async (url, options = {}) => { call = { url: String(url), options }; return response(true); };
  const res = recorder();
  await handler({ method: 'POST', headers: {}, body: { action: 'track', visitorKey, eventType: 'search', productId, searchText: 'private phrase' } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.tracked, true);
  assert.match(call.url, /rpc\/record_guest_product_activity$/);
  const payload = JSON.parse(call.options.body);
  assert.equal(payload.p_event_type, 'search'); assert.equal(payload.p_product_id, productId);
  assert.equal(JSON.stringify(payload).includes(visitorKey), false);
  assert.equal(JSON.stringify(payload).includes('private phrase'), false);
});

test('claim verifies the account then calls the atomic transfer-and-delete RPC', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201'; const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response({ id: userId });
    if (String(url).endsWith('/rpc/claim_guest_browser_cart')) return response({ claimed: true, cart: 2 });
    throw new Error(`unexpected ${url}`);
  };
  const res = recorder();
  await handler({ method: 'POST', headers: { authorization: 'Bearer valid-customer-token' }, body: { action: 'claim', visitorKey } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.claimed, true); assert.equal(res.out.body.cart, 2);
  const claimCall = calls.find(call => call.url.endsWith('/rpc/claim_guest_browser_cart'));
  assert.ok(claimCall); const payload = JSON.parse(claimCall.options.body);
  assert.equal(payload.p_user_id, userId); assert.match(payload.p_fingerprint_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(payload).includes(visitorKey), false);
});

test('guest capture is automatic, browser-local, and its migration keeps only isolated analytics after claim', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const identity = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261010014327_guest_browser_identity_analytics.sql'), 'utf8');
  assert.match(html, /guest-identity\.js\?v=[0-9A-Za-z-]+/);
  assert.match(identity, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(identity, /randomUUID/);
  assert.match(identity, /setTimeout\(function \(\) \{ resolve\(\)/);
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

test('customer account page keeps the browser key script before account login logic', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'account.html'), 'utf8');
  const account = fs.readFileSync(path.join(__dirname, '..', 'account.js'), 'utf8');
  assert.match(html, /guest-identity\.js\?v=[0-9A-Za-z-]+/);
  assert.match(account, /GuestIdentity\.claim/);
});
