const test = require('node:test');
const assert = require('node:assert/strict');
const { config, incrementWindow, getValue, setValue, deleteValue } = require('../lib/state-store');
const { createDistributedLimiter } = require('../lib/rate-limit');

const keys = ['STATE_STORE_URL', 'STATE_STORE_TOKEN', 'STATE_STORE_REQUIRED', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const originalFetch = global.fetch;
test.after(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(original)) value === undefined ? delete process.env[key] : process.env[key] = value;
});

function clearStoreEnv() {
  for (const key of keys) delete process.env[key];
}
function setEnv(key, value) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }

test('shared state remains optional for local development', () => {
  assert.equal(config({}), null);
  assert.equal(config({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'local-key' }), null);
});

test('Upstash configuration retains precedence and requires both credentials', () => {
  assert.deepEqual(config({ STATE_STORE_URL: 'https://redis.example/', STATE_STORE_TOKEN: 'token', STATE_STORE_REQUIRED: '1', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' }), {
    provider: 'upstash', url: 'https://redis.example', token: 'token'
  });
  assert.equal(config({ STATE_STORE_URL: 'https://redis.example', STATE_STORE_REQUIRED: '1' }), null);
});

test('Supabase shared counter posts only an HMAC digest and parses the atomic RPC result', async () => {
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), options });
    return new Response(JSON.stringify({ count: 4, ttlMs: 12000 }), { status: 200 });
  };
  const result = await incrementWindow('login:192.0.2.44', 60000, {
    STATE_STORE_REQUIRED: '1', SUPABASE_URL: 'https://test.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key'
  });
  assert.deepEqual(result, { count: 4, ttlMs: 12000 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://test.supabase.co/rest/v1/rpc/consume_edge_rate_limit');
  const body = JSON.parse(seen[0].options.body);
  assert.match(body.p_bucket_key, /^[0-9a-f]{64}$/);
  assert.equal(body.p_window_ms, 60000);
  assert.equal(seen[0].options.body.includes('192.0.2.44'), false);
  assert.equal(seen[0].options.headers.Authorization, 'Bearer test-service-key');
  assert.ok(seen[0].options.signal instanceof AbortSignal);
});

test('distributed limiter uses the shared Supabase RPC and denies requests past the limit', async () => {
  clearStoreEnv();
  process.env.STATE_STORE_REQUIRED = '1';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    return new Response(JSON.stringify({ count: calls.length, ttlMs: 60000 }), { status: 200 });
  };
  try {
    const check = createDistributedLimiter({ name: 'test', max: 2, windowMs: 60000 });
    assert.equal((await check('192.0.2.10')).allowed, true);
    assert.equal((await check('192.0.2.10')).allowed, true);
    assert.equal((await check('192.0.2.10')).allowed, false);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => !call.body.includes('192.0.2.10')));
  } finally {
    clearStoreEnv();
    for (const [key, value] of Object.entries(original)) setEnv(key, value);
  }
});

test('required shared state fails closed instead of allowing a per-process bypass', async () => {
  clearStoreEnv();
  process.env.STATE_STORE_REQUIRED = '1';
  try {
    const check = createDistributedLimiter({ name: 'test-fail-closed', max: 2, windowMs: 60000 });
    const result = await check('client');
    assert.equal(result.allowed, false);
    assert.equal(result.unavailable, true);
  } finally {
    clearStoreEnv();
    for (const [key, value] of Object.entries(original)) setEnv(key, value);
  }
});

test('distributed limiter preserves its local fallback when no shared store is required', async () => {
  clearStoreEnv();
  try {
    const check = createDistributedLimiter({ name: 'local-test', max: 2, windowMs: 60000 });
    assert.equal((await check('a')).allowed, true);
    assert.equal((await check('a')).allowed, true);
    assert.equal((await check('a')).allowed, false);
  } finally {
    clearStoreEnv();
    for (const [key, value] of Object.entries(original)) setEnv(key, value);
  }
});

test('shared state supports session revocation reads and writes through the REST pipeline', async () => {
  const oldUrl = process.env.STATE_STORE_URL;
  const oldToken = process.env.STATE_STORE_TOKEN;
  const oldFetch = global.fetch;
  process.env.STATE_STORE_URL = 'https://redis.example.test';
  process.env.STATE_STORE_TOKEN = 'token';
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options: JSON.parse(options.body) });
    return { ok: true, json: async () => [{ result: '1' }] };
  };
  try {
    assert.equal(await setValue('revoked', '1', 1000), true);
    assert.equal(await getValue('revoked'), '1');
    assert.equal(await deleteValue('revoked'), true);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].options[0], ['SET', 'revoked', '1', 'PX', '1000']);
    assert.deepEqual(calls[1].options[0], ['GET', 'revoked']);
    assert.deepEqual(calls[2].options[0], ['DEL', 'revoked']);
  } finally {
    global.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.STATE_STORE_URL; else process.env.STATE_STORE_URL = oldUrl;
    if (oldToken === undefined) delete process.env.STATE_STORE_TOKEN; else process.env.STATE_STORE_TOKEN = oldToken;
  }
});
