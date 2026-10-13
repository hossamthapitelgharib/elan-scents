const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-customer-summary'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers }); }
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

test('customer summary rejects non-admin users before querying counts', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  let calls = 0;
  global.fetch = async url => { calls++; return String(url).includes('/auth/v1/user') ? response({ id: 'u1' }) : response([{ id: 'u1', role: 'customer' }]); };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer token' } }, res);
  assert.equal(res.out.status, 403);
  assert.equal(calls, 2);
});

test('customer summary returns counts only and fetches at most one identifier per group', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return response({ id: 'admin' });
    if (target.includes('/profiles?select=id,full_name,phone,role')) return response([{ id: 'admin', role: 'platform_admin' }]);
    calls.push({ target, headers: options.headers || {} });
    if (target.includes('/rest/v1/profiles?')) return response([{ id: 'x' }], 200, { 'content-range': '0-0/20' });
    if (target.includes('/rest/v1/guest_visitors?')) return response([{ id: 'y' }], 200, { 'content-range': '0-0/8' });
    throw new Error(`unexpected ${target}`);
  };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' } }, res);
  assert.equal(res.out.status, 200);
  assert.deepEqual(res.out.body, { ok: true, counts: { registered: 20, visitors: 8 } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => new URL(call.target).searchParams.get('select') === 'id'));
  assert.ok(calls.every(call => call.headers.Prefer === 'count=exact' && call.headers.Range === '0-0'));
});
