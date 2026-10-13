const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-customers'));

function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const guestId = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;

test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
function configureAdminFetch(handlerFetch) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (target.includes('/profiles?select=id,full_name,phone,role')) return response([{ id: adminId, role: 'platform_admin' }]);
    return handlerFetch(target, options);
  };
}

test('platform customer dashboard requires a platform admin role', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let called = 0;
  global.fetch = async url => { called++; return String(url).includes('/auth/v1/user') ? response({ id: adminId }) : response([{ id: adminId, role: 'customer' }]); };
  const res = recorder(); await handler({ method: 'GET', headers: { authorization: 'Bearer customer-token' } }, res);
  assert.equal(res.out.status, 403); assert.equal(called, 2);
});

test('customer lists expose exact totals and independently page registered users and guests', async () => {
  const requests = [];
  configureAdminFetch((target, options) => {
    requests.push({ target, headers: options.headers || {} });
    const url = new URL(target);
    if (url.pathname.endsWith('/profiles')) {
      const rows = Array.from({ length: 50 }, (_, index) => ({ id: `customer-${index}`, full_name: `عميل ${index}`, phone: '0100', created_at: '2026-01-01T00:00:00Z' }));
      return response(rows, 200, { 'content-range': `${url.searchParams.get('registeredOffset') || url.searchParams.get('offset')}-${Number(url.searchParams.get('offset')) + rows.length - 1}/501` });
    }
    if (url.pathname.endsWith('/guest_visitors')) {
      const rows = Array.from({ length: 50 }, (_, index) => ({ id: `guest-${index}`, fingerprint_hash: 'a'.repeat(64), status: 'guest', cart_snapshot: [{ sid: guestId, q: 2, productSnapshot: { name: 'private snapshot' } }], captured_at: '2026-01-02T00:00:00Z', first_seen_at: '2026-01-02T00:00:00Z', last_seen_at: '2026-01-03T00:00:00Z' }));
      return response(rows, 200, { 'content-range': `${url.searchParams.get('offset')}-${Number(url.searchParams.get('offset')) + rows.length - 1}/501` });
    }
    if (url.pathname.endsWith('/cart_items')) return response([]);
    throw new Error(`unexpected ${target}`);
  });
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { registeredOffset: '50', visitorOffset: '100' } }, res);
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.registeredCustomers.length, 50);
  assert.equal(res.out.body.guestVisitors.length, 50);
  assert.deepEqual(res.out.body.counts, { registered: 501, visitors: 501 });
  assert.deepEqual(res.out.body.pagination.registered, { offset: 50, limit: 50, total: 501, hasMore: true });
  assert.deepEqual(res.out.body.pagination.visitors, { offset: 100, limit: 50, total: 501, hasMore: true });
  assert.equal(Object.hasOwn(res.out.body.guestVisitors[0], 'cart_snapshot'), false);
  assert.ok(requests.filter(request => /\/(profiles|guest_visitors)$/.test(new URL(request.target).pathname)).every(request => request.headers.Prefer === 'count=exact'));
  assert.ok(requests.some(request => new URL(request.target).pathname.endsWith('/profiles') && new URL(request.target).searchParams.get('offset') === '50'));
  assert.ok(requests.some(request => new URL(request.target).pathname.endsWith('/guest_visitors') && new URL(request.target).searchParams.get('offset') === '100'));
});

test('registered basket summary paginates beyond 5,000 cart rows without truncation', async () => {
  let cartPages = 0;
  configureAdminFetch((target) => {
    const url = new URL(target);
    if (url.pathname.endsWith('/profiles') && url.searchParams.get('select') === 'id,full_name,phone,created_at') return response([{ id: adminId, full_name: 'عميل مسجل', phone: '0100', created_at: '2026-01-01T00:00:00Z' }], 200, { 'content-range': '0-0/1' });
    if (url.pathname.endsWith('/guest_visitors')) return response([], 200, { 'content-range': '*/0' });
    if (url.pathname.endsWith('/cart_items')) {
      cartPages++;
      const offset = Number(url.searchParams.get('offset'));
      const length = offset < 5000 ? 1000 : 25;
      return response(Array.from({ length }, () => ({ user_id: adminId, quantity: 1 })));
    }
    throw new Error(`unexpected ${target}`);
  });
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: {} }, res);
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.registeredCustomers[0].cartItems, 5025);
  assert.equal(res.out.body.registeredCustomers[0].cartUnits, 5025);
  assert.equal(cartPages, 6);
});
