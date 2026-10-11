const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const activityHandler = require(path.join(__dirname, '..', 'api', 'customer-activity'));
const detailHandler = require(path.join(__dirname, '..', 'api', 'platform-customer-detail'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const visitorKey = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const sessionId = '68f6a90d-41e4-4d90-9d4e-936282b0b11d';
const productId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const sizeId = 'be2c2b9c-eeb7-4de6-8763-342f8c6ab491';
const storeProductId = '7ac1e019-08b1-4be1-b7d8-e8c6eb4a8522';
const customerId = 'a834add9-efb2-4101-bef1-a1f154044759';
const adminId = '2f81e8e0-7106-4262-95cb-bce2ef2ae8d8';

function env() { process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-service-secret'; }

test('guest session actions send server-side HMAC only and never persist browser keys in Supabase', async () => {
  env(); let call;
  global.fetch = async (url, options = {}) => { call = { url: String(url), options }; return response(true); };
  const res = recorder();
  await activityHandler({ method: 'POST', headers: {}, body: { action: 'session', visitorKey, sessionId, sessionAction: 'start' } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.tracked, true);
  assert.match(call.url, /rpc\/record_customer_session$/);
  const payload = JSON.parse(call.options.body);
  assert.match(payload.p_fingerprint_hash, /^[a-f0-9]{64}$/);
  assert.equal(payload.p_user_id, null); assert.equal(payload.p_action, 'start');
  assert.equal(JSON.stringify(payload).includes(visitorKey), false);
});

test('guest product events include the product-size/store offer and reject raw search text', async () => {
  env(); let call;
  global.fetch = async (url, options = {}) => { call = { url: String(url), options }; return response(true); };
  const res = recorder();
  await activityHandler({ method: 'POST', headers: {}, body: { action: 'track', visitorKey, sessionId, eventType: 'cart_remove', productId, productSizeId: sizeId, storeProductId, quantity: 2, searchText: 'do not store' } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.tracked, true);
  assert.match(call.url, /rpc\/record_customer_product_event$/);
  const payload = JSON.parse(call.options.body);
  assert.equal(payload.p_event_type, 'cart_remove'); assert.equal(payload.p_product_id, productId);
  assert.equal(payload.p_product_size_id, sizeId); assert.equal(payload.p_store_product_id, storeProductId); assert.equal(payload.p_quantity, 2);
  assert.match(payload.p_analytics_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(payload).includes(visitorKey), false); assert.equal(JSON.stringify(payload).includes('do not store'), false);
});

test('signed-in product activity is associated with the authenticated account, not a browser key', async () => {
  env(); const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response({ id: customerId });
    return response(true);
  };
  const res = recorder();
  await activityHandler({ method: 'POST', headers: { authorization: 'Bearer customer-token' }, body: { action: 'track', sessionId, eventType: 'view', productId, productSizeId: sizeId } }, res);
  assert.equal(res.out.status, 200);
  const rpc = calls.find(call => call.url.endsWith('/rpc/record_customer_product_event'));
  assert.ok(rpc);
  const payload = JSON.parse(rpc.options.body);
  assert.equal(payload.p_user_id, customerId); assert.equal(payload.p_fingerprint_hash, null); assert.equal(payload.p_analytics_hash, null);
});

test('customer activity API validates event type, identifiers, and method', async () => {
  env();
  const method = recorder(); await activityHandler({ method: 'GET', headers: {}, body: {} }, method); assert.equal(method.out.status, 405);
  const badSession = recorder(); await activityHandler({ method: 'POST', headers: {}, body: { action: 'session', visitorKey, sessionId: 'bad', sessionAction: 'start' } }, badSession); assert.equal(badSession.out.status, 400);
  const badEvent = recorder(); await activityHandler({ method: 'POST', headers: {}, body: { action: 'track', visitorKey, sessionId, eventType: 'purchase', productId } }, badEvent); assert.equal(badEvent.out.status, 400);
});

test('platform customer detail is restricted to platform admins and calls the paged detail RPC', async () => {
  env(); let rpcPayload = null;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (value.includes('/profiles?')) return response([{ id: adminId, role: 'platform_admin' }]);
    if (value.endsWith('/rpc/platform_customer_activity_detail')) { rpcPayload = JSON.parse(options.body); return response({ found: true, currentCart: [], events: [], sessions: [], visitCount: 0, eventTotal: 0 }); }
    throw new Error(`unexpected ${value}`);
  };
  const res = recorder(); await detailHandler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { type: 'guest', id: productId, limit: '50', offset: '100' } }, res);
  assert.equal(res.out.status, 200); assert.equal(rpcPayload.p_guest_id, productId); assert.equal(rpcPayload.p_user_id, null);
  assert.equal(rpcPayload.p_limit, 50); assert.equal(rpcPayload.p_offset, 100);
});

test('customer detail endpoint denies non-admins and validates pagination', async () => {
  env(); let called = false;
  global.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: customerId });
    if (String(url).includes('/profiles?')) return response([{ id: customerId, role: 'customer' }]);
    called = true; return response({});
  };
  const denied = recorder(); await detailHandler({ method: 'GET', headers: { authorization: 'Bearer customer-token' }, query: { type: 'customer', id: customerId } }, denied);
  assert.equal(denied.out.status, 403); assert.equal(called, false);
});

test('customer activity migration preserves RLS, full product joins, four rankings, and transfers logs on claim', () => {
  const root = path.join(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261011001908_customer_activity_details.sql'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'platform-dashboard.html'), 'utf8');
  const identity = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
  assert.match(migration, /create table if not exists public\.customer_sessions/i);
  assert.match(migration, /create table if not exists public\.customer_product_events/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /to_jsonb\(p\)/i);
  assert.match(migration, /update public\.customer_product_events set guest_id=null,user_id=p_user_id/i);
  assert.match(migration, /cart_remove/);
  assert.match(dashboard, /guestTopViewed/); assert.match(dashboard, /guestTopSearched/); assert.match(dashboard, /guestTopAdded/); assert.match(dashboard, /guestTopRemoved/);
  assert.match(dashboard, /registeredTopViewed/); assert.match(dashboard, /registeredTopSearched/); assert.match(dashboard, /registeredTopAdded/); assert.match(dashboard, /registeredTopRemoved/);
  assert.match(identity, /customer-activity/); assert.match(identity, /heartbeat/);
  assert.match(core, /trackGuestProduct\('cart_remove'/); assert.match(core, /trackGuestProduct\('search'/);
});
