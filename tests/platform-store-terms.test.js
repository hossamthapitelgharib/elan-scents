const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-store-terms'));
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
async function run(role, body, method = 'PUT', rpcResponse = response({ store_id: storeId, commission_rate: 15, return_window_days: 14 })) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: adminId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: adminId, role }]);
    if (url.pathname.endsWith('/rpc/platform_set_store_commercial_terms')) return rpcResponse;
    throw new Error(`unexpected ${url.pathname}`);
  };
  const res = recorder(); await handler({ method, body, headers: { authorization: 'Bearer token' } }, res);
  return { res: res.out, requests };
}
test('commercial terms API is restricted to platform administrators', async () => {
  const { res, requests } = await run('customer', { storeId, returnWindowDays: 14 });
  assert.equal(res.status, 403);
  assert.equal(requests.some(request => request.url.pathname.endsWith('/rpc/platform_set_store_commercial_terms')), false);
});
test('commercial terms validate fixed commission and individual return window before database write', async () => {
  for (const body of [
    { storeId, returnWindowDays: 0 }, { storeId, returnWindowDays: 366 },
    { storeId, returnWindowDays: 14, commissionRate: 10 }, { storeId: 'not-a-uuid', returnWindowDays: 14 }
  ]) {
    const { res, requests } = await run('platform_admin', body);
    assert.equal(res.status, 400);
    assert.equal(requests.some(request => request.url.pathname.endsWith('/rpc/platform_set_store_commercial_terms')), false);
  }
});
test('platform administrator saves 15 percent terms with a per-store return window through the protected RPC', async () => {
  const { res, requests } = await run('platform_admin', { storeId, commissionRate: 15, returnWindowDays: 14 });
  assert.equal(res.status, 200);
  assert.equal(res.body.terms.return_window_days, 14);
  const rpc = requests.find(request => request.url.pathname.endsWith('/rpc/platform_set_store_commercial_terms'));
  assert.deepEqual(JSON.parse(rpc.options.body), { p_store_id: storeId, p_return_window_days: 14, p_actor: adminId });
  assert.equal(rpc.options.headers.Authorization, 'Bearer service-key');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('commercial terms endpoint accepts only PUT', async () => {
  const { res, requests } = await run('platform_admin', {}, 'GET');
  assert.equal(res.status, 405);
  assert.equal(requests.length, 0);
});
