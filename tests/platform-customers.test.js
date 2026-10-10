const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-customers'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const guestId = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';

test('platform customer dashboard requires a platform admin role', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let called = 0;
  global.fetch = async url => { called++; if (String(url).includes('/auth/v1/user')) return response({ id: adminId }); return response([{ id: adminId, role: 'customer' }]); };
  const res = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer customer-token' } }, res);
  assert.equal(res.out.status, 403); assert.equal(called, 2);
});

test('platform customer dashboard separates registered accounts from active guests and summarizes both baskets', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const requests = [];
  global.fetch = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (value.includes('/profiles?select=id,full_name,phone,role&id=')) return response([{ id: adminId, role: 'platform_admin' }]);
    if (value.includes('/profiles?select=id%2Cfull_name%2Cphone%2Crole')) return response([{ id: adminId, role: 'platform_admin' }]);
    if (value.includes('/profiles?select=id%2Cfull_name%2Cphone%2Ccreated_at')) return response([{ id: adminId, full_name: 'عميل مسجل', phone: '0100', created_at: '2026-01-01T00:00:00Z' }]);
    if (value.includes('/guest_visitors?')) return response([{ id: guestId, fingerprint_hash: 'a'.repeat(64), status: 'guest', cart_snapshot: [{ sid: guestId, q: 2 }], captured_at: '2026-01-02T00:00:00Z', first_seen_at: '2026-01-02T00:00:00Z', last_seen_at: '2026-01-03T00:00:00Z' }]);
    if (value.includes('/cart_items?')) return response([{ user_id: adminId, quantity: 3 }, { user_id: adminId, quantity: 1 }]);
    throw new Error(`unexpected ${value}`);
  };
  const res = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.registeredCustomers.length, 1);
  assert.equal(res.out.body.registeredCustomers[0].cartItems, 2); assert.equal(res.out.body.registeredCustomers[0].cartUnits, 4);
  assert.equal(res.out.body.guestVisitors.length, 1); assert.equal(res.out.body.guestVisitors[0].cart_units, 2);
  assert.equal(res.out.body.counts.registered, 1); assert.equal(res.out.body.counts.visitors, 1);
  assert.ok(requests.some(url => /identity_version=eq\.2/.test(url)));
});
