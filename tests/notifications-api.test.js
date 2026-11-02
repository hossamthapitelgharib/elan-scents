const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'notifications'));

const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const notificationId = '04a6e52c-46c6-42e9-a730-9e5bec3dd201';
const payload = {
  status: 'awaiting_store_confirmation', subtotal: 1250, currency: 'EGP', trackingNumber: 'ELN-20261102-123456',
  checkoutTrackingNumber: 'ELN-20261102-123456', itemCount: 1, store: { id: storeId, name: 'متجر تجريبي' },
  customer: { name: '<img src=x>', phone: '+201000000000', email: 'buyer@example.test', address: 'عنوان اختباري', notes: 'اتصل قبل الوصول' },
  items: [{ productName: '<script>عطر</script>', brandName: 'علامة', size: '50 مل', quantity: 2, unitPrice: 625, lineTotal: 1250, privateField: 'must-not-return' }],
  handedOffAt: '2026-11-02T18:00:00Z', privateRoot: 'must-not-return'
};
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
async function run(role, database) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: userId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: userId, role }]);
    return database(url, options);
  };
  const res = recorder();
  await handler({ method: 'GET', query: { limit: '50' }, headers: { authorization: 'Bearer test-token' } }, res);
  return { res: res.out, requests };
}
function row() {
  return { id: notificationId, title: 'طلب جديد', body: 'تم استلام طلب جديد', is_read: false, created_at: '2026-11-02T18:00:00Z', type: 'order_initial', tracking_number: payload.trackingNumber, payload };
}

test('platform admins receive sanitized order details for the full platform notification', async () => {
  const { res, requests } = await run('platform_admin', async url => {
    if (url.pathname.endsWith('/notifications')) return response([row()]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  const notice = res.body.notifications[0];
  assert.equal(notice.order.trackingNumber, payload.trackingNumber);
  assert.equal(notice.order.customer.email, 'buyer@example.test');
  assert.equal(notice.order.items[0].lineTotal, 1250);
  assert.equal(Object.hasOwn(notice.order, 'privateRoot'), false);
  assert.equal(Object.hasOwn(notice.order.items[0], 'privateField'), false);
  assert.equal(Object.hasOwn(notice, 'payload'), false);
  const query = requests.find(item => item.url.pathname.endsWith('/notifications')).url;
  assert.equal(query.searchParams.get('recipient_role'), 'eq.platform_admin');
  assert.match(query.searchParams.get('select'), /payload/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('store purchase completion notification includes its store reference, final amounts and shipment evidence', async () => {
  const completed = row();
  completed.type = 'store_purchase_completed';
  completed.payload = {
    ...payload, status: 'completed', storeOrderReference: 'STORE-ORDER-908', subtotal: 1250, shipping: 50, total: 1300,
    matched: true, mismatches: [], shipment: { carrier: 'شركة شحن', trackingCode: 'SHIP-77', status: 'in_transit', private: 'omit' },
    items: [{ productSizeId: '76aeaf77-94c9-4382-9f54-93b3c5d70d67', quantity: 2, unitPrice: 625, currency: 'EGP', total: 1250, private: 'omit' }]
  };
  const { res } = await run('store_admin', async url => {
    if (url.pathname.endsWith('/store_accounts')) return response([{ store_id: storeId }]);
    if (url.pathname.endsWith('/notifications')) return response([completed]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  const order = res.body.notifications[0].order;
  assert.equal(order.storeOrderReference, 'STORE-ORDER-908');
  assert.equal(order.total, 1300);
  assert.equal(order.shipping, 50);
  assert.equal(order.matched, true);
  assert.equal(order.shipment.trackingCode, 'SHIP-77');
  assert.equal(order.items[0].lineTotal, 1250);
  assert.equal(JSON.stringify(order).includes('private'), false);
});

test('store admins receive order details only from their linked store scope', async () => {
  const { res, requests } = await run('store_admin', async url => {
    if (url.pathname.endsWith('/store_accounts')) return response([{ store_id: storeId }]);
    if (url.pathname.endsWith('/notifications')) return response([row()]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.notifications[0].order.store.name, 'متجر تجريبي');
  const query = requests.find(item => item.url.pathname.endsWith('/notifications')).url;
  assert.match(query.searchParams.get('or'), new RegExp(storeId));
  assert.match(query.searchParams.get('or'), new RegExp(userId));
});

test('customers never receive the expanded contact and cart details through notifications', async () => {
  const { res } = await run('customer', async url => {
    if (url.pathname.endsWith('/notifications')) return response([row()]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  assert.equal(res.status, 200);
  const notice = res.body.notifications[0];
  assert.equal(notice.order, undefined);
  assert.equal(JSON.stringify(notice).includes('buyer@example.test'), false);
  assert.equal(Object.hasOwn(notice, 'payload'), false);
});

test('notification detail allowlist caps cart lines and ignores malformed values', async () => {
  const oversized = row();
  oversized.payload = { ...payload, items: Array.from({ length: 120 }, (_, index) => ({ productName: `item-${index}`, quantity: 'bad', unitPrice: 'NaN', raw: 'no' })) };
  const { res } = await run('platform_admin', async url => {
    if (url.pathname.endsWith('/notifications')) return response([oversized]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  const order = res.body.notifications[0].order;
  assert.equal(order.items.length, 100);
  assert.equal(order.items[0].quantity, null);
  assert.equal(order.items[0].unitPrice, null);
  assert.equal(JSON.stringify(order).includes('raw'), false);
});
