const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'guest-analytics'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';

test('customer analytics summaries are available only to platform administrators', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let calledRpc = false;
  global.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: adminId });
    if (String(url).includes('/profiles?')) return response([{ id: adminId, role: 'customer' }]);
    if (String(url).includes('/rpc/customer_activity_summary')) calledRpc = true;
    return response({});
  };
  const res = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer customer-token' }, query: { period: 'today' } }, res);
  assert.equal(res.out.status, 403); assert.equal(calledRpc, false);
});

test('admin summary accepts both customer groups and all supported date ranges', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (value.includes('/profiles?')) return response([{ id: adminId, role: 'platform_admin' }]);
    if (value.endsWith('/rpc/customer_activity_summary')) { calls.push(JSON.parse(options.body)); return response({ actorType: calls.at(-1).p_actor_type, period: calls.at(-1).p_period, people: 7, cartRemoves: 3, topViewed: [], topSearched: [], topCartAdded: [], topCartRemoved: [] }); }
    throw new Error(`unexpected ${value}`);
  };
  const guest = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { period: 'week', actor: 'guest' } }, guest);
  assert.equal(guest.out.status, 200); assert.equal(guest.out.body.analytics.people, 7); assert.equal(calls[0].p_period, 'week'); assert.equal(calls[0].p_actor_type, 'guest');
  const customer = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { period: 'year', actor: 'customer' } }, customer);
  assert.equal(customer.out.status, 200); assert.equal(calls[1].p_actor_type, 'customer');
  const invalidPeriod = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { period: 'all-time' } }, invalidPeriod);
  assert.equal(invalidPeriod.out.status, 400);
  const invalidActor = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { actor: 'anonymous' } }, invalidActor);
  assert.equal(invalidActor.out.status, 400); assert.equal(calls.length, 2);
});
