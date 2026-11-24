// lib/merchant-dispatcher.js: the outgoing side of step 3 of docs/purchase-flow-final.ar.md. Élan signs the order and sends it to the
// merchant's own address, the merchant answers by itself within ten seconds, and every way this can go wrong is classified for the
// database (claim_merchant_deliveries / finish_merchant_delivery, tested live in tests/stage1-send-review-window.test.sql).
// A small "merchant simulator" stands in for the store, and a small fake of the two database functions for Supabase. Nothing real is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const dispatcher = require('../lib/merchant-dispatcher');
const { verify } = require('../lib/store-webhook-signature');

const SECRET = 'merchant-shared-secret-0001';
const STORE_ID = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const REQUEST_ID = '0d3b6f0a-1d6e-4c41-9e0c-4f6c3d1b2a77';
const DELIVERY_ID = '9a5c1f6e-8b0f-4b79-b3a9-2f6d7c5e1a10';
const ENDPOINT = 'https://orders.merchant-store.com/elan/orders';
const ORDER_PAYLOAD = {
  type: 'elan_order', version: 1, elanOrderId: REQUEST_ID, trackingNumber: 'ELN-20261117-000001',
  store: { id: STORE_ID, name: 'Merchant Store' }, customer: { name: 'Test Customer One', phone: '01000000000' },
  items: [{ lineId: 'l1', platformOrderNumber: 'ELN-20261117-000001-1', productName: 'Test Perfume', sizeLabel: '100ml', quantity: 2, unitPrice: 100, lineTotal: 200 }],
  subtotal: 200, shipping: null, currency: 'EGP', createdAt: '2026-11-17T10:00:00Z'
};

function job(overrides = {}) {
  return {
    deliveryId: DELIVERY_ID, attemptNo: 1, kind: 'order', maxAttempts: 6, storeId: STORE_ID, endpoint: ENDPOINT, secret: SECRET,
    requestId: REQUEST_ID, trackingNumber: ORDER_PAYLOAD.trackingNumber, payload: ORDER_PAYLOAD, cancel: null, ...overrides
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function asRequest(call) {
  const headers = {};
  for (const [key, value] of Object.entries(call.options.headers)) headers[key.toLowerCase()] = value;
  return { headers, body: call.options.body };
}

// A store that follows the rules: it verifies the signature the way lib/store-webhook-signature.js does and answers like the contract says.
function merchant(reply, { status = 200, check = true } = {}) {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const call = { url, options };
    seen.push(call);
    if (check) {
      const verdict = verify(asRequest(call), SECRET);
      if (!verdict.ok) return json({ error: verdict.error }, 401);
    }
    return typeof reply === 'function' ? reply(JSON.parse(options.body), call) : json(reply, status);
  };
  return { fetchImpl, seen };
}

test('an endpoint must be https on the default port with a real host name; addresses that point inside are refused', () => {
  assert.equal(dispatcher.safeEndpoint('https://orders.merchant-store.com/elan/orders'), 'https://orders.merchant-store.com/elan/orders');
  for (const bad of [
    '', 'not a url', 'http://orders.merchant-store.com/x', 'ftp://orders.merchant-store.com/x', 'https://user:pass@orders.merchant-store.com/x',
    'https://orders.merchant-store.com:8443/x', 'https://localhost/x', 'https://shop.localhost/x', 'https://intranet/x', 'https://127.0.0.1/x',
    'https://10.0.0.5/x', 'https://2130706433/x', 'https://0x7f000001/x', 'https://[::1]/x', 'https://[2001:db8::1]/x', 'https://db.internal/x',
    'https://printer.local/x', 'https://router.lan/x'
  ]) assert.equal(dispatcher.safeEndpoint(bad), null, bad);
});

test('the message is the frozen order for an order, and only the order, the reason and the time for a cancellation', () => {
  const order = dispatcher.buildMessage(job());
  assert.equal(order.event, 'order');
  assert.deepEqual(JSON.parse(order.body), {
    ...ORDER_PAYLOAD,
    returnUrls: {
      success: `https://elan-scents.hossamthapitelgharib.workers.dev/payment-return.html?o=${REQUEST_ID}&r=success`,
      cancel: `https://elan-scents.hossamthapitelgharib.workers.dev/payment-return.html?o=${REQUEST_ID}&r=cancel`
    }
  }, 'the order and the two addresses the merchant window sends the customer back to');
  const custom = dispatcher.returnUrls(REQUEST_ID, 'https://shop.example.com/');
  assert.equal(custom.success, `https://shop.example.com/payment-return.html?o=${REQUEST_ID}&r=success`);
  const cancel = dispatcher.buildMessage(job({ kind: 'cancel', payload: ORDER_PAYLOAD, cancel: { reason: 'payment_window_closed', cancelledAt: '2026-11-17T10:05:00Z' } }));
  assert.equal(cancel.event, 'order_cancelled');
  assert.deepEqual(JSON.parse(cancel.body), {
    type: 'elan_order_cancelled', version: 1, elanOrderId: REQUEST_ID, trackingNumber: ORDER_PAYLOAD.trackingNumber,
    reason: 'payment_window_closed', cancelledAt: '2026-11-17T10:05:00Z'
  });
  assert.doesNotMatch(cancel.body, /customer|phone|items/i, 'a cancellation does not repeat the customer or the products');
});

test('every message is signed with the store secret over timestamp, delivery:attempt and the exact body; the secret itself is never sent', async () => {
  const { fetchImpl, seen } = merchant({ decision: 'reject', reason: 'no stock' });
  const result = await dispatcher.sendJob(job({ attemptNo: 3 }), { fetchImpl });
  assert.equal(result.outcome, 'responded');
  assert.equal(seen.length, 1);
  const { url, options } = seen[0];
  assert.equal(url, ENDPOINT);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual', 'a redirect is never followed');
  assert.ok(options.signal, 'the ten second limit is an abort signal');
  const headers = asRequest(seen[0]).headers;
  assert.equal(headers['x-store-id'], STORE_ID);
  assert.equal(headers['x-elan-event'], 'order');
  assert.equal(headers['x-webhook-id'], `${DELIVERY_ID}:3`);
  assert.equal(headers['x-elan-attempt'], '3');
  assert.equal(verify({ headers, body: options.body }, SECRET).ok, true, 'a store that checks the signature accepts it');
  assert.equal(verify({ headers, body: options.body + ' ' }, SECRET).ok, false, 'a changed body no longer matches');
  assert.equal(verify({ headers, body: options.body }, 'another-secret-entirely-1').ok, false, 'another secret no longer matches');
  const everything = JSON.stringify(options);
  assert.ok(!everything.includes(SECRET), 'the secret is used to sign and is not part of the request');
});

test('an approval with the merchant payment window is passed on, keeping only the decision fields', async () => {
  const { fetchImpl } = merchant({
    decision: 'approve', paymentWindowUrl: 'https://pay.merchant-store.com/w/abc', idleSeconds: 900, validitySeconds: 900, shipping: 50, total: 250,
    paymentMethods: [{ kind: 'cod' }], status: 'confirmed', trackingNumber: 'ELN-FORGED', eventId: 'forged', storeId: 'forged', extra: { nested: true }
  });
  const result = await dispatcher.sendJob(job(), { fetchImpl });
  assert.equal(result.outcome, 'responded');
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.reply, { decision: 'approve', paymentWindowUrl: 'https://pay.merchant-store.com/w/abc', idleSeconds: 900 }, 'the idle time is the one number that travels on; a validity, a shipping amount and a total are the merchant\'s own inside its window and are not passed on');
});

test('a rejection carries its reason, cut to the length the database accepts', async () => {
  const { fetchImpl } = merchant({ decision: 'reject', reason: 'x'.repeat(900) });
  const result = await dispatcher.sendJob(job(), { fetchImpl });
  assert.equal(result.outcome, 'responded');
  assert.equal(result.reply.decision, 'reject');
  assert.equal(result.reply.reason.length, 500);
});

test('a reply with no decision is still a reply (the database records it as "no decision" and retries); it is not a transport failure', async () => {
  const { fetchImpl } = merchant({ ok: true });
  const result = await dispatcher.sendJob(job(), { fetchImpl });
  assert.deepEqual(result, { outcome: 'responded', httpStatus: 200, reply: {} });
});

test('every way a send can fail is classified, with a short detail that never holds what the merchant wrote', async () => {
  const cases = [
    ['signature refused (401)', () => json({ error: 'bad signature' }, 401), 'signature_rejected', 401],
    ['forbidden (403)', () => json({}, 403), 'signature_rejected', 403],
    ['server error (500)', () => new Response('Traceback: secret stack with password=hunter2', { status: 500 }), 'merchant_error', 500],
    ['not found (404)', () => json({}, 404), 'merchant_error', 404],
    ['redirect (302)', () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.example.com/' } }), 'merchant_error', 302],
    ['reply that is not JSON', () => new Response('<html>ok</html>', { status: 200 }), 'invalid_response', 200],
    ['reply that is a list', () => json([1, 2, 3]), 'invalid_response', 200],
    ['reply that is a string', () => json('approve'), 'invalid_response', 200],
    ['reply that is far too large', () => new Response('{"decision":"approve","pad":"' + 'a'.repeat(dispatcher.MAX_REPLY_BYTES + 10) + '"}', { status: 200 }), 'invalid_response', 200]
  ];
  for (const [label, make, kind, http] of cases) {
    const result = await dispatcher.sendJob(job(), { fetchImpl: async () => make() });
    assert.equal(result.outcome, 'failed', label);
    assert.equal(result.failureKind, kind, label);
    assert.equal(result.httpStatus, http, label);
    assert.ok(result.detail && result.detail.length <= 60, label);
    assert.doesNotMatch(result.detail, /hunter2|Traceback|elsewhere/, `${label}: nothing the merchant wrote is kept`);
  }
});

test('no answer within the limit is a timeout; a refused or dropped connection is a network failure', async () => {
  const hangs = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  const started = Date.now();
  const timeout = await dispatcher.sendJob(job(), { fetchImpl: hangs, timeoutMs: 60 });
  assert.deepEqual([timeout.outcome, timeout.failureKind], ['failed', 'timeout']);
  assert.ok(Date.now() - started < 2000, 'the wait ends at the limit');
  const down = await dispatcher.sendJob(job(), { fetchImpl: async () => { throw new TypeError('fetch failed: ECONNREFUSED'); } });
  assert.deepEqual([down.outcome, down.failureKind], ['failed', 'network']);
  assert.doesNotMatch(down.detail, /ECONNREFUSED/);
  assert.equal(dispatcher.SEND_TIMEOUT_MS, 10000, 'the contract says ten seconds');
});

test('an unsafe address is never called and counts as a network failure', async () => {
  let called = false;
  for (const endpoint of ['http://orders.merchant-store.com/x', 'https://127.0.0.1/x', null]) {
    const result = await dispatcher.sendJob(job({ endpoint }), { fetchImpl: async () => { called = true; return json({}); } });
    assert.deepEqual([result.outcome, result.failureKind], ['failed', 'network']);
  }
  assert.equal(called, false);
});

test('a cancellation is delivered once the merchant answers 2xx, whatever it says; an error answer is retried', async () => {
  const cancel = job({ kind: 'cancel', cancel: { reason: 'store_unresponsive', cancelledAt: '2026-11-17T10:01:00Z' } });
  const ok = await dispatcher.sendJob(cancel, { fetchImpl: async () => new Response('thanks', { status: 200 }) });
  assert.deepEqual(ok, { outcome: 'responded', httpStatus: 200 });
  const accepted = await dispatcher.sendJob(cancel, { fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(accepted.outcome, 'responded');
  const broken = await dispatcher.sendJob(cancel, { fetchImpl: async () => new Response('', { status: 503 }) });
  assert.deepEqual([broken.outcome, broken.failureKind], ['failed', 'merchant_error']);
});

// ---- the database side, faked: claim hands out jobs, finish records what the sender reports ----
function database(jobs, { failFinish = false, alerted = 2, closed = 0 } = {}) {
  const calls = [];
  const context = { supabaseUrl: 'https://test.supabase.co', serviceRoleKey: 'service-key-for-tests' };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin === 'https://test.supabase.co') {
      const name = url.pathname.replace('/rest/v1/rpc/', '');
      const body = JSON.parse(options.body);
      calls.push({ name, body, headers: options.headers });
      if (name === 'claim_merchant_deliveries') return json(jobs);
      if (name === 'finish_merchant_delivery') return failFinish ? new Response('boom', { status: 500 }) : json({ ok: true });
      if (name === 'close_idle_payment_windows') return json(closed);
      if (name === 'alert_stale_payment_windows') return json(alerted);
      throw new Error(`unexpected rpc ${name}`);
    }
    return merchantFetch(input, options);
  };
  let merchantFetch = async () => json({});
  return { context, calls, fetchImpl, setMerchant(fn) { merchantFetch = fn; } };
}

test('a due order is claimed, sent, and its outcome reported with the same delivery and attempt number', async () => {
  const db = database([job({ attemptNo: 2 })]);
  const store = merchant({ decision: 'approve', paymentWindowUrl: 'https://pay.merchant-store.com/w/1' });
  db.setMerchant(store.fetchImpl);
  const done = await dispatcher.runDeliveries(db.context, { requestId: REQUEST_ID, limit: 1, fetchImpl: db.fetchImpl });
  assert.deepEqual(db.calls.map((c) => c.name), ['claim_merchant_deliveries', 'finish_merchant_delivery']);
  assert.deepEqual(db.calls[0].body, { p_request_id: REQUEST_ID, p_limit: 1 });
  assert.equal(db.calls[0].headers.Authorization, 'Bearer service-key-for-tests');
  assert.deepEqual(db.calls[1].body, {
    p_delivery_id: DELIVERY_ID, p_attempt_no: 2,
    p_result: { outcome: 'responded', httpStatus: 200, reply: { decision: 'approve', paymentWindowUrl: 'https://pay.merchant-store.com/w/1' } }
  });
  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, 'responded');
});

test('nothing due means nothing sent; one failing store does not stop the others; a failed report is logged, not thrown', async () => {
  const quiet = database([]);
  assert.deepEqual(await dispatcher.runDeliveries(quiet.context, { fetchImpl: quiet.fetchImpl }), []);
  assert.deepEqual(quiet.calls.map((c) => c.name), ['claim_merchant_deliveries']);

  const second = job({ deliveryId: '11111111-1111-4111-8111-111111111111', endpoint: 'https://shop.other-store.com/orders', requestId: '22222222-2222-4222-8222-222222222222' });
  const mixed = database([job(), second]);
  mixed.setMerchant(async (url) => { if (String(url).includes('other-store')) throw new TypeError('fetch failed'); return json({ decision: 'reject', reason: 'closed today' }); });
  const done = await dispatcher.runDeliveries(mixed.context, { fetchImpl: mixed.fetchImpl });
  assert.deepEqual(done.map((d) => [d.outcome, d.failureKind]), [['responded', null], ['failed', 'network']]);
  assert.equal(mixed.calls.filter((c) => c.name === 'finish_merchant_delivery').length, 2, 'each attempt is reported');

  const lost = database([job()], { failFinish: true });
  const log = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    lost.setMerchant(merchant({ decision: 'reject', reason: 'r' }).fetchImpl);
    const out = await dispatcher.runDeliveries(lost.context, { fetchImpl: lost.fetchImpl });
    assert.equal(out.length, 1);
  } finally { console.error = log; }
  assert.ok(logged.some((line) => /report failed/.test(line)), 'the lost report is logged; the database recovers the open attempt as "worker_lost"');
});

test('the Cron run sends what is due for anyone, closes windows whose customer stopped moving for the idle time, tells once of a customer sent to the provider who was never heard from again (it cancels nothing), and never throws', async () => {
  const db = database([job({ kind: 'cancel', cancel: { reason: 'payment_window_closed', cancelledAt: '2026-11-17T10:05:00Z' } })], { alerted: 3, closed: 2 });
  db.setMerchant(async () => new Response('', { status: 200 }));
  const summary = await dispatcher.runScheduled(db.context, { fetchImpl: db.fetchImpl });
  assert.deepEqual(summary, { sent: 1, failed: 0, closed: 2, alerted: 3, error: null });
  assert.deepEqual(db.calls.map((c) => c.name), ['claim_merchant_deliveries', 'finish_merchant_delivery', 'close_idle_payment_windows', 'alert_stale_payment_windows']);
  assert.deepEqual(db.calls[0].body, { p_request_id: null, p_limit: dispatcher.CRON_BATCH });

  const broken = { supabaseUrl: 'https://test.supabase.co', serviceRoleKey: 'k' };
  const down = await dispatcher.runScheduled(broken, { fetchImpl: async () => new Response('down', { status: 503 }) });
  assert.equal(down.sent, 0);
  assert.match(down.error, /claim_merchant_deliveries/);

  const unconfigured = await dispatcher.runScheduled(null);
  assert.equal(unconfigured.error, 'supabase_service_configuration_missing');
});

test('the service context comes from the Worker settings, and is absent without them', () => {
  assert.deepEqual(dispatcher.serviceContext({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }), { supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'k' });
  assert.equal(dispatcher.serviceContext({ SUPABASE_URL: 'https://x.supabase.co' }), null);
  assert.equal(dispatcher.serviceContext({}), null);
});
