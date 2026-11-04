const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-commission-payment'));
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const commissionId = 'c38b94c6-3c67-44f4-95e1-0957c1b4aa52';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
async function run(role, body, rpcResponse = response({ commission_id: commissionId, status: 'paid', payment_reference: 'BANK-REF-001' })) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: adminId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: adminId, role }]);
    if (url.pathname.endsWith('/rpc/platform_mark_commission_paid')) return rpcResponse;
    throw new Error(`unexpected ${url.pathname}`);
  };
  const res = recorder(); await handler({ method: 'POST', body, headers: { authorization: 'Bearer token' } }, res);
  return { res: res.out, requests };
}
test('commission settlement API is restricted to platform administrators', async () => {
  const { res, requests } = await run('store_admin', { commissionId, paymentReference: 'BANK-REF-001' });
  assert.equal(res.status, 403);
  assert.equal(requests.some(request => request.url.pathname.endsWith('/rpc/platform_mark_commission_paid')), false);
});
test('commission settlement requires valid commission id and bounded non-empty payment reference', async () => {
  for (const body of [
    { commissionId: 'bad', paymentReference: 'BANK-REF-001' },
    { commissionId, paymentReference: '' },
    { commissionId, paymentReference: 'x'.repeat(161) }
  ]) {
    const { res, requests } = await run('platform_admin', body);
    assert.equal(res.status, 400);
    assert.equal(requests.some(request => request.url.pathname.endsWith('/rpc/platform_mark_commission_paid')), false);
  }
});
test('platform administrator records a payable commission with its payment reference', async () => {
  const { res, requests } = await run('platform_admin', { commissionId, paymentReference: 'BANK-REF-001' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settlement.status, 'paid');
  const rpc = requests.find(request => request.url.pathname.endsWith('/rpc/platform_mark_commission_paid'));
  assert.deepEqual(JSON.parse(rpc.options.body), { p_commission_id: commissionId, p_payment_reference: 'BANK-REF-001', p_actor: adminId });
  assert.equal(rpc.options.headers.Authorization, 'Bearer service-key');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('attempt to settle commission that is not payable is surfaced as conflict', async () => {
  const { res } = await run('platform_admin', { commissionId, paymentReference: 'BANK-REF-001' }, response({ message: 'Commission is not payable' }, 400));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'commission_not_payable');
});
