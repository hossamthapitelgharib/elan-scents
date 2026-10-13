const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-stores'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

test('platform stores API requires a platform admin and makes no store queries for customers', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let called = 0;
  global.fetch = async url => { called++; return String(url).includes('/auth/v1/user') ? response({ id: adminId }) : response([{ id: adminId, role: 'customer' }]); };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer customer-token' } }, res);
  assert.equal(res.out.status, 403);
  assert.equal(called, 2);
});

test('platform stores API returns store-only aggregates without customer order details', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url); requests.push({ url: value, options });
    if (value.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (value.includes('/rest/v1/profiles?')) return response([{ id: adminId, role: 'platform_admin' }]);
    if (value.includes('/rest/v1/stores?')) return response([{ id: storeId, name: 'Store A', status: 'active', commission_rate: 8 }]);
    if (value.endsWith('/rest/v1/rpc/platform_store_summary')) return response([{ store_id: storeId, linked_accounts: 2, product_count: 12, available_product_count: 10, active_offer_count: 3, order_request_count: 9, open_order_count: 2, review_order_count: 1, shipment_count: 5 }]);
    throw new Error(`unexpected ${value}`);
  };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' } }, res);
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.stores[0].summary.review_order_count, 1);
  assert.equal(res.out.body.count, 1);
  assert.ok(requests.some(request => request.url.endsWith('/rest/v1/rpc/platform_store_summary')));
  assert.ok(!requests.some(request => /customer_name|customer_phone|customer_address/.test(request.url)));
});
