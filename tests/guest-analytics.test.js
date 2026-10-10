const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'guest-analytics'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';

 test('guest analytics are available only to platform administrators', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let calledRpc = false;
  global.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: adminId });
    if (String(url).includes('/profiles?')) return response([{ id: adminId, role: 'customer' }]);
    if (String(url).includes('/rpc/guest_analytics_summary')) calledRpc = true;
    return response({});
  };
  const res = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer customer-token' }, query: { period: 'today' } }, res);
  assert.equal(res.out.status, 403); assert.equal(calledRpc, false);
});

test('admin analytics accepts only the four supported ranges and returns aggregate data', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let rpcPayload; let rpcCalls = 0;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (value.includes('/profiles?')) return response([{ id: adminId, role: 'platform_admin' }]);
    if (value.endsWith('/rpc/guest_analytics_summary')) { rpcCalls++; rpcPayload = JSON.parse(options.body); return response({ visitorCount: 7, activeVisitors: 3, productViews: 12, productSearches: 4, cartAdds: 2, topProducts: [], activeBasketProducts: [] }); }
    throw new Error(`unexpected ${value}`);
  };
  const res = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { period: 'week' } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.analytics.visitorCount, 7); assert.equal(rpcPayload.p_period, 'week');
  const invalid = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { period: 'all-time' } }, invalid);
  assert.equal(invalid.out.status, 400); assert.equal(rpcCalls, 1);
});
