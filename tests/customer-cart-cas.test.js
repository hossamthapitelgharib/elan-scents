'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'NEXT_PUBLIC_SUPABASE_URL'];
const previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.SUPABASE_URL = 'https://cart-cas.example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-service-secret';
const handler = require('../api/customer-cart');
const CORE = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const CART_SYNC = CORE.slice(CORE.indexOf('function mergeCartSnapshots('), CORE.indexOf('async function saveGuestCartToCloud('));
const USER = 'f1000000-0000-4000-8000-000000000001';
const SIZE1 = 'f1000000-0000-4000-8000-000000000011';
const SIZE2 = 'f1000000-0000-4000-8000-000000000012';
const SIZE3 = 'f1000000-0000-4000-8000-000000000013';
const SP1 = 'f1000000-0000-4000-8000-000000000021';
const SP2 = 'f1000000-0000-4000-8000-000000000022';
const SP3 = 'f1000000-0000-4000-8000-000000000023';
const originalFetch = global.fetch;
function response(body, ok = true, status = ok ? 200 : 409) { return { ok, status, json: async () => body }; }
async function apiCall({ method = 'GET', token = 'buyer-token', body, rpcAnswer } = {}) {
  const log = { calls: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url); log.calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return token ? response({ id: USER, email: 'buyer@example.invalid' }) : response({}, false, 401);
    if (url.includes('/rest/v1/profiles')) return response([{ id: USER, role: 'customer' }]);
    const rpc = /\/rest\/v1\/rpc\/([^/?]+)$/.exec(url);
    if (rpc) {
      assert.equal(options.headers.apikey, 'unit-test-service-secret');
      assert.equal(options.headers.Authorization, 'Bearer unit-test-service-secret');
      const data = typeof rpcAnswer === 'function' ? rpcAnswer(rpc[1], JSON.parse(options.body)) : rpcAnswer;
      return response(data === undefined ? { items: [], revision: 0 } : data);
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } };
  const req = { method, headers: token ? { authorization: 'Bearer ' + token } : {}, body };
  await handler(req, res);
  return { res, log };
}
test.after(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
function client({ cart, revision = 3, fetchImpl }) {
  const saved = new Map();
  const context = {
    AUTH: { access_token: 'token', user: { id: USER } }, SB: { url: 'https://supabase.example.invalid', key: 'anon' }, LOGGING_OUT: false,
    CART: cart, CART_REV: 0, CART_SERVER_REVISION: revision, CART_OWNER: USER, CART_SYNCING: false, CART_PULLING: false,
    CART_PUSH_QUEUED: false, CART_LOCAL_DIRTY: true, CART_FIRST_SYNC_DONE: true, PERFUMES: [{ id: SIZE1 }, { id: SIZE2 }, { id: SIZE3 }],
    sidForStoreProduct(id) { return ({ [SP1]: SIZE1, [SP2]: SIZE2, [SP3]: SIZE3 })[id] || ''; },
    storeProductIdFor(sid) { return ({ [SIZE1]: SP1, [SIZE2]: SP2, [SIZE3]: SP3 })[sid] || ''; },
    localStorage: { setItem(k, v) { saved.set(k, String(v)); }, removeItem(k) { saved.delete(k); } }, cartBadge() {},
    fetch: fetchImpl, setTimeout(fn) { context.queued = fn; return 1; }, console
  };
  context.AUTH_ID = () => context.AUTH && context.AUTH.user && context.AUTH.user.id || '';
  vm.createContext(context); vm.runInContext(CART_SYNC.replace(/authUserId\(\)/g, 'AUTH_ID()'), context, { filename: 'app-core.js cart sync' });
  return { context, saved };
}
test('GET returns the authenticated account cart and its revision through the server-only read RPC', async () => {
  const { res, log } = await apiCall({ rpcAnswer: { items: [{ storeProductId: SP1, quantity: 3 }], revision: 12 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, items: [{ storeProductId: SP1, quantity: 3 }], revision: 12 });
  assert.match(log.calls.at(-1).url, /rpc\/read_customer_cart_server$/);
  assert.deepEqual(JSON.parse(log.calls.at(-1).options.body), { p_user_id: USER });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('POST requires an expected revision and returns an explicit 409 with the current snapshot on conflict', async () => {
  const missing = await apiCall({ method: 'POST', body: { items: [] } });
  assert.equal(missing.res.statusCode, 400);
  assert.equal(missing.res.body.error, 'invalid_cart_revision');
  assert.equal(missing.log.calls.some(call => call.url.includes('/rpc/')), false);
  const { res, log } = await apiCall({ method: 'POST', body: { items: [{ storeProductId: SP1, quantity: 2 }], expectedRevision: 4 }, rpcAnswer: { ok: false, conflict: true, items: [{ storeProductId: SP1, quantity: 8 }], revision: 5 } });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { ok: false, error: 'cart_conflict', items: [{ storeProductId: SP1, quantity: 8 }], revision: 5 });
  assert.match(log.calls.at(-1).url, /rpc\/replace_customer_cart_server_cas$/);
  assert.deepEqual(JSON.parse(log.calls.at(-1).options.body), { p_items: [{ storeProductId: SP1, quantity: 2 }], p_expected_revision: 4, p_user_id: USER });
});
test('a CAS conflict merges counts by maximum, never addition, then retries with the latest revision', async () => {
  const sent = [];
  const c = client({ cart: [{ sid: SIZE1, storeProductId: SP1, q: 5 }], revision: 2, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    if (sent.length === 1) return response({ ok: false, error: 'cart_conflict', items: [{ storeProductId: SP1, quantity: 8 }, { storeProductId: SP3, quantity: 2 }], revision: 7 }, false, 409);
    return response({ ok: true, items: body.items, revision: 8 });
  } });
  await vm.runInContext('pushCartToCloud()', c.context);
  assert.deepEqual(sent[0], { items: [{ storeProductId: SP1, quantity: 5 }], expectedRevision: 2 });
  assert.deepEqual(sent[1], { items: [{ storeProductId: SP1, quantity: 8 }, { storeProductId: SP3, quantity: 2 }], expectedRevision: 7 });
  assert.equal(c.context.CART_SERVER_REVISION, 8);
  assert.equal(c.context.CART_LOCAL_DIRTY, false);
  assert.equal(c.context.CART.find(row => row.sid === SIZE1).q, 8, 'the larger quantity wins; it is not summed');
});
test('local edits made while a CAS request is in flight survive its conflict and are included in retry', async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const sent = [];
  const c = client({ cart: [{ sid: SIZE1, storeProductId: SP1, q: 2 }], revision: 4, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    if (sent.length === 1) return first;
    return response({ ok: true, items: body.items, revision: 10 });
  } });
  const pending = vm.runInContext('pushCartToCloud()', c.context);
  c.context.CART = [{ sid: SIZE1, storeProductId: SP1, q: 7 }, { sid: SIZE2, storeProductId: SP2, q: 1 }];
  c.context.CART_REV++;
  release(response({ ok: false, error: 'cart_conflict', items: [{ storeProductId: SP1, quantity: 4 }, { storeProductId: SP3, quantity: 2 }], revision: 9 }, false, 409));
  await pending;
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { items: [{ storeProductId: SP1, quantity: 7 }, { storeProductId: SP3, quantity: 2 }, { storeProductId: SP2, quantity: 1 }], expectedRevision: 9 });
  assert.equal(c.context.CART.find(row => row.sid === SIZE1).q, 7);
  assert.ok(c.context.CART.some(row => row.sid === SIZE2), 'a line added during the request remains local');
  assert.equal(c.context.CART_SERVER_REVISION, 10);
  assert.equal(c.context.CART_LOCAL_DIRTY, false);
});
test('a switched account never receives the previous account cache', async () => {
  const c = client({ cart: [{ sid: SIZE1, storeProductId: SP1, q: 9 }], revision: null, fetchImpl: async () => response({ ok: true, items: [{ storeProductId: SP2, quantity: 1 }], revision: 3 }) });
  c.context.AUTH.user.id = 'f1000000-0000-4000-8000-000000000099';
  c.context.CART_OWNER = USER;
  c.context.CART_LOCAL_DIRTY = false;
  await vm.runInContext('syncCartFromCloud(false)', c.context);
  assert.deepEqual(Array.from(c.context.CART, row => row.sid), [SIZE2]);
  assert.equal(c.context.CART_OWNER, c.context.AUTH.user.id);
});
