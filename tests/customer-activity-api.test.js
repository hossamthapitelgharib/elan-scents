const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'customer-activity'));
const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const visitorKey = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const sessionId = '145a6e52-46c6-42e9-a730-9e5bec3dd202';
const productId = '245a6e52-46c6-42e9-a730-9e5bec3dd203';
const sizeId = '345a6e52-46c6-42e9-a730-9e5bec3dd204';
const storeProductId = '445a6e52-46c6-42e9-a730-9e5bec3dd205';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
async function run({ token = '', body }, database) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = String(input); calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return response({ id: userId });
    return database(url, options);
  };
  const res = recorder();
  await handler({ method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return { res: res.out, calls };
}

test('guest sessions send only server-HMAC browser identifiers to the session RPC', async () => {
  const { res, calls } = await run({ body: { action: 'session', sessionAction: 'start', visitorKey, sessionId } }, async (url, options) => {
    assert.match(url, /\/rpc\/record_customer_session$/);
    assert.equal(options.headers.Authorization, 'Bearer service-key');
    return response(true);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.tracked, true);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.p_user_id, null);
  assert.equal(payload.p_session_id, sessionId);
  assert.equal(payload.p_action, 'start');
  assert.match(payload.p_fingerprint_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(payload.p_fingerprint_hash, visitorKey);
  assert.equal(JSON.stringify(payload).includes(visitorKey), false);
});

test('registered product events are attached to the authenticated customer and normalized', async () => {
  const { res, calls } = await run({ token: 'customer-token', body: { action: 'track', eventType: 'cart_add', productId, productSizeId: sizeId, storeProductId, quantity: 1000, sessionId } }, async (url, options) => {
    assert.equal(url.endsWith('/auth/v1/user'), false);
    if (url.endsWith('/rpc/record_customer_product_event')) return response(true);
    throw new Error(`unexpected ${url}`);
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.tracked, true);
  const authCall = calls.find(call => call.url.endsWith('/auth/v1/user'));
  assert.equal(authCall.options.headers.Authorization, 'Bearer customer-token');
  const rpc = calls.find(call => call.url.endsWith('/rpc/record_customer_product_event'));
  const payload = JSON.parse(rpc.options.body);
  assert.equal(payload.p_user_id, userId);
  assert.equal(payload.p_fingerprint_hash, null);
  assert.equal(payload.p_analytics_hash, null);
  assert.equal(payload.p_session_id, sessionId);
  assert.equal(payload.p_event_type, 'cart_add');
  assert.equal(payload.p_product_id, productId);
  assert.equal(payload.p_product_size_id, sizeId);
  assert.equal(payload.p_store_product_id, storeProductId);
  assert.equal(payload.p_quantity, 99);
});

test('anonymous product activity cannot be written without a valid visitor key', async () => {
  const { res, calls } = await run({ body: { action: 'track', eventType: 'view', productId, sessionId, visitorKey: 'not-a-uuid' } }, async () => { throw new Error('RPC must not run'); });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_browser_key');
  assert.equal(calls.length, 0);
});
