const test = require('node:test');
const assert = require('node:assert/strict');
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const originalFetch = global.fetch;
process.env.SUPABASE_URL = 'https://search-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
const handler = require('../api/customer-activity');
const product = 'b674011e-50e9-4731-a984-4c8fec18f64a';
const size = '76aeaf77-94c9-4382-9f54-93b3c5d70d67';
const storeProduct = '29249de1-83ec-47ab-92cf-785cf1c41aa3';
const session = '045a6e52-46c6-42e9-a730-9e5bec3dd201';
const browserKey = '145a6e52-46c6-42e9-a730-9e5bec3dd202';
const userId = '245a6e52-46c6-42e9-a730-9e5bec3dd203';

function response(ok, body) { return { ok, json: async () => body }; }
async function invoke(body, authorization = '') {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body || '{}') });
    if (String(url).endsWith('/auth/v1/user')) return response(true, { id: userId });
    return response(true, true);
  };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ method: 'POST', headers: authorization ? { authorization } : {}, body }, res);
  return { res, calls };
}

test.after(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('search API sends exact query and validated product identifiers to the service-only RPC for a guest', async () => {
  const { res, calls } = await invoke({
    action: 'search', sessionId: session, visitorKey: browserKey,
    searchText: '  عطر الورد  ',
    results: [{ productId: product, productSizeId: size, storeProductId: storeProduct }]
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, tracked: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rpc\/record_customer_search$/);
  assert.equal(calls[0].body.p_user_id, null);
  assert.match(calls[0].body.p_fingerprint_hash, /^[a-f0-9]{64}$/);
  assert.match(calls[0].body.p_analytics_hash, /^[a-f0-9]{64}$/);
  assert.equal(calls[0].body.p_session_id, session);
  assert.equal(calls[0].body.p_search_text, 'عطر الورد');
  assert.deepEqual(calls[0].body.p_results, [{ productId: product, productSizeId: size, storeProductId: storeProduct }]);
});

test('search API authenticates registered customers and permits recording a search with no results', async () => {
  const { res, calls } = await invoke({
    action: 'search', sessionId: session, searchText: 'منتج غير موجود', results: []
  }, 'Bearer customer-token');
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/auth\/v1\/user$/);
  assert.match(calls[1].url, /\/rpc\/record_customer_search$/);
  assert.equal(calls[1].body.p_user_id, userId);
  assert.equal(calls[1].body.p_fingerprint_hash, null);
  assert.deepEqual(calls[1].body.p_results, []);
});

test('search API rejects blank/oversized text, malformed identifiers, and more than ten products', async () => {
  for (const [body, error] of [
    [{ action: 'search', sessionId: session, visitorKey: browserKey, searchText: '  ', results: [] }, 'invalid_search_text'],
    [{ action: 'search', sessionId: session, visitorKey: browserKey, searchText: 'x'.repeat(201), results: [] }, 'invalid_search_text'],
    [{ action: 'search', sessionId: session, visitorKey: browserKey, searchText: 'valid', results: [{ productId: 'bad' }] }, 'invalid_search_results'],
    [{ action: 'search', sessionId: session, visitorKey: browserKey, searchText: 'valid', results: Array.from({ length: 11 }, () => ({ productId: product })) }, 'invalid_search_results']
  ]) {
    const { res, calls } = await invoke(body);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, error);
    assert.deepEqual(calls, []);
  }
});
