// Phase 2 changes to the existing order APIs: what «طلباتي» and the store dashboard now show about payment and shipment events,
// and the plain names the store door gives to the database's new rules (no approval without a payment method, nothing processed or
// shipped before payment, frozen payment terms).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const customerOrders = require(path.join(__dirname, '..', 'api', 'customer-orders'));
const storeOrderUpdate = require(path.join(__dirname, '..', 'api', 'store-order-update'));
const storeShipmentUpdate = require(path.join(__dirname, '..', 'api', 'store-shipment-update'));

const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map((key) => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : process.env[k] = v; });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = { headers: {} }; return { out, status(v) { out.status = v; return this; }, setHeader(k, v) { out.headers[k] = v; return this; }, json(b) { out.body = b; return this; } }; }

async function listOrders(request) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let select = '';
  global.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return response({ id: userId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: userId, role: 'customer' }]);
    select = url.searchParams.get('select');
    return response([{ id: 'session-1', created_at: '2026-11-11T10:00:00Z', store_order_requests: [request] }]);
  };
  const res = recorder();
  await customerOrders({ method: 'GET', query: {}, headers: { authorization: 'Bearer t' } }, res);
  return { res: res.out, select };
}
const APPROVED = {
  id: 'r1', tracking_number: 'ELN-20261111-000001', status: 'store_confirmed', created_at: '2026-11-11T10:00:00Z', subtotal: 200, shipping_amount: 30, total_amount: 230, currency: 'EGP',
  merchant_order_number: null, merchant_invoice_number: null, approved_at: '2026-11-11T11:00:00Z', payable_amount: 230, payment_status: 'not_started', payment_method: null, payment_provider: null,
  paid_at: null, sale_proven_at: null, failure_reason: 'internal note that must not show',
  payment_options: [{ id: 'o1', kind: 'card', mode: 'redirect', provider: 'paymob', labelAr: 'بطاقة', labelEn: 'Card', redirectUrl: 'https://pay.example.com/x', hostedConfig: { a: 'b' } }, { id: 'o2', kind: 'cod', mode: 'none', provider: 'merchant', labelAr: 'عند الاستلام' }],
  store_shipment_events: [
    { shipping_status: 'delivered', carrier_name: 'Bosta', tracking_code: 'W1', occurred_at: '2026-11-13T10:00:00Z', source: 'merchant_api', note: null, id: 'internal-id', request_id: 'r1' },
    { shipping_status: 'in_transit', carrier_name: 'Bosta', tracking_code: 'W1', occurred_at: '2026-11-12T10:00:00Z', source: 'merchant_api', note: null }
  ],
  stores: { name: 'متجر' }, store_order_request_items: [], store_order_cancellation_requests: [], store_order_cart_restorations: [], store_shipments: []
};

test('«طلباتي» shows the approved terms, the payment state, the options (without payment page addresses) and the shipping timeline in time order', async () => {
  const { res, select } = await listOrders(APPROVED);
  assert.equal(res.status, 200);
  for (const column of ['payable_amount', 'payment_status', 'payment_options', 'store_shipment_events', 'sale_proven_at', 'approved_at']) assert.match(select, new RegExp(column));
  const order = res.body.sessions[0].store_order_requests[0];
  assert.equal(order.payable_amount, 230);
  assert.equal(order.payment_status, 'not_started');
  assert.deepEqual(order.payment_options.map((o) => o.id), ['o1', 'o2']);
  assert.equal(JSON.stringify(order.payment_options).includes('redirectUrl'), false, 'the page address is handed out only with the choice itself');
  assert.equal(JSON.stringify(order.payment_options).includes('hostedConfig'), false);
  assert.deepEqual(order.store_shipment_events.map((e) => e.shipping_status), ['in_transit', 'delivered'], 'oldest first');
  assert.equal(JSON.stringify(order.store_shipment_events).includes('internal-id'), false);
  assert.equal('rejection_reason' in order, false, 'an internal note is never shown unless the store turned the order down');
  assert.equal(JSON.stringify(order).includes('internal note'), false);
});

test('the merchant\'s reason is shown to the customer when the store turned the order down', async () => {
  const { res } = await listOrders({ ...APPROVED, status: 'store_rejected', failure_reason: 'Out of stock until December' });
  assert.equal(res.body.sessions[0].store_order_requests[0].rejection_reason, 'Out of stock until December');
});

async function updateStatus(body, patchAnswer) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes('/auth/v1/user')) return response({ id: 'user-1' });
    if (url.includes('/profiles')) return response([{ id: 'user-1', role: 'store_admin' }]);
    if (url.includes('/store_accounts?')) return response([{ store_id: 'store-a' }]);
    if (url.includes('/store_order_requests?select=')) return response([{ id: 'r1', store_id: 'store-a', tracking_number: 'T-1', status: 'awaiting_store_confirmation' }]);
    if (url.includes('/store_order_requests?') && options.method === 'PATCH') return patchAnswer();
    return response([{}]);
  };
  const res = recorder();
  await storeOrderUpdate({ method: 'PATCH', headers: { authorization: 'Bearer t' }, body }, res);
  return res.out;
}

test('the store door names the payment rules of the database instead of a generic failure', async () => {
  const refuse = (message) => () => response({ code: 'P0001', message }, 400);
  let out = await updateStatus({ requestId: 'r1', status: 'store_confirmed' }, refuse('Configure a payment method before approving orders'));
  assert.deepEqual([out.status, out.body.error], [409, 'payment_method_required']);
  out = await updateStatus({ requestId: 'r1', status: 'store_confirmed' }, refuse('Payment is required before processing or shipping'));
  assert.deepEqual([out.status, out.body.error], [409, 'payment_required']);
  out = await updateStatus({ requestId: 'r1', status: 'store_confirmed', shippingAmount: 10 }, refuse('The approved payment terms are fixed'));
  assert.deepEqual([out.status, out.body.error], [409, 'payment_terms_fixed']);
  out = await updateStatus({ requestId: 'r1', status: 'store_confirmed' }, refuse('something else'));
  assert.deepEqual([out.status, out.body.error], [502, 'supabase_update_failed']);
});

test('a shipment saved before payment is a plain 409 «payment_required»', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes('/auth/v1/user')) return response({ id: 'user-1' });
    if (url.includes('/profiles')) return response([{ id: 'user-1', role: 'store_admin' }]);
    if (url.includes('/store_accounts?')) return response([{ store_id: 'store-a' }]);
    if (url.includes('/store_order_requests?')) return response([{ id: 'request-1', store_id: 'store-a', tracking_number: 'T-1', status: 'store_confirmed' }]);
    // The saved shipment is read with a GET and written with a POST (first row) or a PATCH (compare-and-set); the database refuses the write.
    if (url.includes('/store_shipments?') && !options.method) return response([]);
    if (url.includes('/store_shipments?')) return response({ code: 'P0001', message: 'Payment is required before shipping' }, 400);
    return response([{}]);
  };
  const res = recorder();
  await storeShipmentUpdate({ method: 'PATCH', headers: { authorization: 'Bearer t' }, body: { requestId: 'request-1', shippingStatus: 'in_transit', carrierName: 'A', trackingCode: 'W' } }, res);
  assert.deepEqual([res.out.status, res.out.body.error], [409, 'payment_required']);
});
