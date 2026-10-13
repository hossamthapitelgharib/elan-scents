const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'customer-orders'));
const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });
function response(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
async function run(role, query, database) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: userId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: userId, role }]);
    return database(url, options);
  };
  const res = recorder();
  await handler({ method: 'GET', query, headers: { authorization: 'Bearer customer-token' } }, res);
  return { res: res.out, requests };
}

test('customer orders are scoped to the authenticated owner and expose stable exact pagination', async () => {
  const { res, requests } = await run('customer', { limit: '2', offset: '100', year: '2025', q: 'TRACK-1' }, async (url, options) => {
    assert.equal(url.pathname, '/rest/v1/checkout_sessions');
    assert.equal(options.headers.Authorization, 'Bearer service-key');
    assert.equal(options.headers.Prefer, 'count=exact');
    return response([{ id: 'session-101', created_at: '2025-02-01T00:00:00Z', store_order_requests: [{ id: 'request-1', tracking_number: 'TRACK-1', status: 'processing', subtotal: 100, total_amount: 120, currency: 'EGP', customer_phone: 'must-not-be-selected', stores: { name: 'Store' }, store_order_request_items: [{ product_name: 'Perfume', quantity: 1, line_total: 100, currency: 'EGP' }], store_order_cart_restorations: [{ status: 'pending', customer_email: 'private' }], store_shipments: [{ carrier_name: 'Carrier', tracking_code: 'CODE', shipping_status: 'in_transit', estimated_delivery_at: null, status_note: null, updated_at: '2025-02-02T00:00:00Z', customer_address: 'private' }] }] }], 200, { 'content-range': '100-100/201' });
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.pagination, { limit: 2, offset: 100, total: 201, hasMore: true });
  assert.equal(JSON.stringify(res.body).includes('customer_phone'), false);
  assert.equal(JSON.stringify(res.body).includes('customer_address'), false);
  const query = requests.find(item => item.url.pathname.endsWith('/checkout_sessions')).url;
  assert.equal(query.searchParams.get('user_id'), `eq.${userId}`);
  assert.equal(query.searchParams.get('order'), 'created_at.desc,id.desc');
  assert.equal(query.searchParams.get('limit'), '2');
  assert.equal(query.searchParams.get('offset'), '100');
  assert.equal(query.searchParams.get('tracking_number'), 'ilike.*TRACK-1*');
  assert.equal(query.searchParams.get('created_at'), 'gte.2025-01-01');
  assert.equal(query.searchParams.has('and'), true);
  assert.equal(query.searchParams.get('select').includes('customer_phone'), false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('customer orders reject malformed pages without querying any order rows', async () => {
  const { res, requests } = await run('customer', { limit: '101', offset: '-1' }, async () => { throw new Error('order query must not run'); });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_page');
  assert.equal(requests.some(item => item.url.pathname.endsWith('/checkout_sessions')), false);
});

test('non-customer roles cannot use the personal order endpoint', async () => {
  const { res, requests } = await run('guest', {}, async () => { throw new Error('order query must not run'); });
  assert.equal(res.status, 403);
  assert.equal(requests.some(item => item.url.pathname.endsWith('/checkout_sessions')), false);
});

test('personal orders page exposes controls for complete active and archived order history', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'account.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'account.js'), 'utf8');
  assert.match(html, /id="loadMoreOrders"/);
  assert.match(html, /id="loadMoreArchive"/);
  assert.match(js, /accountTotal !== null \? accountSessions\.length < accountTotal/);
  assert.match(js, /loadArchive\(null, true\)/);
  assert.match(js, /loadAccount\(true\)/);
});
