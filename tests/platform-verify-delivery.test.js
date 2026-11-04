const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-verify-delivery'));
const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const requestId = 'e1a15d03-e6d9-40d3-846c-bef4a311c001';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
async function run(role, body, method = 'POST', rpcResponse = response({ requestId, shippingStatus: 'delivered', alreadyVerified: false })) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: userId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: userId, role }]);
    if (url.pathname.endsWith('/rpc/platform_verify_store_delivery')) return rpcResponse;
    throw new Error(`unexpected ${url.pathname}`);
  };
  const res = recorder(); await handler({ method, body, headers: { authorization: 'Bearer token' } }, res);
  return { res: res.out, requests };
}
const validBody = { requestId, deliveredAt: '2026-11-03T12:30:00.000Z', evidenceReference: 'carrier portal shipment SHP-123' };
test('manual delivery verification is limited to platform administrators', async () => {
  const { res, requests } = await run('store_admin', validBody);
  assert.equal(res.status, 403);
  assert.equal(requests.some(request => request.url.pathname.endsWith('/rpc/platform_verify_store_delivery')), false);
});
test('delivery evidence validation rejects invalid ids, timestamps and references', async () => {
  for (const body of [
    { ...validBody, requestId: 'bad' }, { ...validBody, deliveredAt: 'not-a-date' },
    { ...validBody, deliveredAt: '2026-11-04T12:30:00' }, { ...validBody, evidenceReference: 'x' },
    { ...validBody, evidenceReference: 'x'.repeat(201) }
  ]) {
    const { res, requests } = await run('platform_admin', body);
    assert.equal(res.status, 400);
    assert.equal(requests.some(request => request.url.pathname.endsWith('/rpc/platform_verify_store_delivery')), false);
  }
});
test('platform verification calls the server-only RPC with verified carrier reference and timestamp', async () => {
  const { res, requests } = await run('platform_admin', validBody);
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery.alreadyVerified, false);
  const rpc = requests.find(request => request.url.pathname.endsWith('/rpc/platform_verify_store_delivery'));
  assert.deepEqual(JSON.parse(rpc.options.body), {
    p_request_id: requestId, p_delivered_at: new Date(validBody.deliveredAt).toISOString(),
    p_evidence_reference: validBody.evidenceReference, p_actor: userId
  });
  assert.equal(rpc.options.headers.Authorization, 'Bearer service-key');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('already verified shipments return a conflict without leaking database messages', async () => {
  const { res } = await run('platform_admin', validBody, 'POST', response({ message: 'Delivery already verified' }, 400));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'delivery_already_verified');
});
test('the store dashboard labels manual verification as a carrier-portal check', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'stores-dashboard.js'), 'utf8');
  assert.match(js, /بعد مراجعة بوابة شركة الشحن/);
  assert.match(js, /platform-verify-delivery/);
  assert.match(js, /data-verify-delivery/);
});
