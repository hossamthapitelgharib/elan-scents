const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const handler = require(path.join(root, 'api', 'store-order-update'));

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; }, end() { return this; } }; }
async function update(status) {
  const res = recorder();
  await handler({ method: 'PATCH', headers: { authorization: 'Bearer test-token' }, body: { requestId: 'request-1', status } }, res);
  return res.out;
}

// store-order-update.test.js feeds the handler a canned empty PATCH answer. This file runs two requests at the same time
// against a database that keeps state and filters the PATCH like PostgREST, with both reads finishing before either write.
function installDatabase({ role, orderStatus }) {
  const row = { id: 'request-1', store_id: 'store-a', tracking_number: 'T-1', status: orderStatus };
  const state = { row, patches: [], notifications: [] };
  let reads = 0;
  let release;
  const bothRead = new Promise((resolve) => { release = resolve; });
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    if (url.pathname.endsWith('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (url.pathname.endsWith('/rest/v1/profiles')) return jsonResponse([{ id: 'user-1', role }]);
    if (url.pathname.endsWith('/rest/v1/store_accounts')) return jsonResponse([{ store_id: 'store-a' }]);
    if (url.pathname.endsWith('/rest/v1/store_order_requests') && method === 'GET') {
      const snapshot = [{ ...row }];
      reads += 1;
      if (reads >= 2) release();
      await bothRead;
      return jsonResponse(snapshot);
    }
    if (url.pathname.endsWith('/rest/v1/store_order_requests') && method === 'PATCH') {
      state.patches.push(url);
      if (url.searchParams.get('id') !== `eq.${row.id}` || url.searchParams.get('status') !== `eq.${row.status}`) return jsonResponse([]);
      Object.assign(row, JSON.parse(options.body));
      return jsonResponse([{ id: row.id }]);
    }
    if (url.pathname.endsWith('/rest/v1/store_order_notifications')) { state.notifications.push(JSON.parse(options.body)); return jsonResponse({}, 201); }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  return state;
}

const savedEnv = {};
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) savedEnv[key] = process.env[key];
const savedFetch = global.fetch;
test.beforeEach(() => { process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; });
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  global.fetch = savedFetch;
});

test('two store updates racing from the same status: one is saved, the other gets 409 and no notification', async () => {
  const db = installDatabase({ role: 'store_admin', orderStatus: 'store_confirmed' });
  const results = await Promise.all([update('processing'), update('processing')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const loser = results.find((r) => r.status === 409);
  assert.equal(loser.body.error, 'order_status_changed');
  assert.equal(loser.body.from, 'store_confirmed');
  assert.equal(db.row.status, 'processing');
  assert.equal(db.patches.length, 2, 'both requests tried to write, only one matched');
  assert.equal(db.notifications.length, 1, 'only the saved update notifies');
});

test('two platform_admin overrides racing from the same status are protected the same way', async () => {
  const db = installDatabase({ role: 'platform_admin', orderStatus: 'needs_review' });
  const results = await Promise.all([update('store_confirmed'), update('store_rejected')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.ok(db.patches.every((url) => url.searchParams.get('status') === 'eq.needs_review'));
  assert.equal(db.notifications.length, 1);
});
