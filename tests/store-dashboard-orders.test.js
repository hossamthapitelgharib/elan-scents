const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'store-dashboard-orders'));

const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
function response(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
function recorder() {
  const out = { headers: {} };
  return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } };
}
async function run(role, query, database) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: userId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: userId, role }]);
    return database(url, options);
  };
  const res = recorder();
  await handler({ method: 'GET', query, headers: { authorization: 'Bearer test-token' } }, res);
  return { res: res.out, calls };
}

const privateOrder = {
  id: 'request-1', store_id: storeId, tracking_number: 'TRK-1', checkout_tracking_number: 'ELAN-1',
  customer_name: 'اسم العميل', customer_phone: '01000000000', customer_address: 'عنوان التسليم',
  customer_email: 'private@example.test', customer_notes: 'private note', status: 'processing', subtotal: 1000,
  shipping_amount: 50, total_amount: 1050, currency: 'EGP', reconciliation_status: 'matched',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', initial_payload: { private: true },
  stores: { name: 'متجر تجريبي', private_field: 'must-not-return' },
  store_order_request_items: [{ id: 'item-1', request_id: 'request-1', product_name: 'عطر ورد', brand_name: 'Élan', size_label: '50 مل', quantity: 1, unit_price: 1000, line_total: 1000, currency: 'EGP', created_at: '2026-01-01T00:00:00Z', private_field: 'no' }],
  store_order_notifications: [{ id: 'notice-1', request_id: 'request-1', tracking_number: 'TRK-1', event_type: 'store_update', store_status: 'processing', match_status: 'matched', received_at: '2026-01-02T00:00:00Z', payload: { secret: true } }],
  store_shipments: [{ id: 'shipment-1', request_id: 'request-1', carrier_name: 'شركة شحن', tracking_code: 'SHIP-1', shipping_status: 'in_transit', status_note: 'في الطريق', estimated_delivery_at: null, delivered_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', customer_phone: 'private' }]
};

test('store admins receive only assigned-store orders with minimum delivery data and stable pagination', async () => {
  const { res, calls } = await run('store_admin', { limit: '1', offset: '100' }, async (url, options) => {
    if (url.pathname.endsWith('/store_accounts')) {
      assert.equal(options.headers.Authorization, 'Bearer service-key');
      assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
      return response([{ store_id: storeId }]);
    }
    if (url.pathname.endsWith('/store_order_requests')) {
      assert.equal(options.headers.Prefer, 'count=exact');
      return response([privateOrder], 200, { 'content-range': '100-100/201' });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body.stores, [storeId]);
  assert.deepEqual(res.body.pagination, { limit: 1, offset: 100, total: 201, hasMore: true });
  const order = res.body.orders[0];
  assert.equal(order.customer_name, 'اسم العميل');
  assert.equal(order.customer_phone, '01000000000');
  assert.equal(order.customer_address, 'عنوان التسليم');
  assert.equal(order.store_order_request_items[0].product_name, 'عطر ورد');
  assert.equal(order.store_shipments[0].tracking_code, 'SHIP-1');
  const serialized = JSON.stringify(order);
  for (const secret of ['customer_email', 'private@example.test', 'private note', 'initial_payload', 'payload', 'private_field']) assert.equal(serialized.includes(secret), false, `unexpected ${secret}`);
  const orderCall = calls.find(call => call.url.pathname.endsWith('/store_order_requests'));
  assert.equal(orderCall.url.searchParams.get('store_id'), `in.(${storeId})`);
  assert.equal(orderCall.url.searchParams.get('order'), 'created_at.desc,id.desc');
  assert.equal(orderCall.url.searchParams.get('limit'), '1');
  assert.equal(orderCall.url.searchParams.get('offset'), '100');
  const selected = orderCall.url.searchParams.get('select');
  assert.match(selected, /customer_name,customer_phone,customer_address/);
  for (const field of ['customer_email', 'customer_notes', 'initial_payload', 'latest_store_payload', 'payload', 'idempotency_key']) assert.equal(selected.includes(field), false, `unsafe select field ${field}`);
});

test('store account discovery paginates instead of truncating after 500 linked stores', async () => {
  const stores = Array.from({ length: 501 }, (_, index) => ({ store_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }));
  const offsets = [];
  const { res, calls } = await run('store_admin', {}, async (url) => {
    if (url.pathname.endsWith('/store_accounts')) {
      const offset = Number(url.searchParams.get('offset')) || 0;
      offsets.push(String(offset));
      return response(stores.slice(offset, offset + Number(url.searchParams.get('limit'))));
    }
    if (url.pathname.endsWith('/store_order_requests')) return response([]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.stores.length, 501);
  assert.deepEqual(offsets, ['0', '500']);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/store_accounts')).length, 2);
});

test('unauthorized roles, malformed pages and status filters are rejected before reading orders', async () => {
  const denied = await run('customer', {}, async () => { throw new Error('database read must not run'); });
  assert.equal(denied.res.status, 403);
  assert.equal(denied.calls.some(call => call.url.pathname.endsWith('/store_order_requests')), false);
  for (const query of [{ limit: '101' }, { offset: '-1' }, { status: 'anything' }]) {
    const { res, calls } = await run('store_admin', query, async () => { throw new Error('database read must not run'); });
    assert.equal(res.status, 400);
    assert.equal(calls.some(call => call.url.pathname.endsWith('/store_accounts') || call.url.pathname.endsWith('/store_order_requests')), false);
  }
});

test('platform admins can request only a validated explicit store scope', async () => {
  const bad = await run('platform_admin', { storeId: 'not-a-uuid' }, async () => { throw new Error('database read must not run'); });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.calls.some(call => call.url.pathname.endsWith('/store_order_requests')), false);
  const empty = await run('platform_admin', {}, async () => { throw new Error('database read must not run'); });
  assert.equal(empty.res.status, 200);
  assert.deepEqual(empty.res.body.orders, []);
  assert.equal(empty.res.body.pagination.total, 0);
});

test('store portal paginates and displays only delivery contact fields', () => {
  const root = path.join(__dirname, '..');
  const script = fs.readFileSync(path.join(root, 'store-dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'store-dashboard.html'), 'utf8');
  assert.match(script, /\/api\/store-dashboard-orders/);
  assert.match(script, /loadStore\(true\)/);
  assert.match(script, /customer_phone/);
  assert.match(script, /customer_address/);
  assert.doesNotMatch(script, /customer_email|customer_notes/);
  assert.match(html, /id="loadMoreOrders"/);
});
