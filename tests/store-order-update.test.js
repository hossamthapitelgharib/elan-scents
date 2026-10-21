const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const handler = require(path.join(root, 'api', 'store-order-update'));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function recorder() {
  const out = {};
  return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; }, end() { return this; } };
}

// Fake Supabase for one order. `role` is the caller's role; `patchRows` is what the conditional PATCH returns.
function stub({ role = 'store_admin', orderStatus = 'store_confirmed', patchRows, notificationOk = true, notificationThrows = false } = {}) {
  const log = { patch: null, notification: null };
  global.fetch = async (url, options = {}) => {
    if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (url.includes('/profiles')) return jsonResponse([{ id: 'user-1', role }]);
    if (url.includes('/store_accounts')) return jsonResponse([{ store_id: 'store-a' }]);
    if (url.includes('/store_order_notifications')) {
      log.notification = JSON.parse(options.body);
      if (notificationThrows) throw new Error('network down');
      return jsonResponse({}, notificationOk ? 201 : 500);
    }
    if (url.includes('/store_order_requests') && options.method === 'PATCH') {
      log.patch = { url, headers: options.headers, body: JSON.parse(options.body) };
      return jsonResponse(patchRows === undefined ? [{ id: 'request-1' }] : patchRows);
    }
    if (url.includes('/store_order_requests?select=id,store_id,tracking_number,status')) {
      return jsonResponse([{ id: 'request-1', store_id: 'store-a', tracking_number: 'T-1', status: orderStatus }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  return log;
}

async function update(body) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const res = recorder();
  await handler({ method: 'PATCH', headers: { authorization: 'Bearer test-token' }, body }, res);
  return res.out;
}

test('the write only applies while the order still has the status that was validated', async () => {
  const log = stub({ orderStatus: 'store_confirmed' });
  const result = await update({ requestId: 'request-1', status: 'processing' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const params = new URL(log.patch.url).searchParams;
  assert.equal(params.get('id'), 'eq.request-1');
  assert.equal(params.get('status'), 'eq.store_confirmed');
  assert.equal(log.patch.headers.Prefer, 'return=representation');
  assert.equal(log.patch.body.status, 'processing');
});

test('a concurrent change of the order status returns 409 and queues no notification', async () => {
  const log = stub({ orderStatus: 'store_confirmed', patchRows: [] });
  const result = await update({ requestId: 'request-1', status: 'processing' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'order_status_changed');
  assert.equal(result.body.from, 'store_confirmed');
  assert.equal(log.notification, null);
});

test('a store account still cannot skip a step of the status flow', async () => {
  const log = stub({ orderStatus: 'store_confirmed' });
  const result = await update({ requestId: 'request-1', status: 'delivered' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'invalid_status_transition');
  assert.equal(log.patch, null);
});

test('platform_admin keeps the support override and the role is recorded on the notification', async () => {
  const log = stub({ role: 'platform_admin', orderStatus: 'delivered' });
  const result = await update({ requestId: 'request-1', status: 'processing' });
  assert.equal(result.status, 200);
  assert.equal(new URL(log.patch.url).searchParams.get('status'), 'eq.delivered');
  assert.equal(log.notification.payload.source, 'platform_admin');
});

test('a failed notification is reported but does not undo the saved status', async () => {
  stub({ notificationOk: false });
  const rejected = await update({ requestId: 'request-1', status: 'processing' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.ok, true);
  assert.equal(rejected.body.notificationQueued, false);

  stub({ notificationThrows: true });
  const thrown = await update({ requestId: 'request-1', status: 'processing' });
  assert.equal(thrown.status, 200);
  assert.equal(thrown.body.notificationQueued, false);

  stub();
  const fine = await update({ requestId: 'request-1', status: 'processing' });
  assert.equal(fine.body.notificationQueued, true);
});

test('a database read error is a 502, not a misleading order_not_found', async () => {
  global.fetch = async (url) => {
    if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (url.includes('/profiles')) return jsonResponse([{ id: 'user-1', role: 'platform_admin' }]);
    return jsonResponse({ message: 'boom' }, 500);
  };
  const result = await update({ requestId: 'request-1', status: 'processing' });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'supabase_read_failed');
});
