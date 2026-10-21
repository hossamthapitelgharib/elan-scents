const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const handler = require(path.join(__dirname, '..', 'api', 'customer-activity'));
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

function recorder() {
  const out = { headers: {} };
  return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[String(key).toLowerCase()] = value; return this; }, json(body) { out.body = body; return this; } };
}
// An unknown action is answered 400 before any database work, which keeps the loop below cheap.
async function call(ip, headers = {}) {
  const res = recorder();
  await handler({ method: 'POST', headers: { 'x-real-ip': ip, ...headers }, body: { action: 'nothing' } }, res);
  return res.out;
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  global.fetch = async () => { throw new Error('the rate-limit test must never reach Supabase'); };
});

test('one client address gets 600 calls a minute, then 429 with Retry-After, and nobody else is affected', async () => {
  for (let i = 0; i < 600; i += 1) assert.equal((await call('203.0.113.50')).status, 400, `call ${i + 1}`);
  const blocked = await call('203.0.113.50');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'too_many_requests');
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
  assert.equal(blocked.headers['cache-control'], 'no-store');
  assert.equal((await call('203.0.113.51')).status, 400, 'a different client keeps working');
});

test('rotating X-Forwarded-For does not give a client a fresh allowance when the edge reports its real address', async () => {
  for (let i = 0; i < 600; i += 1) await call('203.0.113.60', { 'x-forwarded-for': `10.9.${i % 200}.${i % 250}` });
  const blocked = await call('203.0.113.60', { 'x-forwarded-for': '10.250.250.250' });
  assert.equal(blocked.status, 429);
});

test('wrong methods and cross-site posts are still refused first and do not need a database', async () => {
  const res = recorder();
  await handler({ method: 'GET', headers: { 'x-real-ip': '203.0.113.70' } }, res);
  assert.equal(res.out.status, 405);
  const cross = await call('203.0.113.71', { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
});
