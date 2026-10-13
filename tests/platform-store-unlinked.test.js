const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-store-unlinked'));
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
async function run(role, query, database) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: adminId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: adminId, role }]);
    return database(url, options);
  };
  const res = recorder();
  await handler({ method: 'GET', query, headers: { authorization: 'Bearer admin-token' } }, res);
  return { res: res.out, requests };
}

test('unlinked store-operation records are admin-only', async () => {
  const { res, requests } = await run('customer', { type: 'events' }, async () => { throw new Error('must reject before query'); });
  assert.equal(res.status, 403);
  assert.equal(requests.filter(item => item.url.pathname.startsWith('/rest/v1/') && !item.url.pathname.endsWith('/profiles')).length, 0);
});

test('unlinked notifications are paginated and raw payloads are never returned', async () => {
  const { res, requests } = await run('platform_admin', { type: 'notifications', limit: '10', offset: '50' }, async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer service-key');
    return response([{ id: 'notice-1', tracking_number: 'TRK-1', event_type: 'store_update', store_status: 'processing', match_status: 'mismatched', mismatch_fields: ['status'], received_at: '2026-01-02T00:00:00Z', payload: { customer_phone: 'secret' }, customer_email: 'secret@example.test' }]);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.records.length, 1);
  assert.equal(res.body.offset, 50);
  assert.equal(res.body.hasMore, false);
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
  assert.equal(JSON.stringify(res.body).includes('payload'), false);
  const query = requests.find(item => item.url.pathname.endsWith('/store_order_notifications')).url;
  assert.equal(query.searchParams.get('request_id'), 'is.null');
  assert.equal(query.searchParams.get('limit'), '11');
  assert.equal(query.searchParams.get('offset'), '50');
});

test('session-level operation events are shown without payload or actor identifiers', async () => {
  const { res } = await run('platform_admin', { type: 'events' }, async url => {
    assert.equal(url.pathname.endsWith('/order_operation_events'), true);
    return response([{ id: 'event-1', checkout_session_id: 'session-1', actor_role: 'system', event_type: 'checkout_started', source: 'api', created_at: '2026-01-02T00:00:00Z', actor_user_id: adminId, payload: { customer_email: 'secret' }, before_state: {}, after_state: {} }]);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.records[0].checkout_session_id, 'session-1');
  for (const secret of ['actor_user_id', 'payload', 'before_state', 'after_state', 'secret']) assert.equal(JSON.stringify(res.body).includes(secret), false);
});
