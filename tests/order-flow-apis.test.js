// Stage 1 of docs/purchase-flow-correction-plan.ar.md, the Worker side: the order page's draft, the placing of the order with its first attempt to
// reach the merchant, the polling that drives the next attempts, the customer's side of the merchant's payment window, and the readiness
// list that locks the order button of a store that is not technically linked. The database is a fake; a merchant simulator answers the
// signed message. The database rules themselves are tested live in tests/stage1-send-review-window.test.sql.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { verify } = require('../lib/store-webhook-signature');
const { errorKey } = require('../lib/customer-rpc');

const api = (name) => require(path.join(__dirname, '..', 'api', name));
const USER = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const STORE = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const ORDER = '0d3b6f0a-1d6e-4c41-9e0c-4f6c3d1b2a77';
const DRAFT = '5b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8';
const DELIVERY = '9a5c1f6e-8b0f-4b79-b3a9-2f6d7c5e1a10';
const SECRET = 'merchant-shared-secret-0001';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map((key) => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() {
  const out = { headers: {} };
  return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } };
}

/* rpcs: { name: (body) => Response | data }, merchant: (url, options) => Response. Records every call in order. */
async function call(handler, { method = 'POST', body, rpcs = {}, merchant, headers, role = 'customer' } = {}) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin === 'https://test.supabase.co') {
      if (url.pathname === '/auth/v1/user') return json({ id: USER });
      if (url.pathname === '/rest/v1/profiles') return json([{ id: USER, role }]);
      const name = url.pathname.replace('/rest/v1/rpc/', '');
      const sent = options.body ? JSON.parse(options.body) : {};
      calls.push({ kind: 'rpc', name, body: sent });
      if (!rpcs[name]) throw new Error(`unexpected rpc ${name}`);
      const answer = await rpcs[name](sent);
      return answer instanceof Response ? answer : json(answer);
    }
    calls.push({ kind: 'merchant', url: String(input), options });
    if (!merchant) throw new Error(`unexpected request to ${url.origin}`);
    return merchant(String(input), options);
  };
  const res = recorder();
  await handler({ method, body, headers: headers === undefined ? { authorization: 'Bearer test-token', 'x-forwarded-for': '203.0.113.7' } : headers }, res);
  return { res: res.out, calls };
}
const rpcNames = (calls) => calls.filter((c) => c.kind === 'rpc').map((c) => c.name);

// ---------------------------------------------------------------- the draft
test('order-draft: the signed-in customer reserves the number of the order they are about to place; the browser chooses only the store', async () => {
  const draft = { draftId: DRAFT, trackingNumber: 'ELN-20261117-000042', expiresAt: '2026-11-17T12:00:00Z' };
  const { res, calls } = await call(api('order-draft'), { body: { storeId: STORE, userId: 'someone-else', trackingNumber: 'CHOSEN' }, rpcs: { reserve_order_draft: () => draft } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, ...draft });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls.find((c) => c.name === 'reserve_order_draft').body, { p_user_id: USER, p_store_id: STORE });
});

test('order-draft: refuses wrong method, no session, a bad store, and says "store not connected" when the database does', async () => {
  const method = await call(api('order-draft'), { method: 'GET' });
  assert.equal(method.res.status, 405);
  const noSession = await call(api('order-draft'), { body: { storeId: STORE }, headers: {} });
  assert.equal(noSession.res.status, 401);
  assert.deepEqual(rpcNames(noSession.calls), []);
  const bad = await call(api('order-draft'), { body: { storeId: 'nope' } });
  assert.deepEqual([bad.res.status, bad.res.body.error], [400, 'invalid_store']);
  assert.deepEqual(rpcNames(bad.calls), []);
  const unlinked = await call(api('order-draft'), { body: { storeId: STORE }, rpcs: { reserve_order_draft: () => json({ code: 'P0001', message: 'Store is not connected' }, 400) } });
  assert.deepEqual([unlinked.res.status, unlinked.res.body.error], [400, 'store_not_connected']);
});

// ---------------------------------------------------------------- placing the order and the first attempt
const PLACED = { id: ORDER, elanOrderId: ORDER, trackingNumber: 'ELN-20261117-000042', status: 'awaiting_store_confirmation', currency: 'EGP', duplicate: false, cartCleared: false };
const body = { payload: { storeId: STORE, idempotencyKey: 'retry-key-abcd-0001', expectedSubtotal: 300, draftId: DRAFT, trackingNumber: 'CLIENT-CHOSEN', total: 1 } };

test('place-store-order: forwards the draft, makes the first attempt to reach the merchant, and answers with where the order stands', async () => {
  const job = {
    deliveryId: DELIVERY, attemptNo: 1, kind: 'order', maxAttempts: 6, storeId: STORE, endpoint: 'https://orders.merchant-store.com/elan', secret: SECRET,
    requestId: ORDER, trackingNumber: PLACED.trackingNumber, payload: { type: 'elan_order', version: 1, elanOrderId: ORDER, trackingNumber: PLACED.trackingNumber }
  };
  let reported = null;
  const state = { id: ORDER, trackingNumber: PLACED.trackingNumber, status: 'awaiting_payment', paymentStatus: 'awaiting_payment', delivery: { state: 'done', attempts: 1, maxAttempts: 6 }, window: { state: 'open' } };
  const { res, calls } = await call(api('place-store-order'), {
    body,
    rpcs: {
      place_store_order_server: () => PLACED,
      claim_merchant_deliveries: () => [job],
      finish_merchant_delivery: (sent) => { reported = sent; return { ok: true }; },
      customer_order_state: () => state
    },
    merchant: (url, options) => {
      const headers = Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v]));
      assert.equal(verify({ headers, body: options.body }, SECRET).ok, true, 'the order is signed with the store secret');
      return json({ decision: 'approve', paymentWindowUrl: 'https://pay.merchant-store.com/w/1' });
    }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(rpcNames(calls), ['place_store_order_server', 'claim_merchant_deliveries', 'finish_merchant_delivery', 'customer_order_state']);
  assert.deepEqual(calls[0].body, { p_payload: { storeId: STORE, idempotencyKey: 'retry-key-abcd-0001', expectedSubtotal: 300, draftId: DRAFT }, p_user_id: USER }, 'only the allowed fields reach the database');
  assert.deepEqual(calls[1].body, { p_request_id: ORDER, p_limit: 1 });
  assert.equal(reported.p_result.reply.decision, 'approve');
  assert.deepEqual(res.body, { ...PLACED, state });
  assert.ok(!JSON.stringify(res.body).includes('pay.merchant-store.com'), "the merchant's window address is not part of the answer");
});

test('place-store-order: a merchant that does not answer never fails the placing; the order exists and the answer says it is still being sent', async () => {
  const job = { deliveryId: DELIVERY, attemptNo: 1, kind: 'order', maxAttempts: 6, storeId: STORE, endpoint: 'https://orders.merchant-store.com/elan', secret: SECRET, requestId: ORDER, trackingNumber: PLACED.trackingNumber, payload: {} };
  const state = { id: ORDER, status: 'awaiting_store_confirmation', delivery: { state: 'pending', attempts: 1, maxAttempts: 6 }, window: null };
  let reported = null;
  const { res } = await call(api('place-store-order'), {
    body,
    rpcs: { place_store_order_server: () => PLACED, claim_merchant_deliveries: () => [job], finish_merchant_delivery: (s) => { reported = s; return {}; }, customer_order_state: () => state },
    merchant: () => { throw new TypeError('fetch failed'); }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(reported.p_result.failureKind, 'network');
  assert.deepEqual(res.body.state, state);
});

test('place-store-order: a failing first attempt machinery still returns the order (the page polls and the Cron Trigger retries)', async () => {
  const log = console.error;
  console.error = () => {};
  try {
    const { res } = await call(api('place-store-order'), {
      body,
      rpcs: { place_store_order_server: () => PLACED, claim_merchant_deliveries: () => json({ message: 'boom' }, 500), customer_order_state: () => json({ message: 'boom' }, 500) }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, ORDER);
    assert.equal(res.body.state, null);
  } finally { console.error = log; }
});

test('place-store-order: a bad draft number is refused before the database; a replay of the same key does not break', async () => {
  const bad = await call(api('place-store-order'), { body: { payload: { ...body.payload, draftId: 'not-a-uuid' } } });
  assert.deepEqual([bad.res.status, bad.res.body.error], [400, 'order_page_expired']);
  assert.deepEqual(rpcNames(bad.calls), []);
  const expired = await call(api('place-store-order'), { body, rpcs: { place_store_order_server: () => json({ code: 'P0001', message: 'Order page expired' }, 400) } });
  assert.deepEqual([expired.res.status, expired.res.body.error], [400, 'order_page_expired']);
  const unlinked = await call(api('place-store-order'), { body, rpcs: { place_store_order_server: () => json({ code: 'P0001', message: 'Store is not connected' }, 400) } });
  assert.deepEqual([unlinked.res.status, unlinked.res.body.error], [400, 'store_not_connected']);
  const replay = await call(api('place-store-order'), {
    body,
    rpcs: { place_store_order_server: () => ({ ...PLACED, duplicate: true }), claim_merchant_deliveries: () => [], customer_order_state: () => ({ id: ORDER, status: 'awaiting_payment' }) }
  });
  assert.equal(replay.res.status, 200);
  assert.equal(replay.res.body.duplicate, true);
});

// ---------------------------------------------------------------- the order page's polling
test('customer-order-review: while the store has not decided, each question also makes the next due attempt, then answers again with the fresh state', async () => {
  const waiting = { id: ORDER, status: 'awaiting_store_confirmation', delivery: { state: 'pending', attempts: 2, maxAttempts: 6 }, window: null };
  const approved = { id: ORDER, status: 'awaiting_payment', delivery: { state: 'done', attempts: 3, maxAttempts: 6 }, window: { state: 'open' } };
  let reads = 0;
  const job = { deliveryId: DELIVERY, attemptNo: 3, kind: 'order', maxAttempts: 6, storeId: STORE, endpoint: 'https://orders.merchant-store.com/elan', secret: SECRET, requestId: ORDER, trackingNumber: 'ELN-1', payload: {} };
  const { res, calls } = await call(api('customer-order-review'), {
    body: { orderId: ORDER },
    rpcs: { customer_order_state: () => (++reads === 1 ? waiting : approved), claim_merchant_deliveries: () => [job], finish_merchant_delivery: () => ({}) },
    merchant: () => json({ decision: 'approve', paymentWindowUrl: 'https://pay.merchant-store.com/w/1' })
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, ...approved });
  assert.deepEqual(rpcNames(calls), ['customer_order_state', 'claim_merchant_deliveries', 'finish_merchant_delivery', 'customer_order_state']);
  assert.deepEqual(calls[0].body, { p_request_id: ORDER, p_user_id: USER });
});

test('customer-order-review: an order that is not waiting for the store is only read; another customer\'s order or a made-up id is "not found"', async () => {
  const done = { id: ORDER, status: 'cancelled', cancelReason: 'payment_window_closed', delivery: null, window: null };
  const read = await call(api('customer-order-review'), { body: { orderId: ORDER }, rpcs: { customer_order_state: () => done } });
  assert.deepEqual(read.res.body, { ok: true, ...done });
  assert.deepEqual(rpcNames(read.calls), ['customer_order_state'], 'no attempt is made for an order that is already decided');
  const foreign = await call(api('customer-order-review'), { body: { orderId: ORDER }, rpcs: { customer_order_state: () => json({ code: 'P0001', message: 'Order not found' }, 400) } });
  assert.deepEqual([foreign.res.status, foreign.res.body.error], [404, 'order_not_found']);
  const bad = await call(api('customer-order-review'), { body: { orderId: 'x' } });
  assert.deepEqual([bad.res.status, bad.res.body.error], [400, 'order_not_found']);
  assert.equal((await call(api('customer-order-review'), { method: 'GET' })).res.status, 405);
  assert.equal((await call(api('customer-order-review'), { body: { orderId: ORDER }, headers: {} })).res.status, 401);
});

// ---------------------------------------------------------------- the merchant's payment window, customer side
test('customer-order-window: open gives the merchant window address to the order\'s own customer; the database decides who and when', async () => {
  const opened = { state: 'open', url: 'https://pay.merchant-store.com/w/1', trackingNumber: 'ELN-1' };
  const { res, calls } = await call(api('customer-order-window'), { body: { orderId: ORDER, action: 'open', userId: 'someone-else' }, rpcs: { open_payment_window: () => opened } });
  assert.deepEqual(res.body, { ok: true, ...opened });
  assert.deepEqual(calls[0].body, { p_request_id: ORDER, p_user_id: USER });
  const closed = await call(api('customer-order-window'), { body: { orderId: ORDER, action: 'open' }, rpcs: { open_payment_window: () => json({ code: 'P0001', message: 'Order has no open payment window' }, 400) } });
  assert.deepEqual([closed.res.status, closed.res.body.error], [409, 'window_unavailable']);
  const gone = await call(api('customer-order-window'), { body: { orderId: ORDER, action: 'open' }, rpcs: { open_payment_window: () => json({ code: 'P0001', message: 'Order not found' }, 400) } });
  assert.deepEqual([gone.res.status, gone.res.body.error], [404, 'order_not_found']);
});

test('customer-order-window: returning from the window reports only success, cancel or closed; nothing here decides that an order is paid', async () => {
  for (const outcome of ['success', 'cancel', 'closed']) {
    const { res, calls } = await call(api('customer-order-window'), { body: { orderId: ORDER, action: 'return', outcome }, rpcs: { payment_window_return: () => ({ state: outcome === 'success' ? 'awaiting_payment' : 'cancelled' }) } });
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0].body, { p_request_id: ORDER, p_user_id: USER, p_outcome: outcome });
  }
  for (const outcome of ['paid', 'approved', '', undefined]) {
    const { res, calls } = await call(api('customer-order-window'), { body: { orderId: ORDER, action: 'return', outcome } });
    assert.deepEqual([res.status, res.body.error], [400, 'invalid_outcome']);
    assert.deepEqual(rpcNames(calls), []);
  }
  const state = await call(api('customer-order-window'), { body: { orderId: ORDER, action: 'state' }, rpcs: { customer_order_state: () => ({ id: ORDER, status: 'awaiting_payment' }) } });
  assert.deepEqual(state.res.body, { ok: true, id: ORDER, status: 'awaiting_payment' });
  const unknown = await call(api('customer-order-window'), { body: { orderId: ORDER, action: 'pay' } });
  assert.deepEqual([unknown.res.status, unknown.res.body.error], [400, 'invalid_action']);
  const bad = await call(api('customer-order-window'), { body: { orderId: 'x', action: 'open' } });
  assert.deepEqual([bad.res.status, bad.res.body.error], [400, 'order_not_found']);
  assert.equal((await call(api('customer-order-window'), { body: { orderId: ORDER, action: 'open' }, headers: {} })).res.status, 401);
});

// ---------------------------------------------------------------- readiness
test('store-order-readiness: a yes or a no per store, nothing else, cached for half a minute', async () => {
  const other = '11111111-1111-4111-8111-111111111111';
  const { res, calls } = await call(api('store-order-readiness'), {
    method: 'GET', headers: { 'x-forwarded-for': '198.51.100.9' },
    rpcs: { store_order_readiness: () => [{ store_id: STORE, ready: true }, { store_id: other, ready: false }] }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, stores: { [STORE]: true, [other]: false } });
  assert.equal(res.headers['Cache-Control'], 'public, max-age=30');
  assert.deepEqual(calls[0].body, {});
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /endpoint|secret|https?:/i);
});

test('store-order-readiness: does not answer other methods, and says "unavailable" (never "ready") when the database cannot be read', async () => {
  assert.equal((await call(api('store-order-readiness'), { method: 'POST', headers: {} })).res.status, 405);
  const down = await call(api('store-order-readiness'), { method: 'GET', headers: { 'x-forwarded-for': '198.51.100.10' }, rpcs: { store_order_readiness: () => json({ message: 'down' }, 500) } });
  assert.deepEqual([down.res.status, down.res.body.error], [502, 'readiness_unavailable']);
  assert.equal(down.res.headers['Cache-Control'], 'no-store');
  const garbage = await call(api('store-order-readiness'), { method: 'GET', headers: { 'x-forwarded-for': '198.51.100.11' }, rpcs: { store_order_readiness: () => ({ nope: true }) } });
  assert.equal(garbage.res.status, 502);
});

// ---------------------------------------------------------------- shared pieces
test('the database messages of this stage have their own keys', () => {
  const key = (message) => errorKey({ code: 'P0001', message });
  assert.equal(key('Store is not connected'), 'store_not_connected');
  assert.equal(key('Order page expired'), 'order_page_expired');
  assert.equal(key('Order has no open payment window'), 'window_unavailable');
  assert.equal(key('Order has no payment window'), 'window_unavailable');
  assert.equal(key('Invalid outcome'), 'invalid_outcome');
  assert.equal(key('Order not found'), 'order_not_found');
});

test('the Worker knows every new endpoint and the scheduled job, and the Cron Trigger runs every minute', () => {
  const registry = require('../cloudflare/api-registry.js');
  for (const name of ['order-draft', 'customer-order-review', 'customer-order-window', 'store-order-readiness']) {
    assert.equal(typeof registry.api[name], 'function', name);
    assert.equal(typeof registry.api[name](), 'function', `${name} loads`);
  }
  assert.equal(typeof registry.scheduled().runScheduled, 'function');
  const wrangler = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual(JSON.parse(wrangler).triggers, { crons: ['* * * * *'] });
});

test('the Worker\'s scheduled handler runs the dispatcher with the Worker settings and never throws', async () => {
  const core = require('../cloudflare/worker-core.js');
  const seen = [];
  const dispatcher = {
    serviceContext: (env) => ({ supabaseUrl: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY }),
    runScheduled: async (context) => { seen.push(context); return { sent: 1, failed: 0, alerted: 0, error: null }; }
  };
  const summary = await core.handleScheduled({ SUPABASE_URL: 'https://cron.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'cron-key' }, {}, { scheduled: () => dispatcher });
  assert.deepEqual(summary, { sent: 1, failed: 0, alerted: 0, error: null });
  assert.deepEqual(seen, [{ supabaseUrl: 'https://cron.supabase.co', serviceRoleKey: 'cron-key' }]);
  const log = console.error;
  console.error = () => {};
  try {
    const failed = await core.handleScheduled({}, {}, { scheduled: () => ({ serviceContext: () => null, runScheduled: async () => { throw new Error('boom'); } }) });
    assert.deepEqual(failed, { error: 'scheduled_failed' });
    assert.deepEqual(await core.handleScheduled({}, {}, {}), { error: 'no_scheduled_handler' });
  } finally { console.error = log; }
});
