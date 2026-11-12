const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const api = (name) => require(path.join(root, 'api', name));
const { STORE_ID_HEADER, RATE_LIMIT } = require(path.join(root, 'lib', 'store-webhook-auth'));
const { digest } = require(path.join(root, 'lib', 'store-webhook-signature'));

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const STORE_NO_SECRET = '33333333-3333-4333-8333-333333333333';
const STORE_UNKNOWN = '44444444-4444-4444-8444-444444444444';
const STORE_DISABLED = '55555555-5555-4555-8555-555555555555';
const SECRETS = { [STORE_A]: 'unit-test-secret-a', [STORE_B]: 'unit-test-secret-b', [STORE_NO_SECRET]: '', [STORE_DISABLED]: 'unit-test-secret-disabled' };
const DISABLED = new Set([STORE_DISABLED]);
const ORDERS = [
  { id: 'req-a1', store_id: STORE_A, tracking_number: 'TRK-A-1', checkout_tracking_number: 'CHK-A-1' },
  { id: 'req-b1', store_id: STORE_B, tracking_number: 'TRK-B-1', checkout_tracking_number: 'CHK-B-1' },
];

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = { headers: {} }; return { out, status(n) { out.status = n; return this; }, setHeader(name, value) { out.headers[name.toLowerCase()] = value; return this; }, json(body) { out.body = body; return this; }, end() { return this; } }; }
async function call(handler, req) { const res = recorder(); await handler(req, res); return res.out; }

// In-memory stand-in for the three Supabase resources these handlers touch.
function installDatabase({ failIntegrationLookup = false, failOrderLookup = false } = {}) {
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const call = { pathname: url.pathname, params: url.searchParams, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    const eq = (name) => { const raw = url.searchParams.get(name); return raw === null ? null : raw.replace(/^eq\./, ''); };
    if (url.pathname === '/rest/v1/store_integrations') {
      if (failIntegrationLookup) return jsonResponse({ message: 'down' }, 500);
      const secret = SECRETS[eq('store_id')];
      return jsonResponse(secret === undefined ? [] : [{ webhook_secret: secret, enabled: !DISABLED.has(eq('store_id')) }]);
    }
    if (url.pathname === '/rest/v1/store_order_requests') {
      if (failOrderLookup) return jsonResponse({ message: 'down' }, 500);
      const rows = ORDERS.filter((row) => row.store_id === eq('store_id')
        && (eq('tracking_number') === null || row.tracking_number === eq('tracking_number'))
        && (eq('checkout_tracking_number') === null || row.checkout_tracking_number === eq('checkout_tracking_number')));
      return jsonResponse(rows.slice(0, 1).map((row) => ({ id: row.id })));
    }
    if (url.pathname === '/rest/v1/rpc/receive_store_order_notification') return jsonResponse({ trackingNumber: call.body.p_payload.trackingNumber, status: 'completed', matched: true, mismatches: [] });
    if (url.pathname === '/rest/v1/rpc/cancel_store_order_request') return jsonResponse({ trackingNumber: call.body.p_payload.trackingNumber, status: 'store_cancelled', matched: true, mismatches: [], restoreToken: 'restore-1', items: [] });
    throw new Error(`unexpected request to ${url.pathname}`);
  };
  return calls;
}
const rpcCalls = (calls) => calls.filter((c) => c.pathname.startsWith('/rest/v1/rpc/'));
const lookups = (calls) => calls.filter((c) => !c.pathname.startsWith('/rest/v1/rpc/'));

let ipCounter = 0;
const nextIp = () => { ipCounter += 1; return `203.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`; };
function webhook({ storeId = STORE_A, secret = SECRETS[STORE_A], body, ip = nextIp(), headers = {} }) {
  const out = { 'x-real-ip': ip, ...headers };
  if (storeId !== null) out[STORE_ID_HEADER] = storeId;
  if (secret !== null) out['x-store-webhook-secret'] = secret;
  return { method: 'POST', headers: out, body };
}

const CASES = [
  { name: 'store-order-status', rpc: 'receive_store_order_notification', makeBody: (trackingNumber) => ({ trackingNumber, customer: { name: 'Test', phone: '1', address: 'Addr' }, items: [{ productSizeId: '8d3f2a54-6c1b-4a0e-9b7d-5e2c1f0a9b34', quantity: 1 }], subtotal: 10, status: 'completed' }) },
  { name: 'store-order-cancelled', rpc: 'cancel_store_order_request', makeBody: (trackingNumber) => ({ trackingNumber, items: [{ productSizeId: 'p1', quantity: 1 }] }) },
];

const savedEnv = {};
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STORE_ORDER_WEBHOOK_SECRET', 'LEGACY_WEBHOOK_ENABLED', 'STORE_WEBHOOK_SIGNATURE_REQUIRED']) savedEnv[key] = process.env[key];
const savedFetch = global.fetch;
test.beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.LEGACY_WEBHOOK_ENABLED = '1';
  process.env.STORE_WEBHOOK_SIGNATURE_REQUIRED = '0';
  delete process.env.STORE_ORDER_WEBHOOK_SECRET;
});
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  global.fetch = savedFetch;
});

for (const { name, rpc, makeBody } of CASES) {
  test(`${name}: a store's own secret is accepted without the shared secret and the order is checked against that store`, async () => {
    const calls = installDatabase();
    const result = await call(api(name), webhook({ body: makeBody('TRK-A-1') }));
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(calls.map((c) => c.pathname), ['/rest/v1/store_integrations', '/rest/v1/store_order_requests', `/rest/v1/rpc/${rpc}`]);
    assert.equal(calls[0].params.get('store_id'), `eq.${STORE_A}`);
    assert.equal(calls[0].params.get('select'), 'webhook_secret,enabled');
    assert.equal(calls[1].params.get('store_id'), `eq.${STORE_A}`);
    assert.equal(calls[1].params.get('tracking_number'), 'eq.TRK-A-1');
  });

  test(`${name}: the store id header is case-insensitive`, async () => {
    installDatabase();
    const result = await call(api(name), webhook({ storeId: STORE_A.toUpperCase(), body: makeBody('TRK-A-1') }));
    assert.equal(result.status, 200);
  });

  test(`${name}: every authentication failure gets the same 401 and never reaches the RPC`, async () => {
    const handler = api(name);
    const calls = installDatabase();
    const wrong = await call(handler, webhook({ secret: 'not-the-secret', body: makeBody('TRK-A-1') }));
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, { ok: false, error: 'invalid_webhook_secret' });
    assert.deepEqual(lookups(calls).map((c) => c.pathname), ['/rest/v1/store_integrations']);
    assert.equal(rpcCalls(calls).length, 0);

    process.env.STORE_ORDER_WEBHOOK_SECRET = 'shared-secret';
    const failures = {
      'unknown store': webhook({ storeId: STORE_UNKNOWN, body: makeBody('TRK-A-1') }),
      'store without a secret': webhook({ storeId: STORE_NO_SECRET, secret: 'anything', body: makeBody('TRK-A-1') }),
      'switched-off integration with the right secret': webhook({ storeId: STORE_DISABLED, secret: SECRETS[STORE_DISABLED], body: makeBody('TRK-A-1') }),
      "another store's secret": webhook({ secret: SECRETS[STORE_B], body: makeBody('TRK-A-1') }),
      'the shared secret instead of the store secret': webhook({ secret: 'shared-secret', body: makeBody('TRK-A-1') }),
    };
    for (const [label, req] of Object.entries(failures)) {
      const result = await call(handler, req);
      assert.equal(result.status, wrong.status, label);
      assert.deepEqual(result.body, wrong.body, label);
    }
    assert.equal(rpcCalls(calls).length, 0);

    const before = calls.length;
    const missing = await call(handler, webhook({ secret: null, body: makeBody('TRK-A-1') }));
    assert.equal(missing.status, 401);
    assert.deepEqual(missing.body, wrong.body);
    assert.equal(calls.length, before, 'a request without a secret must not touch Supabase');
  });

  test(`${name}: an unknown order and another store's order get the same 404, which differs from an authentication failure`, async () => {
    const handler = api(name);
    const calls = installDatabase();
    const wrong = await call(handler, webhook({ secret: 'nope', body: makeBody('TRK-A-1') }));
    const otherStoreOrder = await call(handler, webhook({ body: makeBody('TRK-B-1') }));
    const unknownOrder = await call(handler, webhook({ body: makeBody('TRK-NOBODY') }));
    assert.equal(otherStoreOrder.status, 404);
    assert.deepEqual(otherStoreOrder.body, { ok: false, error: 'order_not_found' });
    assert.deepEqual(unknownOrder, { ...otherStoreOrder, headers: unknownOrder.headers }, 'the two cases must be indistinguishable');
    assert.equal(wrong.status, 401, 'a failed authentication is still a 401');
    assert.equal(rpcCalls(calls).length, 0, 'the RPC must never run for an order the store does not own');
  });

  test(`${name}: the tracking number is sent to Supabase as one encoded value`, async () => {
    const calls = installDatabase();
    const result = await call(api(name), webhook({ body: makeBody('TRK-B-1&store_id=neq.nobody') }));
    assert.equal(result.status, 404);
    const orderLookup = calls.find((c) => c.pathname === '/rest/v1/store_order_requests');
    assert.equal(orderLookup.params.get('tracking_number'), 'eq.TRK-B-1&store_id=neq.nobody');
    assert.equal(orderLookup.params.get('store_id'), `eq.${STORE_A}`);
    assert.equal(rpcCalls(calls).length, 0);
  });

  test(`${name}: a Supabase failure while checking is a retryable 502, not a 401`, async () => {
    installDatabase({ failIntegrationLookup: true });
    const down = await call(api(name), webhook({ body: makeBody('TRK-A-1') }));
    assert.equal(down.status, 502);
    assert.equal(down.body.error, 'store_auth_unavailable');
    const calls = installDatabase({ failOrderLookup: true });
    const orderDown = await call(api(name), webhook({ body: makeBody('TRK-A-1') }));
    assert.equal(orderDown.status, 502);
    assert.equal(orderDown.body.error, 'store_auth_unavailable');
    assert.equal(rpcCalls(calls).length, 0);
  });

  test(`${name}: requests without a UUID store header keep using the shared secret only`, async () => {
    const handler = api(name);
    const calls = installDatabase();
    delete process.env.STORE_ORDER_WEBHOOK_SECRET;
    assert.equal((await call(handler, webhook({ storeId: null, secret: 'x', body: makeBody('TRK-A-1') }))).status, 503);
    process.env.STORE_ORDER_WEBHOOK_SECRET = 'shared-secret';
    for (const storeId of [null, 'not-a-uuid', '']) {
      const wrongShared = await call(handler, webhook({ storeId, secret: 'wrong', body: makeBody('TRK-A-1') }));
      assert.equal(wrongShared.status, 401, `header ${JSON.stringify(storeId)}`);
      assert.deepEqual(wrongShared.body, { ok: false, error: 'invalid_webhook_secret' });
      const okShared = await call(handler, webhook({ storeId, secret: 'shared-secret', body: makeBody('TRK-A-1') }));
      assert.equal(okShared.status, 200, `header ${JSON.stringify(storeId)}`);
    }
    assert.equal(lookups(calls).length, 0, 'the shared-secret path must not read store_integrations or store_order_requests');
  });
}

for (const { name, rpc, makeBody } of CASES) {
  test(`${name}: secure defaults reject unsigned store calls and disable legacy fallback`, async () => {
    delete process.env.STORE_WEBHOOK_SIGNATURE_REQUIRED;
    delete process.env.LEGACY_WEBHOOK_ENABLED;
    process.env.STORE_ORDER_WEBHOOK_SECRET = 'shared-secret';
    const calls = installDatabase();
    const handler = api(name);
    const body = makeBody('TRK-A-1');

    const unsigned = await call(handler, webhook({ body }));
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.body.error, 'invalid_webhook_signature');
    assert.equal(rpcCalls(calls).length, 0);

    const legacy = await call(handler, webhook({ storeId: null, secret: 'shared-secret', body }));
    assert.equal(legacy.status, 410);
    assert.equal(legacy.body.error, 'legacy_webhook_disabled');
    assert.equal(rpcCalls(calls).length, 0);
    assert.equal(calls.length, 1, 'only the signed store integration lookup is reached');
  });

  test(`${name}: a valid HMAC passes and its event id is sent into store-scoped idempotency`, async () => {
    delete process.env.LEGACY_WEBHOOK_ENABLED;
    process.env.STORE_WEBHOOK_SIGNATURE_REQUIRED = '1';
    const calls = installDatabase();
    const handler = api(name);
    const body = makeBody('TRK-A-1');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const eventId = 'signed-event-1';
    const signature = digest(SECRETS[STORE_A], timestamp, eventId, body);
    const result = await call(handler, webhook({ body, headers: {
      'x-webhook-timestamp': timestamp,
      'x-webhook-id': eventId,
      'x-webhook-signature': signature
    } }));
    assert.equal(result.status, 200);
    const rpcCall = rpcCalls(calls)[0];
    assert.ok(rpcCall.body.p_payload.idempotencyKey.startsWith(`${STORE_A}:`));
    assert.notEqual(rpcCall.body.p_payload.idempotencyKey, eventId);
  });
}

test('store-order-cancelled: the store id in the body is replaced by the authenticated store', async () => {
  const calls = installDatabase();
  const result = await call(api('store-order-cancelled'), webhook({ body: { trackingNumber: 'TRK-A-1', storeId: STORE_B, items: [{ productSizeId: 'p1', quantity: 1 }] } }));
  assert.equal(result.status, 200);
  const [rpc] = rpcCalls(calls);
  assert.equal(rpc.body.p_payload.storeId, STORE_A);
});

test('store-order-cancelled: the checkout tracking number works only for the store that owns it', async () => {
  const calls = installDatabase();
  const own = await call(api('store-order-cancelled'), webhook({ body: { trackingNumber: 'CHK-A-1', items: [{ productSizeId: 'p1', quantity: 1 }] } }));
  assert.equal(own.status, 200);
  assert.equal(rpcCalls(calls).length, 1);
  const other = await call(api('store-order-cancelled'), webhook({ body: { trackingNumber: 'CHK-B-1', items: [{ productSizeId: 'p1', quantity: 1 }] } }));
  assert.equal(other.status, 404);
  assert.deepEqual(other.body, { ok: false, error: 'order_not_found' });
  assert.equal(rpcCalls(calls).length, 1);
});

test('per-store webhook attempts are rate limited per IP before any database call', async () => {
  const calls = installDatabase();
  const handler = api('store-order-status');
  const body = CASES[0].makeBody('TRK-A-1');
  const attacker = nextIp();
  for (let i = 0; i < RATE_LIMIT.max; i += 1) {
    const result = await call(handler, webhook({ ip: attacker, secret: `guess-${i}`, body }));
    assert.equal(result.status, 401, `attempt ${i + 1}`);
  }
  const used = calls.length;
  const limited = await call(handler, webhook({ ip: attacker, secret: SECRETS[STORE_A], body }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'too_many_requests');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(calls.length, used, 'a limited request must not reach Supabase');

  const spoofed = await call(handler, webhook({ ip: attacker, headers: { 'x-forwarded-for': '198.51.100.99' }, body }));
  assert.equal(spoofed.status, 429, 'rotating X-Forwarded-For must not give a fresh allowance');

  const otherIp = await call(handler, webhook({ ip: nextIp(), body }));
  assert.equal(otherIp.status, 200, 'another address is not affected');

  process.env.STORE_ORDER_WEBHOOK_SECRET = 'shared-secret';
  const shared = await call(handler, webhook({ ip: attacker, storeId: null, secret: 'shared-secret', body }));
  assert.equal(shared.status, 200, 'the shared-secret path is not counted by this limit');
});
