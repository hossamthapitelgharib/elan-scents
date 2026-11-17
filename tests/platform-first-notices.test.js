const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-first-notices'));

/* Made-up data only: no real customer, store, key or phone number. */
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader(name, value) { (out.headers = out.headers || {})[name] = value; return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const noticeId = '0b7d8b0e-5b5e-4c3e-9d54-0c2a8f4f2b11';
const requestId = '7c1f2a10-3d4e-4f5a-8b6c-1d2e3f4a5b6c';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

const payload = {
  type: 'platform_order_notice', version: 1, elanOrderId: requestId, trackingNumber: 'ELN-TEST-0001', checkoutTrackingNumber: 'CHK-TEST-0001',
  store: { id: storeId, name: 'Store A' }, customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  customer: {
    source: 'customer_details', capturedAt: '2026-11-15T10:00:00Z',
    buyer: { name: 'Buyer Name', phone: '01000000000', email: 'buyer@example.invalid', governorate: 'Cairo', address: 'buyer street', lat: 30.1, lng: 31.2 },
    shipping: { sameAsBuyer: true, lat: 30.1, lng: 31.2 },
    delivery: { name: 'Receiver Name', phone: '01111111111', email: 'receiver@example.invalid', address: 'Cairo, Street 1, Building 2', notes: 'ring twice' }
  },
  items: [
    { lineId: 'l1', platformOrderNumber: 'P-1', productSizeId: 's1', productName: 'Perfume One', brandName: 'Brand', sizeLabel: '100 ml', quantity: 2, unitPrice: 500, lineTotal: 1000, internalCost: 123 },
    { lineId: 'l2', platformOrderNumber: 'P-2', productName: 'Perfume Two', brandName: 'Brand', sizeLabel: '50 ml', quantity: 1, unitPrice: 250.5, lineTotal: 250.5 }
  ],
  subtotal: 1250.5, shipping: 50, total: 1300.5, currency: 'EGP',
  payment: { method: 'card', provider: 'provider-x', status: 'paid', reference: 'PAY-REF-1', paidAt: '2026-11-15T09:59:00Z', cardToken: 'must-not-leave' },
  createdAt: '2026-11-15T10:00:00Z', webhookSecret: 'must-not-leave'
};
const noticeRow = (n = 1, extra = {}) => ({ id: noticeId.replace(/.$/, String(n)), request_id: requestId, store_id: storeId, tracking_number: 'ELN-TEST-0001', payload_hash: 'abc123', created_at: `2026-11-15T10:0${n}:00Z`, payload, ...extra });
const orderRow = (extra = {}) => ({ id: requestId, status: 'store_confirmed', payment_status: 'paid', reconciliation_status: 'pending', mismatch_fields: [], merchant_order_number: null, merchant_invoice_number: null, sale_proven_at: null, ...extra });

function fake(role, { notices = [noticeRow()], orders = [orderRow()], total = null, status = 200, stores = [{ id: storeId, name: 'Store A (db)' }] } = {}) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return response({ id: adminId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: adminId, role }]);
    calls.push({ table: url.pathname.replace('/rest/v1/', ''), params: Object.fromEntries(url.searchParams), headers: options.headers });
    if (url.pathname === '/rest/v1/platform_order_notices') return response(status === 200 ? notices : { message: 'boom' }, status, total === null ? {} : { 'content-range': `0-${notices.length - 1}/${total}` });
    if (url.pathname === '/rest/v1/stores') return response(stores);
    if (url.pathname === '/rest/v1/store_order_requests') return response(orders);
    throw new Error(`unexpected ${url.pathname}`);
  };
  return calls;
}
async function call(req) { const res = recorder(); await handler({ headers: { authorization: 'Bearer token' }, ...req }, res); return res.out; }

test('only a platform admin may read the first notices: customers and store accounts get 403 and nothing is read', async () => {
  for (const role of ['customer', 'store_admin']) {
    const calls = fake(role);
    const out = await call({ method: 'GET', query: {} });
    assert.equal(out.status, 403, role);
    assert.equal(calls.length, 0, 'no notice is read before the role is checked');
  }
  global.fetch = async () => { throw new Error('no request without a token'); };
  const res = recorder();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.out.status, 401);
});

test('it only reads: any other method is refused', async () => {
  fake('platform_admin');
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal((await call({ method, query: {} })).status, 405, method);
});

test('the list shows what the admin scans (store, tracking number, totals, payment, second-notice state) and no contact details', async () => {
  const calls = fake('platform_admin', { total: 1 });
  const out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.total, 1);
  assert.equal(out.body.hasMore, false);
  const [notice] = out.body.notices;
  assert.equal(notice.trackingNumber, 'ELN-TEST-0001');
  assert.equal(notice.storeName, 'Store A (db)', 'the store name comes from the store row, not from the frozen copy');
  assert.equal(notice.itemCount, 2);
  assert.equal(notice.unitCount, 3);
  assert.equal(notice.total, 1300.5);
  assert.equal(notice.currency, 'EGP');
  assert.equal(notice.paymentMethod, 'card');
  assert.equal(notice.second, 'waiting', 'no merchant notice yet');
  const json = JSON.stringify(out.body);
  for (const secret of ['01111111111', '01000000000', 'example.invalid', 'Building 2', 'must-not-leave', 'aaaaaaaa-aaaa']) assert.ok(!json.includes(secret), `${secret} stays on the server`);
  const read = calls.find(call => call.table === 'platform_order_notices');
  assert.equal(read.params.order, 'created_at.desc,id.desc');
  assert.equal(read.params.limit, '20');
  assert.equal(read.headers.Prefer, 'count=exact');
});

test('an empty table is an empty list, not an error (no order has been paid yet)', async () => {
  fake('platform_admin', { notices: [], orders: [], total: 0 });
  const out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.notices, []);
  assert.equal(out.body.total, 0);
  assert.equal(out.body.hasMore, false);
});

test('paging: the next page exists while rows remain, and the offset and the limit reach the database', async () => {
  const calls = fake('platform_admin', { notices: [noticeRow(1), noticeRow(2)], total: 7 });
  const out = await call({ method: 'GET', query: { limit: '2', offset: '2' } });
  assert.equal(out.body.hasMore, true);
  assert.equal(out.body.total, 7);
  const read = calls.find(call => call.table === 'platform_order_notices');
  assert.equal(read.params.limit, '2');
  assert.equal(read.params.offset, '2');
});

test('filters go to the database: a store, and a part of a tracking number', async () => {
  const calls = fake('platform_admin', { total: 1 });
  await call({ method: 'GET', query: { store: storeId, q: 'ELN-TEST' } });
  const read = calls.find(call => call.table === 'platform_order_notices');
  assert.equal(read.params.store_id, `eq.${storeId}`);
  assert.equal(read.params.tracking_number, 'ilike.*ELN-TEST*');
});

test('bad input is refused before the database is asked', async () => {
  for (const query of [{ limit: '0' }, { limit: '51' }, { limit: 'x' }, { offset: '-1' }, { offset: '100001' }, { store: 'not-a-uuid' }, { q: 'a,b' }, { q: '*)or(' }, { q: 'x'.repeat(61) }, { id: 'nope' }]) {
    const calls = fake('platform_admin');
    const out = await call({ method: 'GET', query });
    assert.equal(out.status, 400, JSON.stringify(query));
    assert.equal(calls.length, 0, 'nothing was read for ' + JSON.stringify(query));
  }
});

test('one notice in full: what was sent to the merchant, by the keys we list only', async () => {
  const calls = fake('platform_admin');
  const out = await call({ method: 'GET', query: { id: noticeId } });
  assert.equal(out.status, 200);
  const notice = out.body.notice;
  assert.equal(notice.checkoutTrackingNumber, 'CHK-TEST-0001');
  assert.equal(notice.payloadHash, 'abc123');
  assert.deepEqual(notice.delivery, { name: 'Receiver Name', phone: '01111111111', email: 'receiver@example.invalid', address: 'Cairo, Street 1, Building 2', notes: 'ring twice' });
  assert.equal(notice.items.length, 2);
  assert.deepEqual(Object.keys(notice.items[0]).sort(), ['brandName', 'lineTotal', 'platformOrderNumber', 'productName', 'quantity', 'sizeLabel', 'unitPrice'], 'an internal key on a line does not leave');
  assert.equal(notice.items[1].unitPrice, 250.5);
  assert.equal(notice.subtotal, 1250.5);
  assert.equal(notice.shipping, 50);
  assert.deepEqual(notice.payment, { method: 'card', provider: 'provider-x', status: 'paid', reference: 'PAY-REF-1', paidAt: '2026-11-15T09:59:00Z' });
  assert.equal(notice.order.status, 'store_confirmed');
  assert.equal(notice.order.paymentStatus, 'paid');
  const json = JSON.stringify(out.body);
  for (const secret of ['must-not-leave', 'internalCost', 'buyer@example.invalid', '30.1', 'aaaaaaaa-aaaa']) assert.ok(!json.includes(secret), `${secret} stays on the server`);
  assert.equal(calls.find(call => call.table === 'platform_order_notices').params.id, `eq.${noticeId}`);
});

test('the second notice state follows the order: waiting, matched, or a mismatch with its fields', async () => {
  fake('platform_admin', { orders: [orderRow()] });
  assert.equal((await call({ method: 'GET', query: { id: noticeId } })).body.notice.secondNotice.state, 'waiting');
  fake('platform_admin', { orders: [orderRow({ reconciliation_status: 'matched', merchant_order_number: 'M-1', merchant_invoice_number: 'INV-1' })] });
  const matched = (await call({ method: 'GET', query: { id: noticeId } })).body.notice.secondNotice;
  assert.deepEqual([matched.state, matched.merchantOrderNumber, matched.merchantInvoiceNumber], ['matched', 'M-1', 'INV-1']);
  fake('platform_admin', { orders: [orderRow({ reconciliation_status: 'mismatched', mismatch_fields: ['total', 'items'] })] });
  const mismatch = (await call({ method: 'GET', query: { id: noticeId } })).body.notice.secondNotice;
  assert.equal(mismatch.state, 'mismatch');
  assert.deepEqual(mismatch.mismatches, ['total', 'items']);
});

test('an unknown notice is 404, and a notice of an unexpected shape is still listed with what is recognised', async () => {
  fake('platform_admin', { notices: [] });
  assert.equal((await call({ method: 'GET', query: { id: noticeId } })).status, 404);
  fake('platform_admin', { notices: [noticeRow(1, { payload: { surprise: true } })], total: 1 });
  const out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.notices.length, 1);
  assert.equal(out.body.notices[0].itemCount, 0);
  assert.equal(out.body.notices[0].total, null);
});

test('a database failure is a plain 502 with a code, never a stack or a body from upstream', async () => {
  fake('platform_admin', { status: 500 });
  const out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 502);
  assert.deepEqual(out.body, { ok: false, error: 'first_notices_unavailable' });
  assert.equal(out.headers['Cache-Control'], 'no-store');
});
