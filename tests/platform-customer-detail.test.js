const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/platform-customer-detail');
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
const customerId = '245a6e52-46c6-42e9-a730-9e5bec3dd203';
function response(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers }); }
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function adminFetch(rpcResults = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return response({ id: 'admin-id' });
    if (target.includes('/profiles?select=id,full_name,phone,role')) return response([{ id: 'admin-id', role: 'platform_admin' }]);
    calls.push({ target, options, body: JSON.parse(options.body || '{}') });
    const name = target.split('/').at(-1);
    return response(rpcResults[name] || { found: true });
  };
  return calls;
}

test.before(() => { process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'; });
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

test('admin customer detail endpoint combines activity and paged search history', async () => {
  const calls = adminFetch({
    platform_customer_activity_detail: { found: true, actorType: 'guest', events: [], sessions: [], currentCart: [], eventTotal: 0, visitCount: 1, activeSeconds: 10, hasMore: false },
    platform_customer_search_detail: { searches: [{ searchText: 'عطر وردي', resultCount: 1, results: [] }], searchTotal: 3, hasMore: true }
  });
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { type: 'guest', id: customerId, limit: '20', offset: '0' } }, res);
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.detail.searches[0].searchText, 'عطر وردي');
  assert.equal(res.out.body.detail.searchTotal, 3);
  assert.equal(res.out.body.detail.hasMore, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.target.split('/').at(-1)), ['platform_customer_activity_detail', 'platform_customer_search_detail']);
  assert.ok(calls.every(call => call.body.p_guest_id === customerId && call.body.p_user_id === null && call.body.p_limit === 20));
  assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer service-key'));
});

test('registered customer detail uses registered id and queries through admin-only RPCs', async () => {
  const calls = adminFetch({
    platform_customer_activity_detail: { found: true, actorType: 'customer', events: [], sessions: [], currentCart: [] },
    platform_customer_search_detail: { searches: [], searchTotal: 0, hasMore: false }
  });
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { type: 'customer', id: customerId } }, res);
  assert.equal(res.out.status, 200);
  assert.ok(calls.every(call => call.body.p_guest_id === null && call.body.p_user_id === customerId));
});

test('non-admin cannot obtain customer search history', async () => {
  let rpcCalls = 0;
  global.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: 'customer-id' });
    if (String(url).includes('/profiles?select=id,full_name,phone,role')) return response([{ id: 'customer-id', role: 'customer' }]);
    rpcCalls++; return response({});
  };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer customer-token' }, query: { type: 'customer', id: customerId } }, res);
  assert.equal(res.out.status, 403);
  assert.equal(rpcCalls, 0);
});
