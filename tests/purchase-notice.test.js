const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const api = (name) => require(path.join(root, 'api', name));
const { validatePurchaseNotice, fallbackIdempotencyKey } = require(path.join(root, 'lib', 'purchase-notice'));

const SIZE = '8d3f2a54-6c1b-4a0e-9b7d-5e2c1f0a9b34';
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; }, end() { return this; } }; }
async function call(handler, req) { const res = recorder(); await handler(req, res); return res.out; }

function notice(extra = {}) {
  return {
    trackingNumber: 'ELN-20261104-000123',
    status: 'completed',
    customer: { name: 'Ahmed', phone: '+20 100 000 0000', address: 'Cairo' },
    items: [{ productSizeId: SIZE, platformOrderNumber: 'ELN-20261104-000123-01', merchantOrderReference: 'AFN-77231-1', quantity: 2, unitPrice: 450, total: 900, currency: 'EGP' }],
    subtotal: 900,
    shipping: 60,
    total: 960,
    storeOrderReference: 'AFN-77231',
    shipment: { carrier: 'Aramex', status: 'in_transit', trackingCode: 'AR123456', estimatedDeliveryAt: '2026-11-08T10:00:00Z' },
    ...extra,
  };
}

test('a complete, honest notice is well formed', () => {
  assert.equal(validatePurchaseNotice(notice()), null);
  assert.equal(validatePurchaseNotice(notice({ subtotal: '900.50', shipping: '0' })), null);
});

test('an incomplete notice is still well formed, so the database can record it and keep the commission', () => {
  // These are not validation errors on purpose: refusing them would let a merchant hide a sale behind an HTTP error.
  const bare = notice();
  delete bare.storeOrderReference; delete bare.shipment; delete bare.shipping; delete bare.total;
  assert.equal(validatePurchaseNotice(bare), null);
  assert.equal(validatePurchaseNotice(notice({ status: 'rejected' })), null, 'a rejection without a reason reaches the database too');
  // Every item field may be missing: the database records the difference and the order goes to review.
  assert.equal(validatePurchaseNotice(notice({ items: [{ quantity: 1 }] })), null);
  assert.equal(validatePurchaseNotice(notice({ items: [{ productSizeId: SIZE }] })), null);
});

test('malformed values are refused before they can become a database error', () => {
  const bad = (extra, expected) => assert.match(validatePurchaseNotice(notice(extra)) || '', expected, JSON.stringify(extra));
  bad({ items: [] }, /items are required/);
  bad({ items: [{ productSizeId: 'p1', quantity: 1 }] }, /productSizeId/);
  bad({ items: [{ productSizeId: SIZE, quantity: 0 }] }, /quantity/);
  bad({ items: [{ productSizeId: SIZE, quantity: 1.5 }] }, /quantity/);
  bad({ items: [{ productSizeId: SIZE, quantity: 1000 }] }, /quantity/);
  bad({ items: [{ productSizeId: SIZE, quantity: '2' }] }, /quantity/);
  bad({ items: [{ productSizeId: SIZE, platformOrderNumber: 'x'.repeat(81) }] }, /platformOrderNumber/);
  bad({ items: [{ productSizeId: SIZE, platformOrderNumber: 7 }] }, /platformOrderNumber/);
  bad({ items: [{ productSizeId: SIZE, merchantOrderReference: 'x'.repeat(161) }] }, /merchantOrderReference/);
  bad({ items: [{ productSizeId: SIZE, merchantOrderReference: ['a'] }] }, /merchantOrderReference/);
  bad({ customer: { name: 'x', phone: '1', address: 'y', id: 'not-a-uuid' } }, /customer.id/);
  bad({ items: [{ productSizeId: SIZE, quantity: 1, unitPrice: -1 }] }, /unitPrice/);
  bad({ items: [{ productSizeId: SIZE, quantity: 1, unitPrice: 'free' }] }, /unitPrice/);
  bad({ items: [{ productSizeId: SIZE, quantity: 1, total: Infinity }] }, /total/);
  bad({ items: Array.from({ length: 101 }, () => ({ productSizeId: SIZE, quantity: 1 })) }, /too many/);
  bad({ items: ['x'] }, /must be an object/);
  bad({ subtotal: undefined }, /subtotal is required/);
  bad({ subtotal: -5 }, /subtotal/);
  bad({ subtotal: '1e3' }, /subtotal/);
  bad({ shipping: 'abc' }, /shipping/);
  bad({ total: 1e12 }, /total/);
  bad({ storeOrderReference: 'x'.repeat(121) }, /storeOrderReference/);
  bad({ storeOrderReference: { a: 1 } }, /storeOrderReference/);
  bad({ reason: 'x'.repeat(501) }, /reason/);
  bad({ shipment: 'shipped' }, /shipment must be an object/);
  bad({ shipment: { carrier: 'x'.repeat(121) } }, /carrier/);
  bad({ shipment: { trackingCode: 'x'.repeat(161) } }, /trackingCode/);
  bad({ shipment: { estimatedDeliveryAt: 'soon' } }, /estimatedDeliveryAt/);
  bad({ customer: { name: 'x', phone: '1' } }, /customer.address/);
  bad({ customer: { name: 'x'.repeat(201), phone: '1', address: 'y' } }, /customer.name/);
  bad({ customer: { name: { first: 'x' }, phone: '1', address: 'y' } }, /customer.name/);
  bad({ trackingNumber: 'x'.repeat(65) }, /trackingNumber/);
});

test('the fallback idempotency key changes with every field the database reads', () => {
  const base = fallbackIdempotencyKey(notice());
  assert.equal(fallbackIdempotencyKey(notice()), base, 'the same notice is the same event');
  for (const extra of [
    { storeOrderReference: 'AFN-77232' },
    { shipment: { carrier: 'Bosta', status: 'in_transit', trackingCode: 'AR123456' } },
    { shipment: { carrier: 'Aramex', status: 'delivered', trackingCode: 'AR123456' } },
    { shipping: 0 },
    { total: 900 },
    { reason: 'out of stock' },
    { subtotal: 800 },
    { customer: { name: 'Ahmed', phone: '+20 100 000 0001', address: 'Cairo' } },
    { items: [{ productSizeId: SIZE, quantity: 2, unitPrice: 300, total: 600 }] },
    { items: [{ productSizeId: SIZE, platformOrderNumber: 'ELN-20261104-000123-01', merchantOrderReference: 'AFN-77231-2', quantity: 2, unitPrice: 450, total: 900, currency: 'EGP' }] },
  ]) assert.notEqual(fallbackIdempotencyKey(notice(extra)), base, JSON.stringify(extra));
});

test('the endpoint answers 400 for a malformed notice and never reaches the database', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; process.env.STORE_ORDER_WEBHOOK_SECRET = 'secret';
  const hits = [];
  global.fetch = async (url, options) => { hits.push(JSON.parse(options.body)); return jsonResponse({ status: 'completed', matched: true, mismatches: [] }); };
  const handler = api('store-order-status');
  const headers = { 'x-store-webhook-secret': 'secret' };
  const refused = await call(handler, { method: 'POST', headers, body: notice({ items: [{ productSizeId: 'p1', quantity: 1 }] }) });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /productSizeId/);
  assert.equal(hits.length, 0);
  const accepted = await call(handler, { method: 'POST', headers, body: notice() });
  assert.equal(accepted.status, 200);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].p_payload.storeOrderReference, 'AFN-77231', 'the store order number and the shipment travel to the database');
  assert.equal(hits[0].p_payload.shipment.carrier, 'Aramex');
  assert.match(hits[0].p_payload.idempotencyKey, /^[0-9a-f]{64}$/);
});

test('an incomplete notice reaches the database and a mismatch answers 409 with the reasons', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; process.env.STORE_ORDER_WEBHOOK_SECRET = 'secret';
  let reached = 0;
  global.fetch = async () => { reached += 1; return jsonResponse({ status: 'needs_review', matched: false, mismatches: ['missing_store_order_reference', 'missing_shipping_details'] }); };
  const bare = notice(); delete bare.storeOrderReference; delete bare.shipment;
  const result = await call(api('store-order-status'), { method: 'POST', headers: { 'x-store-webhook-secret': 'secret' }, body: bare });
  assert.equal(reached, 1);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.mismatches, ['missing_store_order_reference', 'missing_shipping_details']);
});
