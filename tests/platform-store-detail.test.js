const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-store-detail'));

const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const requestId = '047e5a77-2500-47d2-8b76-f9a43edcf912';
const productSizeId = '76aeaf77-94c9-4382-9f54-93b3c5d70d67';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});

function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() {
  const out = { headers: {} };
  return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } };
}
function configureFetch(role, database) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    requests.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: adminId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: adminId, role }]);
    return database(url, options);
  };
  return requests;
}
function request(query = {}, method = 'GET') { return { method, query, headers: { authorization: 'Bearer admin-token' } }; }
const store = { id: storeId, name: 'متجر تجريبي', slug: 'sample', logo_url: null, image_url: null, short_description: 'وصف', website_url: 'https://example.test', status: 'active', commission_rate: 8, priority_rank: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' };

async function run(query, role, database, method = 'GET') {
  const requests = configureFetch(role, database);
  const res = recorder();
  await handler(request(query, method), res);
  return { res: res.out, requests };
}

test('store detail API rejects store accounts before querying store data', async () => {
  const { res, requests } = await run({ storeId, section: 'overview' }, 'store_admin', async () => { throw new Error('store query must not run'); });
  assert.equal(res.status, 403);
  assert.equal(requests.filter(item => item.url.pathname.startsWith('/rest/v1/') && !item.url.pathname.endsWith('/profiles')).length, 0);
});

test('store detail API validates store and section parameters before reading store tables', async () => {
  const { res, requests } = await run({ storeId: 'not-a-uuid', section: 'overview' }, 'platform_admin', async () => { throw new Error('store query must not run'); });
  assert.equal(res.status, 400);
  assert.equal(requests.some(item => item.url.pathname.endsWith('/stores')), false);
});

test('overview returns store profile, safe account links and the existing operational summary', async () => {
  const { res } = await run({ storeId, section: 'overview' }, 'platform_admin', async url => {
    if (url.pathname.endsWith('/stores')) return response([store]);
    if (url.pathname.endsWith('/store_accounts')) return response([{ id: 'a1', user_id: adminId, role: 'store_admin', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', password: 'must-not-be-selected' }]);
    if (url.pathname.endsWith('/rpc/platform_store_summary')) return response([{ store_id: storeId, linked_accounts: 1, product_count: 14, available_product_count: 11, active_offer_count: 2, order_request_count: 3, open_order_count: 1, review_order_count: 1, shipment_count: 2 }]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.store.name, 'متجر تجريبي');
  assert.equal(res.body.summary.product_count, 14);
  assert.equal(res.body.accounts[0].user_id, adminId);
  assert.equal(Object.hasOwn(res.body.accounts[0], 'password'), false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('overview loads linked accounts beyond the former 100-row ceiling', async () => {
  const accounts = Array.from({ length: 101 }, (_, index) => ({ id: `account-${index}`, user_id: adminId, role: 'store_admin', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }));
  const { res, requests } = await run({ storeId, section: 'overview' }, 'platform_admin', async url => {
    if (url.pathname.endsWith('/stores')) return response([store]);
    if (url.pathname.endsWith('/store_accounts')) return response(accounts.slice(Number(url.searchParams.get('offset')) || 0, (Number(url.searchParams.get('offset')) || 0) + (Number(url.searchParams.get('limit')) || 500)));
    if (url.pathname.endsWith('/rpc/platform_store_summary')) return response([{ store_id: storeId, linked_accounts: 101 }]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.accounts.length, 101);
  const accountQuery = requests.find(item => item.url.pathname.endsWith('/store_accounts')).url;
  assert.equal(accountQuery.searchParams.get('limit'), '500');
});

test('catalog products are joined to their product size, fragrance and brand', async () => {
  const { res } = await run({ storeId, section: 'catalog', limit: '25' }, 'platform_admin', async url => {
    if (url.pathname.endsWith('/stores')) return response([store]);
    if (url.pathname.endsWith('/store_products')) return response([{ id: 'sp-1', store_id: storeId, product_size_id: productSizeId, price: 1250, original_price: 1500, discount_percentage: 16.7, stock_quantity: 4, is_available: true, currency: 'EGP', data_source: 'manual', sync_status: 'success', product_url: 'https://example.test/p', last_synced_at: null }]);
    if (url.pathname.endsWith('/product_sizes')) return response([{ id: productSizeId, product_id: 'b674011e-50e9-4731-a984-4c8fec18f64a', size_ml: 50, size_label: '50 مل', sku: 'S-50' }]);
    if (url.pathname.endsWith('/products')) return response([{ id: 'b674011e-50e9-4731-a984-4c8fec18f64a', brand_id: 'baac9bd6-5f47-45ef-8ad7-5d31f70a20ed', name: 'عطر ورد', slug: 'rose', status: 'published', is_active: true }]);
    if (url.pathname.endsWith('/brands')) return response([{ id: 'baac9bd6-5f47-45ef-8ad7-5d31f70a20ed', name: 'علامة تجارية' }]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.records[0].product.name, 'عطر ورد');
  assert.equal(res.body.records[0].brand.name, 'علامة تجارية');
  assert.equal(res.body.records[0].size.size_ml, 50);
});

test('order details never return customer contact fields or raw notification and reconciliation payloads', async () => {
  const { res, requests } = await run({ storeId, section: 'orders', limit: '10' }, 'platform_admin', async url => {
    if (url.pathname.endsWith('/stores')) return response([store]);
    if (url.pathname.endsWith('/store_order_requests')) return response([{
      id: requestId, store_id: storeId, tracking_number: 'TRK-1', status: 'processing', subtotal: 1000, shipping_amount: 50,
      total_amount: 1050, currency: 'EGP', store_order_reference: 'S-1', failure_reason: null, reconciliation_status: 'matched',
      mismatch_fields: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
      customer_name: 'private customer', customer_phone: '01000000000', customer_email: 'private@example.test', customer_address: 'private address',
      customer_notes: 'private notes', initial_payload: { private: true }, latest_store_payload: { private: true }
    }]);
    if (url.pathname.endsWith('/store_order_request_items')) return response([{ request_id: requestId, product_name: 'عطر ورد', brand_name: 'علامة', size_label: '50 مل', quantity: 1, unit_price: 1000, line_total: 1000, currency: 'EGP', created_at: '2026-01-01T00:00:00Z', raw_private_field: 'no' }]);
    if (url.pathname.endsWith('/store_shipments')) return response([{ id: 'sh-1', request_id: requestId, store_id: storeId, carrier_name: 'شركة شحن', tracking_code: 'SHIP-1', shipping_status: 'in_transit', status_note: 'في الطريق', estimated_delivery_at: null, delivered_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }]);
    if (url.pathname.endsWith('/store_order_notifications')) return response([{ request_id: requestId, tracking_number: 'TRK-1', event_type: 'store_update', store_status: 'processing', match_status: 'matched', mismatch_fields: [], received_at: '2026-01-02T00:00:00Z', payload: { customer_phone: 'secret' } }]);
    if (url.pathname.endsWith('/order_reconciliation_checks')) return response([{ request_id: requestId, tracking_number: 'TRK-1', event_type: 'store_update', match_status: 'matched', mismatch_fields: [], checked_at: '2026-01-02T00:00:00Z', initial_payload: { customer_email: 'secret' }, store_payload: { customer_address: 'secret' } }]);
    if (url.pathname.endsWith('/order_operation_events')) return response([{ request_id: requestId, actor_role: 'store_admin', event_type: 'status_update', source: 'api', created_at: '2026-01-02T00:00:00Z', actor_user_id: adminId, payload: { private: true }, before_state: {}, after_state: {} }]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  const order = res.body.records[0];
  assert.equal(order.items[0].product_name, 'عطر ورد');
  assert.equal(order.shipments[0].tracking_code, 'SHIP-1');
  const serialized = JSON.stringify(order);
  for (const secret of ['private customer', '01000000000', 'private@example.test', 'private address', 'private notes', 'initial_payload', 'latest_store_payload', 'customer_phone', 'customer_email', 'customer_address', 'actor_user_id', 'before_state', 'after_state', 'payload']) assert.equal(serialized.includes(secret), false, `unexpected ${secret}`);
  const orderQuery = requests.find(item => item.url.pathname.endsWith('/store_order_requests'));
  assert.equal(orderQuery.url.searchParams.get('select').includes('customer_'), false);
  assert.equal(orderQuery.url.searchParams.get('select').includes('payload'), false);
});

test('order detail loads every page of items and reconciliation checks beyond 500 rows', async () => {
  const items = Array.from({ length: 501 }, (_, index) => ({ request_id: requestId, product_name: `منتج ${index}`, quantity: 1, unit_price: 10, line_total: 10, currency: 'EGP', created_at: '2026-01-01T00:00:00Z' }));
  const checks = Array.from({ length: 501 }, (_, index) => ({ id: `check-${index}`, request_id: requestId, tracking_number: 'TRK-1', event_type: 'store_update', match_status: 'matched', mismatch_fields: [], checked_at: '2026-01-02T00:00:00Z', initial_payload: { secret: true } }));
  const { res, requests } = await run({ storeId, section: 'orders', limit: '10' }, 'platform_admin', async url => {
    if (url.pathname.endsWith('/stores')) return response([store]);
    if (url.pathname.endsWith('/store_order_requests')) return response([{ id: requestId, store_id: storeId, tracking_number: 'TRK-1', status: 'processing', subtotal: 100, currency: 'EGP' }]);
    if (url.pathname.endsWith('/store_order_request_items')) { const offset = Number(url.searchParams.get('offset')) || 0; return response(items.slice(offset, offset + Number(url.searchParams.get('limit')))); }
    if (url.pathname.endsWith('/order_reconciliation_checks')) { const offset = Number(url.searchParams.get('offset')) || 0; return response(checks.slice(offset, offset + Number(url.searchParams.get('limit')))); }
    if (url.pathname.endsWith('/store_shipments') || url.pathname.endsWith('/store_order_notifications') || url.pathname.endsWith('/order_operation_events')) return response([]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.records[0].items.length, 501);
  assert.equal(res.body.records[0].checks.length, 501);
  assert.equal(JSON.stringify(res.body).includes('initial_payload'), false);
  const itemOffsets = requests.filter(item => item.url.pathname.endsWith('/store_order_request_items')).map(item => item.url.searchParams.get('offset'));
  assert.deepEqual(itemOffsets, ['0', '500']);
  const checkOffsets = requests.filter(item => item.url.pathname.endsWith('/order_reconciliation_checks')).map(item => item.url.searchParams.get('offset'));
  assert.deepEqual(checkOffsets, ['0', '500']);
});

test('reconciliation pagination follows request rows and strips raw check payloads', async () => {
  const { res } = await run({ storeId, section: 'reconciliation', limit: '1', offset: '0' }, 'platform_admin', async url => {
    if (url.pathname.endsWith('/stores')) return response([store]);
    if (url.pathname.endsWith('/store_order_requests')) return response([{ id: requestId, tracking_number: 'TRK-1', status: 'needs_review', reconciliation_status: 'pending', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }]);
    if (url.pathname.endsWith('/order_reconciliation_checks')) return response([{ id: 'check-1', request_id: requestId, notification_id: 'notice-1', tracking_number: 'TRK-1', event_type: 'store_update', mismatch_fields: [], match_status: 'matched', checked_at: '2026-01-02T00:00:00Z', initial_payload: { customer_email: 'secret' }, store_payload: { customer_phone: 'secret' }, payload: { private: true } }]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.records.length, 1);
  assert.equal(res.body.records[0].checks.length, 1);
  assert.equal(res.body.hasMore, true);
  assert.equal(JSON.stringify(res.body).includes('initial_payload'), false);
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
});

test('offers, shipments, commissions and sync logs return their bounded store-only fields', async () => {
  const productId = 'b674011e-50e9-4731-a984-4c8fec18f64a';
  const brandId = 'baac9bd6-5f47-45ef-8ad7-5d31f70a20ed';
  const storeProductId = '29249de1-83ec-47ab-92cf-785cf1c41aa3';
  const orderId = '455b32c2-f1c4-4d58-a3ad-ed23076ceaf1';
  const orderItemId = 'a8c1693f-829c-49cc-9ff3-54218d003abc';
  const cases = ['offers', 'shipments', 'commissions', 'sync'];
  for (const section of cases) {
    const { res } = await run({ storeId, section }, 'platform_admin', async url => {
      if (url.pathname.endsWith('/stores')) return response([store]);
      if (section === 'offers' && url.pathname.endsWith('/offers')) return response([{ id: 'offer-1', store_id: storeId, product_size_id: productSizeId, title: 'عرض تجريبي', description: 'وصف', discount_type: 'percentage', discount_value: 10, start_date: null, end_date: null, is_active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }]);
      if (section === 'shipments' && url.pathname.endsWith('/store_shipments')) return response([{ id: 'ship-1', request_id: requestId, store_id: storeId, carrier_name: 'شركة شحن', tracking_code: 'SHP-1', shipping_status: 'in_transit', status_note: 'في الطريق', estimated_delivery_at: null, delivered_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }]);
      if (section === 'shipments' && url.pathname.endsWith('/store_order_requests')) return response([{ id: requestId, tracking_number: 'TRK-1', status: 'shipped', reconciliation_status: 'matched' }]);
      if (section === 'commissions' && url.pathname.endsWith('/commissions')) return response([{ id: 'commission-1', store_id: storeId, order_item_id: orderItemId, rate: 8, amount: 80, status: 'payable', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }]);
      if (section === 'commissions' && url.pathname.endsWith('/order_items')) return response([{ id: orderItemId, order_id: orderId, store_product_id: storeProductId, quantity: 1, price_at_time: 1000, created_at: '2026-01-01T00:00:00Z', private_field: 'must-not-return' }]);
      if (section === 'commissions' && url.pathname.endsWith('/orders')) return response([{ id: orderId, status: 'completed', subtotal: 1000, total_amount: 1050, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', user_id: 'private-user-id' }]);
      if (section === 'commissions' && url.pathname.endsWith('/store_products')) return response([{ id: storeProductId, store_id: storeId, product_size_id: productSizeId, price: 1000, currency: 'EGP', is_available: true }]);
      if (url.pathname.endsWith('/product_sizes')) return response([{ id: productSizeId, product_id: productId, size_ml: 50, size_label: '50 مل', sku: 'S-50' }]);
      if (url.pathname.endsWith('/products')) return response([{ id: productId, brand_id: brandId, name: 'عطر ورد', slug: 'rose', status: 'published', is_active: true }]);
      if (url.pathname.endsWith('/brands')) return response([{ id: brandId, name: 'علامة تجارية' }]);
      if (section === 'sync' && url.pathname.endsWith('/sync_logs')) return response([{ id: 'sync-1', store_id: storeId, status: 'success', records_count: 14, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', message: 'raw log payload' }]);
      throw new Error(`unexpected ${section} query ${url.pathname}`);
    });
    assert.equal(res.status, 200, section);
    assert.equal(res.body.records.length, 1, section);
    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes('private-user-id'), false, section);
    assert.equal(serialized.includes('private_field'), false, section);
    if (section === 'offers') assert.equal(res.body.records[0].product.name, 'عطر ورد');
    if (section === 'shipments') assert.equal(res.body.records[0].order.tracking_number, 'TRK-1');
    if (section === 'commissions') assert.equal(res.body.records[0].item.product.product.name, 'عطر ورد');
    if (section === 'sync') assert.equal(serialized.includes('raw log payload'), false);
  }
});

test('store admin UI exposes read-only operational sections and routes detail reads through the admin API', () => {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'stores-dashboard.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'stores-dashboard.js'), 'utf8');
  for (const section of ['overview', 'catalog', 'offers', 'orders', 'shipments', 'commissions', 'sync', 'reconciliation']) assert.match(html, new RegExp(`data-store-section="${section}"`));
  assert.match(js, /\/api\/platform-store-detail/);
  assert.match(html, /id="unlinkedOperations"/);
  assert.match(js, /\/api\/platform-store-unlinked/);
  assert.match(html, /id="storeFilters"/);
  assert.match(html, /لا تظهر بيانات اتصال العملاء أو الحمولات الخام/);
});
