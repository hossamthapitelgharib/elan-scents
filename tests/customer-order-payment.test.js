// POST /api/customer-order-payment (phase 2): the signed-in customer picks how to pay an approved order.
// Only the order, the method and the retry key are read; the user is the verified token holder; a card choice answers with the
// merchant's payment page (never "paid"); a cash-on-delivery choice has no page; the database's own refusals get safe names.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'customer-order-payment'));

const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const orderId = 'a1111111-1111-4111-8111-111111111111';
const methodId = 'b2222222-2222-4222-8222-222222222222';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map((key) => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : process.env[k] = v; });

const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = { headers: {} }; return { out, status(v) { out.status = v; return this; }, setHeader(k, v) { out.headers[k] = v; return this; }, json(b) { out.body = b; return this; } }; }
async function call({ method = 'POST', body, rpc, token = 'Bearer test-token' } = {}) {
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
  await handler({ method, body, headers: token ? { authorization: token } : {} }, res);
  return { res: res.out, rpcCalls: calls.filter((c) => c.url.pathname.startsWith('/rest/v1/rpc/')) };
}
const good = { requestId: orderId, methodId, idempotencyKey: 'pay-retry-key-0001' };
const CARD = { paymentId: 'p1', trackingNumber: 'ELN-20261111-000001', kind: 'card', mode: 'redirect', provider: 'merchant', status: 'initiated', paymentStatus: 'awaiting_payment', amount: 230, currency: 'EGP', redirectUrl: 'https://pay.merchant.example/checkout?lang=ar' };
const COD = { ...CARD, kind: 'cod', mode: 'none', status: 'cod_selected', paymentStatus: 'cod_selected', redirectUrl: null };

test('the database is called with the verified user and only the order, the method and the retry key', async () => {
  const { res, rpcCalls } = await call({ body: { ...good, amount: 1, currency: 'USD', userId: 'someone-else', paid: true }, rpc: async () => response(CARD) });
  assert.equal(res.status, 200);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].url.pathname, '/rest/v1/rpc/select_order_payment_server');
  assert.deepEqual(JSON.parse(rpcCalls[0].options.body), { p_request_id: orderId, p_user_id: userId, p_method_id: methodId, p_idempotency_key: 'pay-retry-key-0001' });
});

test('a card choice answers with the merchant payment page carrying the order and the frozen amount, and is NOT paid', async () => {
  const { res } = await call({ body: good, rpc: async () => response(CARD) });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.paymentStatus, 'awaiting_payment');
  const url = new URL(res.body.paymentUrl);
  assert.equal(url.origin, 'https://pay.merchant.example');
  assert.equal(url.searchParams.get('lang'), 'ar', 'the merchant\'s own query string stays');
  assert.equal(url.searchParams.get('elan_order'), 'ELN-20261111-000001');
  assert.equal(url.searchParams.get('amount'), '230');
  assert.equal(url.searchParams.get('currency'), 'EGP');
  assert.equal('paid' in res.body, false);
});

test('cash on delivery has no payment page; a non-https page is never handed out', async () => {
  let out = await call({ body: good, rpc: async () => response(COD) });
  assert.equal(out.res.body.paymentUrl, null);
  assert.equal(out.res.body.paymentStatus, 'cod_selected');
  out = await call({ body: good, rpc: async () => response({ ...CARD, redirectUrl: 'http://pay.example/insecure' }) });
  assert.equal(out.res.body.paymentUrl, null);
  out = await call({ body: good, rpc: async () => response({ ...CARD, redirectUrl: 'javascript:alert(1)' }) });
  assert.equal(out.res.body.paymentUrl, null);
});

test('bad input never reaches the database', async () => {
  for (const body of [{ ...good, requestId: 'x' }, { ...good, methodId: '' }, { ...good, idempotencyKey: 'short' }, { ...good, idempotencyKey: 'has space in it!!' }, {}]) {
    const { res, rpcCalls } = await call({ body });
    assert.equal(res.status, 400);
    assert.equal(rpcCalls.length, 0);
  }
  assert.equal((await call({ body: good, method: 'GET' })).res.status, 405);
  const anonymous = await call({ body: good, token: '' });
  assert.equal(anonymous.res.status, 401);
  assert.equal(anonymous.rpcCalls.length, 0);
});

test('the database refusals get safe, specific names (not approved, already settled, not offered, not the owner)', async () => {
  const refuse = (message) => async () => response({ code: 'P0001', message }, 400);
  const cases = [
    ['Order is not approved for payment', 'order_not_approved'],
    ['Payment is already settled', 'payment_already_settled'],
    ['Payment method is not offered for this order', 'payment_method_not_offered'],
    ['Order not found', 'order_not_found'],
    ['Order has no payable amount', 'order_no_amount']
  ];
  for (const [message, error] of cases) {
    const { res } = await call({ body: good, rpc: refuse(message) });
    assert.equal(res.status, 400, message);
    assert.equal(res.body.error, error, message);
  }
  const { res } = await call({ body: good, rpc: async () => new Response('boom', { status: 500 }) });
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(res.body), /boom/);
});
