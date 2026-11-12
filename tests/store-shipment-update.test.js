const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const handler = require(path.join(__dirname, '..', 'api', 'store-shipment-update'));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() {
  const out = {};
  return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; }, end() { return this; } };
}

function stub({ orderStatus = 'processing', orderReadStatus = 200, initialShipment = null, shipmentReadStatus = 200, notification = () => jsonResponse({}, 201), saveFailureStatus = 0, waitForTwoShipmentReads = false } = {}) {
  const state = { shipment: initialShipment && { ...initialShipment }, saved: [], patches: [], notified: 0, shipmentReads: 0 };
  let releaseReads;
  const bothRead = new Promise((resolve) => { releaseReads = resolve; });
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    if (url.pathname.endsWith('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (url.pathname.endsWith('/rest/v1/profiles')) return jsonResponse([{ id: 'user-1', role: 'store_admin' }]);
    if (url.pathname.endsWith('/rest/v1/store_accounts')) return jsonResponse([{ store_id: 'store-a' }]);
    if (url.pathname.endsWith('/rest/v1/store_order_requests')) {
      return orderReadStatus === 200
        ? jsonResponse([{ id: 'request-1', store_id: 'store-a', tracking_number: 'T-1', status: orderStatus }])
        : jsonResponse({ code: '22P02', message: 'invalid input syntax for type uuid' }, orderReadStatus);
    }
    if (url.pathname.endsWith('/rest/v1/store_shipments') && method === 'GET') {
      if (shipmentReadStatus !== 200) return jsonResponse({ message: 'read failed' }, shipmentReadStatus);
      const snapshot = state.shipment ? [{ ...state.shipment }] : [];
      if (waitForTwoShipmentReads) {
        state.shipmentReads += 1;
        if (state.shipmentReads >= 2) releaseReads();
        await bothRead;
      }
      return jsonResponse(snapshot);
    }
    if (url.pathname.endsWith('/rest/v1/store_shipments') && (method === 'POST' || method === 'PATCH')) {
      const patch = JSON.parse(options.body);
      state.saved.push(patch);
      state.patches.push({ method, params: url.searchParams, prefer: options.headers.Prefer });
      if (saveFailureStatus) return jsonResponse({ code: '23505', message: 'duplicate key value violates unique constraint "store_shipments_pkey"' }, saveFailureStatus);
      if (method === 'POST') {
        if (state.shipment) return jsonResponse([]); // resolution=ignore-duplicates
        state.shipment = { id: 'shipment-1', ...patch };
        return jsonResponse([{ ...state.shipment }], 201);
      }
      const params = url.searchParams;
      const matches = state.shipment
        && params.get('request_id') === `eq.${state.shipment.request_id}`
        && params.get('shipping_status') === `eq.${state.shipment.shipping_status}`
        && params.get('updated_at') === `eq.${state.shipment.updated_at}`;
      if (!matches) return jsonResponse([]);
      const previousUpdatedAt = Date.parse(state.shipment.updated_at);
      Object.assign(state.shipment, patch);
      // The production BEFORE UPDATE trigger assigns updated_at=now(); model a new DB row version.
      state.shipment.updated_at = new Date(Math.max(Date.now(), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0)).toISOString();
      return jsonResponse([{ ...state.shipment }]);
    }
    if (url.pathname.endsWith('/rest/v1/store_order_notifications')) { state.notified += 1; return notification(); }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  return state;
}
async function ship(body) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const res = recorder();
  await handler({ method: 'PATCH', headers: { authorization: 'Bearer test-token' }, body }, res);
  return res.out;
}
const update = { requestId: 'request-1', shippingStatus: 'in_transit', carrierName: 'Aramex', trackingCode: 'A-1' };
const savedEnv = {};
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) savedEnv[key] = process.env[key];
const savedFetch = global.fetch;
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  global.fetch = savedFetch;
});

test('a first shipment is inserted without merge-upsert and the notification is queued', async () => {
  const db = stub();
  const result = await ship(update);
  assert.equal(result.status, 200);
  assert.equal(result.body.notificationQueued, true);
  assert.equal(db.shipment.shipping_status, 'in_transit');
  assert.equal(db.patches[0].method, 'POST');
  assert.equal(db.patches[0].params.get('on_conflict'), 'request_id');
  assert.match(db.patches[0].prefer, /resolution=ignore-duplicates/);
  assert.equal(db.notified, 1);
});

test('a saved shipment is updated only while its status and row version still match', async () => {
  const db = stub({ initialShipment: { id: 'shipment-1', request_id: 'request-1', shipping_status: 'preparing', updated_at: '2026-01-01T00:00:00.000Z', delivered_at: null } });
  const result = await ship({ ...update, shippingStatus: 'handed_to_carrier' });
  assert.equal(result.status, 200);
  assert.equal(db.patches[0].method, 'PATCH');
  assert.equal(db.patches[0].params.get('shipping_status'), 'eq.preparing');
  assert.equal(db.patches[0].params.get('updated_at'), 'eq.2026-01-01T00:00:00.000Z');
  assert.equal(db.shipment.shipping_status, 'handed_to_carrier');
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
  for (const shipmentReadStatus of [500, 503]) {
    const db = stub({ shipmentReadStatus });
    const result = await ship(update);
    assert.equal(result.status, 502);
    assert.equal(result.body.error, 'shipment_read_failed');
    assert.equal(db.saved.length, 0, 'nothing may be written when the current shipment is unknown');
  }
});

test('going back to an earlier shipping status is refused before writing', async () => {
  const db = stub({ initialShipment: { id: 'shipment-1', request_id: 'request-1', shipping_status: 'out_for_delivery', updated_at: '2026-01-01T00:00:00.000Z' } });
  const result = await ship({ ...update, shippingStatus: 'preparing' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'invalid_shipping_transition');
  assert.equal(db.saved.length, 0);
});

test('two simultaneous first updates cannot both create or notify a shipment', async () => {
  const db = stub({ waitForTwoShipmentReads: true });
  const results = await Promise.all([ship(update), ship({ ...update, shippingStatus: 'preparing' })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.error, 'shipment_status_changed');
  assert.equal(db.patches.filter((entry) => entry.method === 'POST').length, 2);
  assert.equal(db.notified, 1);
});

test('two simultaneous transitions from the same shipment version cannot overwrite each other', async () => {
  const db = stub({
    initialShipment: { id: 'shipment-1', request_id: 'request-1', shipping_status: 'preparing', updated_at: '2026-01-01T00:00:00.000Z', delivered_at: null },
    waitForTwoShipmentReads: true
  });
  const results = await Promise.all([
    ship({ ...update, shippingStatus: 'handed_to_carrier' }),
    ship({ ...update, shippingStatus: 'cancelled' })
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.error, 'shipment_status_changed');
  assert.equal(db.patches.filter((entry) => entry.method === 'PATCH').length, 2);
  assert.equal(db.notified, 1, 'only the winning write emits a notification');
});

test('same-status concurrent edits are serialized by updated_at too', async () => {
  const db = stub({
    initialShipment: { id: 'shipment-1', request_id: 'request-1', shipping_status: 'preparing', updated_at: '2026-01-01T00:00:00.000Z', delivered_at: null },
    waitForTwoShipmentReads: true
  });
  const results = await Promise.all([
    ship({ requestId: 'request-1', shippingStatus: 'preparing', carrierName: 'Carrier A' }),
    ship({ requestId: 'request-1', shippingStatus: 'preparing', carrierName: 'Carrier B' })
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(db.notified, 1);
});

test('invalid ids and database errors are handled without returning database details', async () => {
  stub({ orderReadStatus: 400 });
  const bad = await ship({ ...update, requestId: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_request_id');

  const originalError = console.error;
  console.error = () => {};
  try {
    stub({ saveFailureStatus: 409 });
    const failed = await ship(update);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error, 'shipment_save_failed');
    assert.doesNotMatch(JSON.stringify(failed.body), /store_shipments_pkey/);
  } finally { console.error = originalError; }
});

test('orders the store rejected or cancelled cannot get a shipment', async () => {
  const db = stub({ orderStatus: 'store_rejected' });
  const result = await ship(update);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'order_not_shippable');
  assert.equal(db.saved.length, 0);
});
