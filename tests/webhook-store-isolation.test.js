const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const api = (name) => require(path.join(root, 'api', name));
const { STORE_ID_HEADER, MIN_STORE_SECRET_LENGTH } = require(path.join(root, 'lib', 'store-webhook-auth'));

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const STORE_SHORT = '33333333-3333-4333-8333-333333333333';
const STORE_MIN = '44444444-4444-4444-8444-444444444444';
const SECRETS = {
  [STORE_A]: 'isolation-secret-a-1',
  [STORE_B]: 'isolation-secret-b-1',
  [STORE_SHORT]: 'x'.repeat(MIN_STORE_SECRET_LENGTH - 1),
  [STORE_MIN]: 'y'.repeat(MIN_STORE_SECRET_LENGTH),
};
const ORDERS = [
  { store_id: STORE_A, tracking_number: 'TRK-A-1', checkout_tracking_number: 'CHK-A-1' },
  { store_id: STORE_B, tracking_number: 'TRK-B-1', checkout_tracking_number: 'CHK-B-1' },
  { store_id: STORE_SHORT, tracking_number: 'TRK-S-1', checkout_tracking_number: 'CHK-S-1' },
  { store_id: STORE_MIN, tracking_number: 'TRK-M-1', checkout_tracking_number: 'CHK-M-1' },
];

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = { headers: {} }; return { out, status(n) { out.status = n; return this; }, setHeader(name, value) { out.headers[name.toLowerCase()] = value; return this; }, json(body) { out.body = body; return this; }, end() { return this; } }; }
async function call(handler, req) { const res = recorder(); await handler(req, res); return res.out; }

// `rpcResponse` lets a test make the database function fail.
function installDatabase({ rpcResponse } = {}) {
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const entry = { pathname: url.pathname, params: url.searchParams, body: options.body ? JSON.parse(options.body) : null };
    calls.push(entry);
    const eq = (name) => { const raw = url.searchParams.get(name); return raw === null ? null : raw.replace(/^eq\./, ''); };
    if (url.pathname === '/rest/v1/store_integrations') {
      const secret = SECRETS[eq('store_id')];
      return jsonResponse(secret === undefined ? [] : [{ webhook_secret: secret, enabled: true }]);
    }
    if (url.pathname === '/rest/v1/store_order_requests') {
      const rows = ORDERS.filter((row) => row.store_id === eq('store_id')
        && (eq('tracking_number') === null || row.tracking_number === eq('tracking_number'))
        && (eq('checkout_tracking_number') === null || row.checkout_tracking_number === eq('checkout_tracking_number')));
      return jsonResponse(rows.slice(0, 1).map((row) => ({ id: row.tracking_number })));
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      if (rpcResponse) return rpcResponse(entry);
      return jsonResponse({ trackingNumber: entry.body.p_payload.trackingNumber, status: 'store_cancelled', matched: true, mismatches: [], restoreToken: 'restore-1', items: [] });
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  };
  return calls;
}
const rpcCalls = (calls) => calls.filter((c) => c.pathname.startsWith('/rest/v1/rpc/'));

let ipCounter = 0;
const nextIp = () => { ipCounter += 1; return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`; };
function webhook({ storeId = STORE_A, secret, body, headers = {} }) {
  const out = { 'x-real-ip': nextIp(), ...headers };
  if (storeId !== null) {
    out[STORE_ID_HEADER] = storeId;
    out['x-store-webhook-secret'] = secret === undefined ? SECRETS[storeId] : secret;
  }
  return { method: 'POST', headers: out, body };
}

const CASES = [
  { name: 'store-order-status', failureError: 'supabase_update_failed', makeBody: (trackingNumber, extra = {}) => ({ trackingNumber, customer: { name: 'Test', phone: '1', address: 'Addr' }, items: [{ productSizeId: 'p1', quantity: 1 }], subtotal: 10, status: 'completed', ...extra }) },
  { name: 'store-order-cancelled', failureError: 'cancellation_update_failed', makeBody: (trackingNumber, extra = {}) => ({ trackingNumber, items: [{ productSizeId: 'p1', quantity: 1 }], ...extra }) },
];

const savedEnv = {};
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STORE_ORDER_WEBHOOK_SECRET']) savedEnv[key] = process.env[key];
const savedFetch = global.fetch;
const savedConsoleError = console.error;
test.beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  delete process.env.STORE_ORDER_WEBHOOK_SECRET;
});
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  global.fetch = savedFetch;
  console.error = savedConsoleError;
});

for (const { name, failureError, makeBody } of CASES) {
  test(`${name}: idempotency keys are scoped to the store, so one store cannot occupy another store's keys`, async () => {
    const handler = api(name);
    const calls = installDatabase();
    const first = await call(handler, webhook({ storeId: STORE_A, body: makeBody('TRK-A-1', { eventId: 'evt-1' }) }));
    const other = await call(handler, webhook({ storeId: STORE_B, body: makeBody('TRK-B-1', { eventId: 'evt-1' }) }));
    const retry = await call(handler, webhook({ storeId: STORE_A, body: makeBody('TRK-A-1', { eventId: 'evt-1' }) }));
    assert.deepEqual([first.status, other.status, retry.status], [200, 200, 200]);
    const keys = rpcCalls(calls).map((c) => c.body.p_payload.idempotencyKey);
    assert.equal(keys.length, 3);
    assert.ok(keys[0].startsWith(`${STORE_A}:`));
    assert.ok(keys[1].startsWith(`${STORE_B}:`));
    assert.notEqual(keys[0], keys[1], 'the same event id from two stores must not collide');
    assert.equal(keys[0], keys[2], 'a retry by the same store must keep the same key');
    assert.ok(keys.every((key) => key !== 'evt-1' && key.length === STORE_A.length + 1 + 64), 'the key has a bounded length');

    const derived = await call(handler, webhook({ storeId: STORE_A, body: makeBody('TRK-A-1') }));
    assert.equal(derived.status, 200);
    assert.ok(rpcCalls(calls)[3].body.p_payload.idempotencyKey.startsWith(`${STORE_A}:`), 'a key derived from the payload is scoped too');
  });

  test(`${name}: the shared-secret path keeps the event id exactly as it was sent`, async () => {
    process.env.STORE_ORDER_WEBHOOK_SECRET = 'shared-secret';
    const calls = installDatabase();
    const result = await call(api(name), webhook({ storeId: null, headers: { 'x-store-webhook-secret': 'shared-secret' }, body: makeBody('TRK-A-1', { eventId: 'evt-1' }) }));
    assert.equal(result.status, 200);
    assert.equal(rpcCalls(calls)[0].body.p_payload.idempotencyKey, 'evt-1');
  });

  test(`${name}: a store never sees raw database errors, and our own 401/403/5xx is not reported as an authentication failure`, async () => {
    const logged = [];
    console.error = (...args) => { logged.push(args.join(' ')); };
    try {
      for (const [upstream, expected] of [[400, 400], [409, 409], [422, 422], [401, 502], [403, 502], [404, 502], [500, 502], [503, 502]]) {
        installDatabase({ rpcResponse: () => jsonResponse({ code: 'P0001', message: 'relation store_order_requests internal-detail', hint: 'internal-hint' }, upstream) });
        const result = await call(api(name), webhook({ body: makeBody('TRK-A-1') }));
        assert.equal(result.status, expected, `upstream ${upstream}`);
        assert.deepEqual(result.body, { ok: false, error: failureError }, `upstream ${upstream}`);
        assert.equal(JSON.stringify(result.body).includes('internal-detail'), false);
      }
      assert.ok(logged.some((line) => line.includes('HTTP 401') && line.includes('internal-detail')), 'the error is kept in the server log');
    } finally {
      console.error = savedConsoleError;
    }
  });

  test(`${name}: the shared-secret path still returns the database error details as before`, async () => {
    process.env.STORE_ORDER_WEBHOOK_SECRET = 'shared-secret';
    installDatabase({ rpcResponse: () => jsonResponse({ message: 'visible-to-the-platform' }, 400) });
    const result = await call(api(name), webhook({ storeId: null, headers: { 'x-store-webhook-secret': 'shared-secret' }, body: makeBody('TRK-A-1') }));
    assert.equal(result.status, 400);
    assert.equal(result.body.error, failureError);
    assert.deepEqual(result.body.details, { message: 'visible-to-the-platform' });
  });

  test(`${name}: a store secret shorter than ${MIN_STORE_SECRET_LENGTH} characters is never accepted`, async () => {
    const calls = installDatabase();
    const short = await call(api(name), webhook({ storeId: STORE_SHORT, body: makeBody('TRK-S-1') }));
    assert.equal(short.status, 401);
    assert.deepEqual(short.body, { ok: false, error: 'invalid_webhook_secret' });
    assert.equal(calls.some((c) => c.pathname === '/rest/v1/store_order_requests'), false);
    assert.equal(rpcCalls(calls).length, 0);
    const minimum = await call(api(name), webhook({ storeId: STORE_MIN, body: makeBody('TRK-M-1') }));
    assert.equal(minimum.status, 200, 'a secret of exactly the minimum length works');
  });
}
