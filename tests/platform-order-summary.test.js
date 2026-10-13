const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-order-summary'));

function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function jsonResponse(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

function configureAdmin() {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
}

test('platform order summary rejects non-admin users before reading orders', async () => {
  configureAdmin();
  let calls = 0;
  global.fetch = async url => { calls++; return String(url).includes('/auth/v1/user') ? jsonResponse({ id: 'u1' }) : jsonResponse([{ id: 'u1', role: 'customer' }]); };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer customer-token' } }, res);
  assert.equal(res.out.status, 403);
  assert.equal(calls, 2);
});

test('platform order summary uses count-only HEAD queries and returns aggregate counts', async () => {
  configureAdmin();
  const queries = [];
  const values = [70, 18, 47, 5];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: 'admin' });
    if (target.includes('/rest/v1/profiles?select=id,full_name,phone,role')) return jsonResponse([{ id: 'admin', role: 'platform_admin' }]);
    queries.push({ target, options });
    return new Response(null, { status: 200, headers: { 'content-range': `*/${values[queries.length - 1]}` } });
  };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' } }, res);
  assert.equal(res.out.status, 200);
  assert.deepEqual(res.out.body, { ok: true, counts: { orders: 70, completed: 18, open: 47, needsReview: 5 } });
  assert.equal(queries.length, 4);
  assert.ok(queries.every(({ target, options }) => options.method === 'HEAD' && options.headers.Prefer === 'count=exact' && options.headers.Range === '0-0' && new URL(target).searchParams.get('select') === 'id'));
  assert.ok(queries.every(({ target }) => !/customer_(name|phone|address|email)/.test(target)));
});
