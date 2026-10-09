const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'guest-cart'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() {}, json(body) { out.body = body; return this; } }; }
const uuid = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';

test('guest cart API refuses non-POST and malformed browser feature payloads', async () => {
  const a = recorder(); await handler({ method: 'GET', headers: {} }, a); assert.equal(a.out.status, 405);
  const b = recorder(); await handler({ method: 'POST', headers: {}, body: { action: 'resolve', fingerprint: {} } }, b); assert.equal(b.out.status, 400);
});

test('guest cart API uses server-side HMAC and creates/returns only a guest cart snapshot', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const calls = []; global.fetch = async (url, options = {}) => { calls.push({ url, options }); return new Response(JSON.stringify([{ id: uuid, cart_snapshot: [{ sid: uuid, storeProductId: uuid, q: 2 }], status: 'guest' }]), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  const res = recorder(); await handler({ method: 'POST', headers: {}, body: { action: 'resolve', fingerprint: { platform: 'x', language: 'ar', screenWidth: 1440, screenHeight: 900 } } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.visitorId, uuid); assert.equal(res.out.body.cart[0].q, 2);
  assert.match(calls[0].url, /guest_visitors\?on_conflict=fingerprint_hash/); assert.match(calls[0].options.headers.Prefer, /resolution=merge-duplicates/);
  assert.equal(JSON.stringify(calls[0].options.body).includes('1440'), false);
});


test('visitor consent is explicit and guest carts are claimed after login', () => {
  const html = require('node:fs').readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const identity = require('node:fs').readFileSync(path.join(__dirname, '..', 'guest-identity.js'), 'utf8');
  const core = require('node:fs').readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
  const migration = require('node:fs').readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261009052500_guest_visitors.sql'), 'utf8');
  assert.match(html, /guest-identity\.js\?v=20261009-8/);
  assert.match(identity, /المتابعة على هذا المتصفح فقط/);
  assert.match(core, /GuestIdentity\.claim/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /guest_visitors_platform_admin_read/);
});


test('guest cart claim transfers items to the logged-in user and anonymizes the visitor record', async () => {
  const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
  const calls = []; let inserted; let marked;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: userId }), { status: 200 });
    if (url.includes('/rest/v1/guest_visitors?select=')) return new Response(JSON.stringify([{ id: uuid, status: 'guest', converted_user_id: null, cart_snapshot: [{ sid: uuid, storeProductId: uuid, q: 3 }] }]), { status: 200 });
    if (url.includes('/rest/v1/cart_items?select=')) return new Response('[]', { status: 200 });
    if (url.endsWith('/rest/v1/cart_items') && options.method === 'POST') { inserted = JSON.parse(options.body); return new Response(null, { status: 201 }); }
    if (url.includes('/rest/v1/guest_visitors?id=') && options.method === 'PATCH') { marked = JSON.parse(options.body); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected ${url}`);
  };
  const res = recorder();
  await handler({ method: 'POST', headers: { authorization: 'Bearer valid-customer-token' }, body: { action: 'claim', fingerprint: { platform: 'x', language: 'ar', screenWidth: 1440, screenHeight: 900 } } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.claimed, true);
  assert.equal(inserted.user_id, userId); assert.equal(inserted.store_product_id, uuid); assert.equal(inserted.quantity, 3);
  assert.equal(marked.status, 'converted'); assert.equal(marked.fingerprint_hash, null); assert.deepEqual(marked.cart_snapshot, []);
  assert.ok(calls.every(call => !String(call.options.headers?.apikey || '').includes('unit-test-server-secret') || call.options.headers.apikey === 'unit-test-server-secret'));
});
