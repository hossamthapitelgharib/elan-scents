const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const handler = require(path.join(__dirname, '..', 'api', 'store-shipment-update'));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() {
  const out = {};
  return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; }, end() { return this; } };
}

// Fake Supabase for one processing order of store-a. Each option overrides one answer.
function stub({ orderStatus = 'processing', orderReadStatus = 200, shipmentRead = () => jsonResponse([]), save = body => jsonResponse([{ id: 'shipment-1', ...body }]), notification = () => jsonResponse({}, 201) } = {}) {
  const log = { saved: null, notified: 0 };
  global.fetch = async (url, options = {}) => {
    if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (url.includes('/profiles')) return jsonResponse([{ id: 'user-1', role: 'store_admin' }]);
    if (url.includes('/store_accounts?')) return jsonResponse([{ store_id: 'store-a' }]);
    if (url.includes('/store_order_requests?')) {
      return orderReadStatus === 200
        ? jsonResponse([{ id: 'request-1', store_id: 'store-a', tracking_number: 'T-1', status: orderStatus }])
        : jsonResponse({ code: '22P02', message: 'invalid input syntax for type uuid' }, orderReadStatus);
    }
    if (url.includes('/store_shipments?select=')) return shipmentRead();
    if (url.includes('/store_shipments?on_conflict=')) { log.saved = JSON.parse(options.body); return save(log.saved); }
    if (url.includes('/store_order_notifications')) { log.notified += 1; return notification(); }
    throw new Error(`unexpected ${url}`);
  };
  return log;
}
async function ship(body) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const res = recorder();
  await handler({ method: 'PATCH', headers: { authorization: 'Bearer test-token' }, body }, res);
  return res.out;
}
const update = { requestId: 'request-1', shippingStatus: 'in_transit', carrierName: 'Aramex', trackingCode: 'A-1' };

test('a valid update is saved, the notification is queued and the caller is told so', async () => {
  const log = stub();
  const result = await ship(update);
  assert.equal(result.status, 200);
  assert.equal(result.body.notificationQueued, true);
  assert.equal(log.saved.shipping_status, 'in_transit');
  assert.equal(log.notified, 1);
});

test('a failed notification does not undo the saved shipment but is reported', async () => {
  stub({ notification: () => jsonResponse({}, 500) });
  const failed = await ship(update);
  assert.equal(failed.status, 200);
  assert.equal(failed.body.notificationQueued, false);
  stub({ notification: () => { throw new Error('network down'); } });
  const thrown = await ship(update);
  assert.equal(thrown.status, 200);
  assert.equal(thrown.body.notificationQueued, false);
});

test('when the saved shipment cannot be read the update stops instead of skipping the transition check', async () => {
  for (const shipmentRead of [() => jsonResponse({ message: 'boom' }, 500), () => jsonResponse({ unexpected: true }), () => new Response('not json', { status: 200 })]) {
    const log = stub({ shipmentRead });
    const result = await ship(update);
    assert.equal(result.status, 502);
    assert.equal(result.body.error, 'shipment_read_failed');
    assert.equal(log.saved, null, 'nothing may be written when the current shipment is unknown');
  }
});

test('going back to an earlier shipping status is still refused', async () => {
  const log = stub({ shipmentRead: () => jsonResponse([{ shipping_status: 'out_for_delivery' }]) });
  const result = await ship({ ...update, shippingStatus: 'preparing' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'invalid_shipping_transition');
  assert.equal(log.saved, null);
});

test('an id that is not a UUID is a 400, and database error details are never echoed to the caller', async () => {
  stub({ orderReadStatus: 400 });
  const bad = await ship({ ...update, requestId: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_request_id');

  const originalError = console.error;
  console.error = () => {};
  try {
    stub({ save: () => jsonResponse({ code: '23505', message: 'duplicate key value violates unique constraint "store_shipments_pkey"' }, 409) });
    const failed = await ship(update);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, 'shipment_save_failed');
    assert.equal(JSON.stringify(failed.body).includes('store_shipments_pkey'), false);
  } finally { console.error = originalError; }
});

test('orders the store rejected or cancelled cannot get a shipment', async () => {
  const log = stub({ orderStatus: 'store_rejected' });
  const result = await ship(update);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'order_not_shippable');
  assert.equal(log.saved, null);
});
