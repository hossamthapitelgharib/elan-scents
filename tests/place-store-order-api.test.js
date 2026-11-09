// POST /api/place-store-order and POST /api/confirm-store-order-purchase after phase 1 (docs/implementation-phase-1-purchase-core.ar.md):
// the browser may name only the store, the retry key and the total it showed; everything else the browser says is dropped before the
// database is called, and the customer's own purchase confirmation is retired (HTTP 410, the database is never reached).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const placeOrder = require(path.join(__dirname, '..', 'api', 'place-store-order'));
const confirmPurchase = require(path.join(__dirname, '..', 'api', 'confirm-store-order-purchase'));

const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map((key) => [key, process.env[key]]));
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
async function call(handler, { method = 'POST', body, rpc } = {}) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: userId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: userId, role: 'customer' }]);
    if (url.pathname.startsWith('/rest/v1/rpc/')) return rpc ? rpc(url, options) : response({});
    throw new Error(`unexpected ${url.pathname}`);
  };
  const res = recorder();
  await handler({ method, body, headers: { authorization: 'Bearer test-token' } }, res);
  return { res: res.out, rpcCalls: calls.filter((c) => c.url.pathname.startsWith('/rest/v1/rpc/')) };
}

const ANSWER = { id: 'req-1', elanOrderId: 'req-1', trackingNumber: 'ELN-20261108-000001', status: 'awaiting_store_confirmation', currency: 'EGP', duplicate: false, cartCleared: false };
const good = { storeId, idempotencyKey: 'retry-key-abcd-0001', expectedSubtotal: 300 };

test('the database is called with only the store, the retry key and the total shown; every other field the browser sent is dropped', async () => {
  const forged = {
    ...good,
    trackingNumber: 'CLIENT-CHOSEN-1', currency: 'USD', subtotal: 0.01, total: 0.01,
    customer: { name: 'Forged', phone: '1', address: 'x' },
    items: [{ storeProductId: 'x', quantity: 99, unitPrice: 0.01 }],
    merchantOrderNumber: 'M-1', merchantInvoiceNumber: 'INV-1', customer_snapshot: { forged: true }, userId: 'someone-else'
  };
  const { res, rpcCalls } = await call(placeOrder, { body: { payload: forged }, rpc: async () => response(ANSWER) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ANSWER);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].url.pathname, '/rest/v1/rpc/place_store_order_server');
  const sent = JSON.parse(rpcCalls[0].options.body);
  assert.deepEqual(sent, { p_payload: { storeId, idempotencyKey: 'retry-key-abcd-0001', expectedSubtotal: 300 }, p_user_id: userId }, 'the user is the verified token holder, not a field of the body');
});

test('a call without the store, a usable retry key or the total shown is refused before the database', async () => {
  const bad = [
    [{ ...good, storeId: 'not-a-uuid' }, 'invalid_store'],
    [{ ...good, storeId: undefined }, 'invalid_store'],
    [{ ...good, idempotencyKey: 'short' }, 'invalid_retry_key'],
    [{ ...good, idempotencyKey: undefined }, 'invalid_retry_key'],
    [{ ...good, idempotencyKey: 'k'.repeat(65) }, 'invalid_retry_key'],
    [{ ...good, expectedSubtotal: undefined }, 'expected_subtotal_required'],
    [{ ...good, expectedSubtotal: '300' }, 'expected_subtotal_required'],
    [{ ...good, expectedSubtotal: 0 }, 'expected_subtotal_required'],
    [{ ...good, expectedSubtotal: -5 }, 'expected_subtotal_required'],
    [{ ...good, expectedSubtotal: null }, 'expected_subtotal_required']
  ];
  for (const [payload, error] of bad) {
    const { res, rpcCalls } = await call(placeOrder, { body: { payload } });
    assert.equal(res.status, 400, error);
    assert.equal(res.body.error, error);
    assert.equal(rpcCalls.length, 0, `${error}: the database is not called`);
  }
  for (const body of [{}, { payload: [] }, { payload: 'x' }, undefined]) {
    const { res, rpcCalls } = await call(placeOrder, { body });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_order_payload');
    assert.equal(rpcCalls.length, 0);
  }
});

test('only POST is served, the answer is never cached, and a refusal of the database becomes an error key', async () => {
  const { res } = await call(placeOrder, { method: 'GET' });
  assert.equal(res.status, 405);
  const ok = await call(placeOrder, { body: { payload: good }, rpc: async () => response(ANSWER) });
  assert.equal(ok.res.headers['Cache-Control'], 'no-store');
  const refusals = [['Account details are incomplete', 'account_incomplete'], ['Cart is empty for this store', 'cart_empty'], ['Subtotal mismatch', 'subtotal_mismatch'],
    ['Product is unavailable or has insufficient stock', 'stock_unavailable'], ['Too many orders, try again later', 'order_rate_limited'], ['Only EGP orders are supported', 'currency_not_supported'],
    ['Invalid retry key', 'invalid_retry_key']];
  for (const [message, key] of refusals) {
    const { res: refused } = await call(placeOrder, { body: { payload: good }, rpc: async () => response({ code: 'P0001', message }, 400) });
    assert.equal(refused.status, 400, message);
    assert.equal(refused.body.error, key, message);
  }
  const down = await call(placeOrder, { body: { payload: good }, rpc: async () => response({ message: 'boom' }, 500) });
  assert.equal(down.res.status, 502);
});

test('the customer purchase confirmation is retired: HTTP 410, the database is never called, and no sale decision can use it', async () => {
  const { res, rpcCalls } = await call(confirmPurchase, { body: { requestId: '8f4c2a52-3c3a-4d57-9b1c-2f0f3a5d9b11' } });
  assert.equal(res.status, 410);
  assert.equal(res.body.error, 'deprecated_customer_confirmation');
  assert.equal(rpcCalls.length, 0);
  const wrongMethod = await call(confirmPurchase, { method: 'GET' });
  assert.equal(wrongMethod.res.status, 405);
});
