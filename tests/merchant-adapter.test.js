// The Merchant Adapter (phase 2): /api/merchant-order-decision, /api/merchant-payment-event, /api/merchant-shipment-event.
// The database rules behind them are tested in tests/payment-merchant-shipping.test.sql; here the handler is checked: a merchant must
// prove who it is (its own id + secret) AND sign the message (timestamp, event id, HMAC), only the listed fields travel on, the
// merchant that authenticated is the only one the database is asked about, a replayed or tampered message never reaches the
// database, and the merchant never sees a raw database error.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const handlers = {
  decision: require(path.join(root, 'api', 'merchant-order-decision')),
  payment: require(path.join(root, 'api', 'merchant-payment-event')),
  shipment: require(path.join(root, 'api', 'merchant-shipment-event'))
};
const { STORE_ID_HEADER } = require(path.join(root, 'lib', 'store-webhook-auth'));
const { digest, TIMESTAMP_HEADER, SIGNATURE_HEADER, EVENT_HEADER } = require(path.join(root, 'lib', 'store-webhook-signature'));
const { mapDatabaseError, DATABASE_ERRORS } = require(path.join(root, 'lib', 'merchant-adapter'));

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const SECRETS = { [STORE_A]: 'unit-test-secret-a-0123', [STORE_B]: 'unit-test-secret-b-0123' };
const SERVICE_KEY = 'service-key-must-never-be-echoed';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = { headers: {} }; return { out, status(n) { out.status = n; return this; }, setHeader(name, value) { out.headers[name.toLowerCase()] = value; return this; }, json(body) { out.body = body; return this; }, end() { return this; } }; }
async function call(handler, req) { const res = recorder(); await handler(req, res); return res.out; }

function installDatabase(rpcAnswer) {
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const entry = { pathname: url.pathname, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
    calls.push(entry);
    if (url.pathname === '/rest/v1/store_integrations') {
      const id = (url.searchParams.get('store_id') || '').replace(/^eq\./, '');
      return jsonResponse(SECRETS[id] ? [{ webhook_secret: SECRETS[id], enabled: true }] : []);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) return rpcAnswer ? rpcAnswer(entry) : jsonResponse({ trackingNumber: entry.body.p_payload.trackingNumber, ok: 1 });
    throw new Error(`unexpected request to ${url.pathname}`);
  };
  return calls;
}
const rpcCalls = (calls) => calls.filter((c) => c.pathname.startsWith('/rest/v1/rpc/'));

let ipCounter = 0;
const nextIp = () => { ipCounter += 1; return `203.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`; };
function signed({ storeId = STORE_A, secret = SECRETS[STORE_A], body, eventId = 'evt-0001', timestamp = Math.floor(Date.now() / 1000), signWith = secret, tamper = false } = {}) {
  const headers = { 'x-real-ip': nextIp(), [STORE_ID_HEADER]: storeId, 'x-store-webhook-secret': secret, [TIMESTAMP_HEADER]: String(timestamp), [EVENT_HEADER]: eventId };
  headers[SIGNATURE_HEADER] = digest(signWith, String(timestamp), eventId, body);
  return { method: 'POST', headers, body: tamper ? { ...body, amount: 1 } : body };
}

const DECISION = { trackingNumber: 'ELN-20261111-000001', decision: 'approve', shipping: 30, total: 230, paymentMethods: [{ kind: 'cod', labelAr: 'الدفع عند الاستلام' }], injected: 'x', storeId: STORE_B };

test('a signed decision from the authenticated merchant reaches the database with ONLY the listed fields, its own store and the signed event id', async () => {
  const calls = installDatabase();
  const out = await call(handlers.decision, signed({ body: DECISION, eventId: 'decision-evt-1' }));
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  const rpc = rpcCalls(calls);
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0].pathname, '/rest/v1/rpc/merchant_review_order');
  assert.equal(rpc[0].body.p_store_id, STORE_A, 'the merchant that authenticated, not a store id written in the body');
  assert.deepEqual(Object.keys(rpc[0].body.p_payload).sort(), ['decision', 'eventId', 'paymentMethods', 'shipping', 'total', 'trackingNumber']);
  assert.equal(rpc[0].body.p_payload.eventId, 'decision-evt-1');
  assert.equal(rpc[0].headers.Authorization, `Bearer ${SERVICE_KEY}`);
  assert.doesNotMatch(JSON.stringify(out.body), new RegExp(SERVICE_KEY));
});

test('payment and shipment events use their own database functions and field lists', async () => {
  let calls = installDatabase();
  const payment = { trackingNumber: 'ELN-20261111-000001', eventType: 'payment.succeeded', providerTransactionId: 'txn-1', amount: 230, currency: 'EGP', cardNumber: '4111111111111111' };
  let out = await call(handlers.payment, signed({ body: payment }));
  assert.equal(out.status, 200);
  assert.equal(rpcCalls(calls)[0].pathname, '/rest/v1/rpc/record_payment_event');
  assert.equal('cardNumber' in rpcCalls(calls)[0].body.p_payload, false, 'a field that is not on the list never travels on');
  calls = installDatabase();
  out = await call(handlers.shipment, signed({ body: { trackingNumber: 'ELN-20261111-000001', status: 'in_transit', carrier: 'Bosta', trackingCode: 'W-1' } }));
  assert.equal(out.status, 200);
  assert.equal(rpcCalls(calls)[0].pathname, '/rest/v1/rpc/record_shipment_event');
});

test('nothing reaches the database unless the merchant proved WHO it is and signed WHAT it sent', async () => {
  const body = DECISION;
  const cases = [
    ['no store id', { ...signed({ body }), headers: { ...signed({ body }).headers, [STORE_ID_HEADER]: '' } }, 'merchant_identity_required'],
    ['wrong secret', signed({ body, secret: 'not-the-secret-at-all' }), 'invalid_webhook_secret'],
    ['the other store\'s secret', signed({ body, secret: SECRETS[STORE_B] }), 'invalid_webhook_secret'],
    ['signed with another secret', signed({ body, signWith: 'a-different-signing-secret' }), 'invalid_webhook_signature'],
    ['body changed after signing', signed({ body, tamper: true }), 'invalid_webhook_signature'],
    ['stale timestamp', signed({ body, timestamp: Math.floor(Date.now() / 1000) - 3600 }), 'stale_webhook_signature']
  ];
  for (const [label, req, error] of cases) {
    const calls = installDatabase();
    const out = await call(handlers.decision, req);
    assert.equal(out.status, 401, label);
    assert.equal(out.body.error, error, label);
    assert.equal(rpcCalls(calls).length, 0, `${label}: the database was not called`);
  }
  const unsigned = signed({ body });
  delete unsigned.headers[SIGNATURE_HEADER];
  const calls = installDatabase();
  const out = await call(handlers.decision, unsigned);
  assert.equal(out.status, 401);
  assert.equal(rpcCalls(calls).length, 0, 'the signature is mandatory on this door, whatever the global setting');
  assert.equal((await call(handlers.decision, { ...signed({ body }), method: 'GET' })).status, 405);
});

test('an order of another store answers exactly like an order that does not exist (the database looks it up by tracking number AND store)', async () => {
  const calls = installDatabase(() => new Response(JSON.stringify({ code: 'P0001', message: 'Order not found' }), { status: 400 }));
  const out = await call(handlers.shipment, signed({ body: { trackingNumber: 'ELN-OF-ANOTHER-STORE', status: 'in_transit' } }));
  assert.equal(out.status, 404);
  assert.deepEqual(out.body, { ok: false, error: 'order_not_found' });
  assert.equal(rpcCalls(calls)[0].body.p_store_id, STORE_A);
});

test('a bad tracking number never reaches the database, and the merchant never sees a raw database error', async () => {
  let calls = installDatabase();
  for (const trackingNumber of [undefined, '', 'a b', 'x'.repeat(65), 'ELN;drop', 12]) {
    const out = await call(handlers.decision, signed({ body: { ...DECISION, trackingNumber } }));
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'invalid_tracking_number');
  }
  assert.equal(rpcCalls(calls).length, 0);
  calls = installDatabase(() => new Response(JSON.stringify({ code: '42P01', message: 'relation "secret_internal_table" does not exist' }), { status: 500 }));
  const out = await call(handlers.payment, signed({ body: { trackingNumber: 'ELN-1', eventType: 'payment.succeeded', providerTransactionId: 't', amount: 1 } }));
  assert.equal(out.status, 502);
  assert.deepEqual(out.body, { ok: false, error: 'merchant_action_failed' });
  assert.doesNotMatch(JSON.stringify(out.body), /secret_internal_table/);
});

test('every rule the database raises on purpose has its own safe answer', () => {
  const samples = {
    'Order not found': [404, 'order_not_found'],
    'A rejection needs a reason': [422, 'reason_required'],
    'Order is not waiting for the store': [409, 'order_not_waiting'],
    'Configure a payment method before approving orders': [409, 'payment_method_required'],
    'Payment is required before shipping': [409, 'payment_required'],
    'Invalid shipping transition': [409, 'invalid_shipping_transition'],
    'Carrier and waybill are required': [422, 'carrier_and_waybill_required'],
    'A provider transaction id is required': [422, 'transaction_id_required'],
    'Invalid payment method': [422, 'invalid_payment_method']
  };
  for (const [message, [status, error]] of Object.entries(samples)) {
    const mapped = mapDatabaseError(400, JSON.stringify({ message }));
    assert.equal(mapped.status, status, message);
    assert.equal(mapped.body.error, error, message);
  }
  assert.ok(DATABASE_ERRORS.length >= 20);
});
