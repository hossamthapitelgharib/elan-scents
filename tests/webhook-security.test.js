const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const api = (name) => require(path.join(root, 'api', name));
const { safeEqual, checkSecret } = require(path.join(root, 'lib', 'secure'));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; }, end() { return this; } }; }
async function call(handler, req) { const res = recorder(); await handler(req, res); return res.out; }

const body = { trackingNumber: 'T-9', customer: { name: 'x', phone: '1', address: 'y' }, items: [{ productSizeId: 'p', quantity: 1 }], subtotal: 10, status: 'completed' };
const hits = [];
function stubFetch() { hits.length = 0; global.fetch = async (url) => { hits.push(url); return jsonResponse({ trackingNumber: 'T-9', status: 'completed', matched: true, mismatches: [] }); }; }

test('safeEqual compares secrets in constant time and rejects empty or non-string input', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual('abc', null), false);
});

test('checkSecret fails closed when the server secret is missing', () => {
  delete process.env.TEST_WEBHOOK_SECRET;
  assert.deepEqual(checkSecret({ headers: { 'x-s': 'anything' } }, 'TEST_WEBHOOK_SECRET', 'x-s'), { status: 503, error: 'test_webhook_secret_not_configured' });
  process.env.TEST_WEBHOOK_SECRET = 'good';
  assert.equal(checkSecret({ headers: { 'x-s': 'good' } }, 'TEST_WEBHOOK_SECRET', 'x-s'), null);
  assert.equal(checkSecret({ headers: { 'x-s': 'bad' } }, 'TEST_WEBHOOK_SECRET', 'x-s').status, 401);
  assert.equal(checkSecret({ headers: {} }, 'TEST_WEBHOOK_SECRET', 'x-s').status, 401);
  delete process.env.TEST_WEBHOOK_SECRET;
});

for (const name of ['store-order-status', 'store-order-cancelled']) {
  test(`${name} never reaches the database without a valid webhook secret`, async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    const handler = api(name);
    stubFetch();

    delete process.env.STORE_ORDER_WEBHOOK_SECRET;
    const open = await call(handler, { method: 'POST', headers: {}, body });
    assert.equal(open.status, 503);
    assert.equal(open.body.error, 'store_order_webhook_secret_not_configured');

    process.env.STORE_ORDER_WEBHOOK_SECRET = 'real-secret';
    const missing = await call(handler, { method: 'POST', headers: {}, body });
    const wrong = await call(handler, { method: 'POST', headers: { 'x-store-webhook-secret': 'real-secre' }, body });
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(hits.length, 0, 'no Supabase call may happen before the secret is accepted');

    const ok = await call(handler, { method: 'POST', headers: { 'x-store-webhook-secret': 'real-secret' }, body });
    assert.equal(ok.status, 200);
    assert.equal(hits.length, 1);
    delete process.env.STORE_ORDER_WEBHOOK_SECRET;
  });
}

test('dashboard token endpoints use the constant-time comparison and stay closed without a token', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  global.fetch = async () => jsonResponse([]);
  delete process.env.DASHBOARD_TOKEN;
  const unconfigured = await call(api('store-integrations'), { method: 'GET', headers: { 'x-dashboard-token': 'x' } });
  assert.equal(unconfigured.status, 503);
  process.env.DASHBOARD_TOKEN = 'dash-secret';
  const wrong = await call(api('store-integrations'), { method: 'GET', headers: { 'x-dashboard-token': 'dash-secreT' } });
  assert.equal(wrong.status, 401);
  const wrongOrders = await call(api('dashboard-orders'), { method: 'GET', headers: { 'x-dashboard-token': 'nope' }, query: {} });
  assert.equal(wrongOrders.status, 401);
  const right = await call(api('dashboard-orders'), { method: 'GET', headers: { 'x-dashboard-token': 'dash-secret' }, query: {} });
  assert.equal(right.status, 200);
  delete process.env.DASHBOARD_TOKEN;
});

test('source no longer compares secrets with === or falls back to open when unset', () => {
  const fs = require('node:fs');
  for (const f of ['store-order-status', 'store-order-cancelled', 'store-integrations', 'dashboard-orders']) {
    const src = fs.readFileSync(path.join(root, 'api', f + '.js'), 'utf8');
    assert.doesNotMatch(src, /expectedSecret\s*&&/, `${f} must not skip the check when the secret is unset`);
    assert.doesNotMatch(src, /x-(store-webhook-secret|dashboard-token)'\]\s*[!=]==/, `${f} must not use a plain comparison`);
  }
});
