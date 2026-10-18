const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { guestHashSecret, MIN_LENGTH } = require(path.join(__dirname, '..', 'lib', 'guest-hash-secret.js'));
const guestCart = require(path.join(__dirname, '..', 'api', 'guest-cart'));
const customerActivity = require(path.join(__dirname, '..', 'api', 'customer-activity'));

// Every value below is made up for the tests.
const SERVICE_KEY = 'fake-service-role-key-for-tests-0001';
const ROTATED_KEY = 'fake-service-role-key-for-tests-0002';
const GUEST_SECRET = 'fake-guest-hash-secret-for-tests';
const visitorKey = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const sessionId = '145a6e52-46c6-42e9-a730-9e5bec3dd202';
const hmac = (secret, purpose, value) => createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');

const NAMES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'GUEST_HASH_SECRET'];
const savedEnv = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
const savedFetch = global.fetch;
test.after(() => {
  global.fetch = savedFetch;
  for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : process.env[k] = v;
});
function setEnv(values) {
  for (const k of NAMES) delete process.env[k];
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  Object.assign(process.env, values);
}
function recorder() {
  const out = { headers: {} };
  return { out, status(n) { out.status = n; return this; }, setHeader(k, v) { out.headers[k] = v; return this; }, json(b) { out.body = b; return this; } };
}
function jsonResponse(data) { return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }); }

async function resolveHashes() {
  const calls = [];
  global.fetch = async (url, options = {}) => { calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null }); return jsonResponse({ visitorId: sessionId, status: 'guest', cart: [] }); };
  const res = recorder();
  await guestCart({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey } }, res);
  const call = calls.find((c) => /rpc\/resolve_guest_browser$/.test(c.url));
  return { res: res.out, hashes: call && call.body };
}
async function activityHashes() {
  const calls = [];
  global.fetch = async (url, options = {}) => { calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null }); return jsonResponse(true); };
  const res = recorder();
  await customerActivity({ method: 'POST', headers: {}, body: { action: 'session', sessionAction: 'start', visitorKey, sessionId } }, res);
  const call = calls.find((c) => /rpc\/record_customer_session$/.test(c.url));
  return { res: res.out, payload: call && call.body };
}

test('guestHashSecret: its own secret wins once it is long enough, otherwise the old key is used', () => {
  assert.equal(guestHashSecret({ GUEST_HASH_SECRET: GUEST_SECRET, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }), GUEST_SECRET);
  assert.equal(guestHashSecret({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }), SERVICE_KEY);
  assert.equal(guestHashSecret({ SUPABASE_SECRET_KEY: SERVICE_KEY }), SERVICE_KEY);
  assert.equal(guestHashSecret({ GUEST_HASH_SECRET: 'x'.repeat(MIN_LENGTH - 1), SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }), SERVICE_KEY, 'a short secret is ignored, not used');
  assert.equal(guestHashSecret({ GUEST_HASH_SECRET: '   ', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }), SERVICE_KEY);
  assert.equal(guestHashSecret({}), '');
});

test('without GUEST_HASH_SECRET the hashes are exactly what they were (history is untouched)', async () => {
  setEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });
  const { res, hashes } = await resolveHashes();
  assert.equal(res.status, 200);
  assert.equal(hashes.p_fingerprint_hash, hmac(SERVICE_KEY, 'guest-browser', visitorKey));
  assert.equal(hashes.p_analytics_hash, hmac(SERVICE_KEY, 'guest-analytics', visitorKey));
  const { payload } = await activityHashes();
  assert.equal(payload.p_fingerprint_hash, hmac(SERVICE_KEY, 'guest-browser', visitorKey));
});

test('with GUEST_HASH_SECRET the hashes come from it, and rotating the database key no longer changes them', async () => {
  setEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, GUEST_HASH_SECRET: GUEST_SECRET });
  const before = await resolveHashes();
  assert.equal(before.hashes.p_fingerprint_hash, hmac(GUEST_SECRET, 'guest-browser', visitorKey));
  assert.equal(before.hashes.p_analytics_hash, hmac(GUEST_SECRET, 'guest-analytics', visitorKey));
  assert.notEqual(before.hashes.p_fingerprint_hash, hmac(SERVICE_KEY, 'guest-browser', visitorKey));
  const activity = await activityHashes();
  assert.equal(activity.payload.p_fingerprint_hash, before.hashes.p_fingerprint_hash, 'both endpoints derive the same guest hash');

  setEnv({ SUPABASE_SERVICE_ROLE_KEY: ROTATED_KEY, GUEST_HASH_SECRET: GUEST_SECRET });
  const after = await resolveHashes();
  assert.deepEqual(after.hashes, before.hashes, 'a rotated service-role key leaves every guest hash as it was');
});

test('the service-role key is still what authenticates the database calls', async () => {
  setEnv({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, GUEST_HASH_SECRET: GUEST_SECRET });
  const seen = [];
  global.fetch = async (url, options = {}) => { seen.push(options.headers || {}); return jsonResponse({ visitorId: sessionId, status: 'guest', cart: [] }); };
  await guestCart({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey } }, recorder());
  assert.ok(seen.length > 0);
  for (const headers of seen) {
    assert.equal(headers.apikey, SERVICE_KEY);
    assert.equal(JSON.stringify(headers).includes(GUEST_SECRET), false, 'the hash secret never leaves the server');
  }
});

test('both endpoints answer 503 when there is no secret to hash with', async () => {
  setEnv({});
  global.fetch = async () => { throw new Error('must not reach the database'); };
  const a = recorder();
  await guestCart({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey } }, a);
  assert.equal(a.out.status, 503);
  const b = recorder();
  await customerActivity({ method: 'POST', headers: {}, body: { action: 'session', sessionAction: 'start', visitorKey, sessionId } }, b);
  assert.equal(b.out.status, 503);
});
