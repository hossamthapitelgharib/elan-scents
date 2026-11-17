const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-alerts'));

/* Made-up data only. */
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader(name, value) { (out.headers = out.headers || {})[name] = value; return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const idOf = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

const row = (n, extra = {}) => ({ id: idOf(n), type: 'order_payment_recorded', title: 'تم تسجيل الدفع', body: 'سُجّل دفع الطلب ELN-TEST-0001', is_read: false, created_at: `2026-11-15T10:0${n}:00Z`, tracking_number: 'ELN-TEST-0001', request_id: idOf(90), store_id: idOf(91), payload: { customer: { phone: '01000000000' } }, recipient_role: 'platform_admin', ...extra });

function fake(role, { rows = [row(1), row(2)], unread = 5, notices = 3, total = 40, failCount = false, failPatch = false } = {}) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return response({ id: adminId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: adminId, role }]);
    const call = { table: url.pathname.replace('/rest/v1/', ''), method: options.method || 'GET', params: Object.fromEntries(url.searchParams), headers: options.headers, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    if (call.table === 'notifications' && call.method === 'PATCH') return failPatch ? response({}, 500) : new Response(null, { status: 204 });
    if (call.table === 'notifications' && call.method === 'HEAD') return failCount ? response({}, 500) : new Response(null, { status: 200, headers: { 'content-range': `*/${unread}` } });
    if (call.table === 'platform_order_notices' && call.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${notices}` } });
    if (call.table === 'notifications') return response(rows, 200, { 'content-range': `0-${rows.length - 1}/${total}` });
    throw new Error(`unexpected ${call.method} ${url.pathname}`);
  };
  return calls;
}
async function call(req) { const res = recorder(); await handler({ headers: { authorization: 'Bearer token' }, ...req }, res); return res.out; }

test('only a platform admin: customers and store accounts get 403 on both reads and writes, and nothing is touched', async () => {
  for (const role of ['customer', 'store_admin']) {
    for (const method of ['GET', 'PATCH']) {
      const calls = fake(role);
      const out = await call({ method, query: {}, body: { all: true } });
      assert.equal(out.status, 403, `${role} ${method}`);
      assert.equal(calls.length, 0);
    }
  }
  global.fetch = async () => { throw new Error('no request without a token'); };
  const res = recorder();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.out.status, 401);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await call({ method, query: {} })).status, 405, method);
});

test('the poll answers the unread count, how many first notices exist, and the newest messages', async () => {
  const calls = fake('platform_admin');
  const out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 200);
  assert.equal(out.body.unread, 5);
  assert.equal(out.body.firstNotices, 3);
  assert.equal(out.body.total, 40);
  assert.equal(out.body.hasMore, true);
  assert.ok(!Number.isNaN(Date.parse(out.body.serverTime)));
  assert.equal(out.body.notifications.length, 2);
  assert.deepEqual(Object.keys(out.body.notifications[0]).sort(), ['body', 'createdAt', 'id', 'isRead', 'requestId', 'storeId', 'title', 'trackingNumber', 'type']);
  const list = calls.find(c => c.table === 'notifications' && c.method === 'GET');
  assert.equal(list.params.recipient_role, 'eq.platform_admin', 'only the platform\'s own messages');
  assert.equal(list.params.order, 'created_at.desc,id.desc');
  assert.equal(list.params.limit, '30');
  assert.ok(!/payload/.test(list.params.select), 'the raw payload is never selected');
});

test('no message carries the order payload, so no customer data rides along', async () => {
  fake('platform_admin');
  const json = JSON.stringify((await call({ method: 'GET', query: {} })).body);
  assert.ok(!json.includes('01000000000'));
  assert.ok(!json.includes('payload'));
});

test('nothing is there yet: zero messages and zero first notices are a normal answer', async () => {
  fake('platform_admin', { rows: [], unread: 0, notices: 0, total: 0 });
  const out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 200);
  assert.deepEqual([out.body.unread, out.body.firstNotices, out.body.total, out.body.hasMore, out.body.notifications.length], [0, 0, 0, false, 0]);
});

test('the filters (unread only, one type, a page) reach the database', async () => {
  const calls = fake('platform_admin');
  await call({ method: 'GET', query: { unread: '1', type: 'customer_cancel_requested', limit: '10', offset: '20' } });
  const list = calls.find(c => c.table === 'notifications' && c.method === 'GET');
  assert.equal(list.params.is_read, 'eq.false');
  assert.equal(list.params.type, 'eq.customer_cancel_requested');
  assert.equal(list.params.limit, '10');
  assert.equal(list.params.offset, '20');
});

test('the unread number counts every unread message, whatever page or type is on screen', async () => {
  const calls = fake('platform_admin');
  await call({ method: 'GET', query: { type: 'order_initial', limit: '5' } });
  const count = calls.find(c => c.table === 'notifications' && c.method === 'HEAD');
  assert.equal(count.params.recipient_role, 'eq.platform_admin');
  assert.equal(count.params.is_read, 'eq.false');
  assert.equal(count.params.type, undefined);
});

test('bad input is refused before the database is asked', async () => {
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { offset: '-1' }, { type: 'a b' }, { type: 'x=y&z' }, { type: 'UPPER' }]) {
    const calls = fake('platform_admin');
    const out = await call({ method: 'GET', query });
    assert.equal(out.status, 400, JSON.stringify(query));
    assert.equal(calls.length, 0);
  }
});

test('marking read: one message, several, or all the unread ones, and only ever the platform\'s own', async () => {
  let calls = fake('platform_admin');
  assert.equal((await call({ method: 'PATCH', body: { id: idOf(1) } })).status, 200);
  let patch = calls.find(c => c.method === 'PATCH');
  assert.equal(patch.params.id, `eq.${idOf(1)}`);
  assert.equal(patch.params.recipient_role, 'eq.platform_admin');
  assert.equal(patch.body.is_read, true);
  assert.ok(!Number.isNaN(Date.parse(patch.body.read_at)));

  calls = fake('platform_admin');
  await call({ method: 'PATCH', body: { ids: [idOf(1), idOf(2)] } });
  patch = calls.find(c => c.method === 'PATCH');
  assert.equal(patch.params.id, `in.(${idOf(1)},${idOf(2)})`);
  assert.equal(patch.params.recipient_role, 'eq.platform_admin');

  calls = fake('platform_admin');
  await call({ method: 'PATCH', body: { all: true } });
  patch = calls.find(c => c.method === 'PATCH');
  assert.equal(patch.params.is_read, 'eq.false');
  assert.equal(patch.params.recipient_role, 'eq.platform_admin');
  assert.equal(patch.params.id, undefined);
});

test('a write that names nothing, or names something that is not an id, changes nothing', async () => {
  for (const body of [{}, null, { id: 'nope' }, { ids: [] }, { ids: ['nope'] }, { ids: [idOf(1), 5] }, { ids: Array.from({ length: 101 }, (_, i) => idOf(i + 1)) }, { all: 'yes' }]) {
    const calls = fake('platform_admin');
    const out = await call({ method: 'PATCH', body });
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test('failures are plain codes: a failed count or write is a 502, and the cache is off', async () => {
  fake('platform_admin', { failCount: true });
  let out = await call({ method: 'GET', query: {} });
  assert.deepEqual([out.status, out.body.error], [502, 'platform_alerts_unavailable']);
  assert.equal(out.headers['Cache-Control'], 'no-store');
  fake('platform_admin', { failPatch: true });
  out = await call({ method: 'PATCH', body: { all: true } });
  assert.deepEqual([out.status, out.body.error], [502, 'notification_update_failed']);
});
