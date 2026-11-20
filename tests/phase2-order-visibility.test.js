// What «طلباتي» (api/customer-orders.js) hands the customer about an order: the approved terms, the payment state, the merchant's payment
// window (its state and when it ends, NEVER its address), why an order was cancelled, the merchant's reason when it turned the order down,
// and the shipping timeline. The store takes no manual action any more (the store dashboard is read-only; the merchant answers through
// its technical link), so there is no store door to test here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const customerOrders = require(path.join(__dirname, '..', 'api', 'customer-orders'));

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
  payment_windows: { state: 'opened', expires_at: '2026-11-11T11:30:00Z', url: 'https://pay.example.com/secret-window', id: 'window-internal-id' }, cancel_reason: null,
  store_shipment_events: [
    { shipping_status: 'delivered', carrier_name: 'Bosta', tracking_code: 'W1', occurred_at: '2026-11-13T10:00:00Z', source: 'merchant_api', note: null, id: 'internal-id', request_id: 'r1' },
    { shipping_status: 'in_transit', carrier_name: 'Bosta', tracking_code: 'W1', occurred_at: '2026-11-12T10:00:00Z', source: 'merchant_api', note: null }
  ],
  stores: { name: 'متجر' }, store_order_request_items: [], store_order_cancellation_requests: [], store_order_cart_restorations: [], store_shipments: []
};

test('«طلباتي» shows the approved terms, the payment state, the payment window (state and end time only) and the shipping timeline in time order', async () => {
  const { res, select } = await listOrders(APPROVED);
  assert.equal(res.status, 200);
  for (const column of ['payable_amount', 'payment_status', 'payment_windows', 'cancel_reason', 'store_shipment_events', 'sale_proven_at', 'approved_at']) assert.match(select, new RegExp(column));
  assert.doesNotMatch(select, /payment_options/, 'the customer no longer chooses a payment option from the platform');
  const order = res.body.sessions[0].store_order_requests[0];
  assert.equal(order.payable_amount, 230);
  assert.equal(order.payment_status, 'not_started');
  assert.deepEqual(order.payment_window, { state: 'opened', expires_at: '2026-11-11T11:30:00Z' });
  assert.equal(JSON.stringify(order).includes('secret-window'), false, 'the merchant page address is handed out only by the window call, to the owner');
  assert.equal(JSON.stringify(order).includes('window-internal-id'), false);
  assert.equal('payment_options' in order, false);
  assert.deepEqual(order.store_shipment_events.map((e) => e.shipping_status), ['in_transit', 'delivered'], 'oldest first');
  assert.equal(JSON.stringify(order.store_shipment_events).includes('internal-id'), false);
  assert.equal('rejection_reason' in order, false, 'an internal note is never shown unless the store turned the order down');
  assert.equal(JSON.stringify(order).includes('internal note'), false);
});

test('an order with no payment window yet carries payment_window: null', async () => {
  const { res } = await listOrders({ ...APPROVED, payment_windows: null });
  assert.equal(res.body.sessions[0].store_order_requests[0].payment_window, null);
  const array = await listOrders({ ...APPROVED, payment_windows: [{ state: 'issued', expires_at: '2026-11-11T11:30:00Z', url: 'https://x.example.com' }] });
  assert.deepEqual(array.res.body.sessions[0].store_order_requests[0].payment_window, { state: 'issued', expires_at: '2026-11-11T11:30:00Z' });
});

test('why an order was cancelled reaches the page, so it can say «ملغاة من طرفك» or the store-unavailable apology', async () => {
  for (const reason of ['store_unresponsive', 'payment_window_closed', 'payment_window_cancelled', 'payment_window_expired', 'customer_requested_before_payment']) {
    const { res } = await listOrders({ ...APPROVED, status: 'cancelled', cancel_reason: reason, payment_windows: null });
    assert.equal(res.body.sessions[0].store_order_requests[0].cancel_reason, reason);
  }
});

test('the merchant\'s reason is shown to the customer when the store turned the order down', async () => {
  const { res } = await listOrders({ ...APPROVED, status: 'store_rejected', failure_reason: 'Out of stock until December' });
  assert.equal(res.body.sessions[0].store_order_requests[0].rejection_reason, 'Out of stock until December');
});
