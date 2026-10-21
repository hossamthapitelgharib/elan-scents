const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const handler = require(path.join(__dirname, '..', 'api', 'store-order-update'));
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() {
  const out = {};
  return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; }, end() { return this; } };
}

// Fake Supabase for one confirmed order of store-a. `readStatus` lets a test make the order lookup answer 400 (id is not a UUID).
function stub({ role = 'store_admin', orderStatus = 'store_confirmed', readStatus = 200 } = {}) {
  const log = { patch: null };
  global.fetch = async (url, options = {}) => {
    if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (url.includes('/profiles')) return jsonResponse([{ id: 'user-1', role }]);
    if (url.includes('/store_accounts')) return jsonResponse([{ store_id: 'store-a' }]);
    if (url.includes('/store_order_notifications')) return jsonResponse({}, 201);
    if (url.includes('/store_order_requests') && options.method === 'PATCH') { log.patch = JSON.parse(options.body); return jsonResponse([{ id: 'request-1' }]); }
    if (url.includes('/store_order_requests?select=id,store_id,tracking_number,status')) {
      return readStatus === 200
        ? jsonResponse([{ id: 'request-1', store_id: 'store-a', tracking_number: 'T-1', status: orderStatus }])
        : jsonResponse({ code: '22P02', message: 'invalid input syntax for type uuid' }, readStatus);
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

test('shipping and total amounts must be finite, non-negative numbers; nothing is written otherwise', async () => {
  for (const bad of [-1, 'abc', NaN, Infinity, '', '   ', true, {}, [], 1e12, '1e12']) {
    const log = stub();
    const a = await update({ requestId: 'request-1', status: 'processing', shippingAmount: bad });
    assert.equal(a.status, 400, `shippingAmount ${String(bad)}`);
    assert.equal(a.body.error, 'invalid_amount');
    const b = await update({ requestId: 'request-1', status: 'processing', totalAmount: bad });
    assert.equal(b.status, 400, `totalAmount ${String(bad)}`);
    assert.equal(log.patch, null, 'a rejected amount must never reach the database');
  }
});

test('valid amounts are stored as numbers rounded to two decimals, zero included, and omitted ones are left alone', async () => {
  const log = stub();
  const ok = await update({ requestId: 'request-1', status: 'processing', shippingAmount: '45.456', totalAmount: 0 });
  assert.equal(ok.status, 200);
  assert.equal(log.patch.shipping_amount, 45.46);
  assert.equal(log.patch.total_amount, 0);
  const none = await update({ requestId: 'request-1', status: 'processing' });
  assert.equal(none.status, 200);
  assert.equal('shipping_amount' in log.patch, false);
  assert.equal('total_amount' in log.patch, false);
});

test('the rejection reason is stored trimmed and capped, and a non-text reason is ignored', async () => {
  const log = stub();
  await update({ requestId: 'request-1', status: 'store_rejected', reason: `  ${'س'.repeat(800)}  ` });
  assert.equal(log.patch.failure_reason.length, 500);
  await update({ requestId: 'request-1', status: 'store_rejected', reason: { $ne: null } });
  assert.equal('failure_reason' in log.patch, false);
});

test('the financial lock still applies to store accounts once the order has shipped', async () => {
  stub({ orderStatus: 'shipped' });
  const result = await update({ requestId: 'request-1', status: 'delivered', totalAmount: 10 });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'financial_update_locked');
});

test('an id that is not a UUID is a 400 for the caller, not a database failure', async () => {
  stub({ readStatus: 400 });
  const result = await update({ requestId: 'not-a-uuid', status: 'processing' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_request_id');
});
