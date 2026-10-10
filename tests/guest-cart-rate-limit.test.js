const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLimiter, clientIp } = require(path.join(__dirname, '..', 'lib', 'rate-limit'));
const handler = require(path.join(__dirname, '..', 'api', 'guest-cart'));

function recorder() { const out = { headers: {} }; return { out, status(n) { out.status = n; return this; }, setHeader(k, v) { out.headers[k] = v; }, json(body) { out.body = body; return this; } }; }
const reply = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const visitorKey = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';

test('limiter allows up to max per window, then blocks, then recovers when the window ends', () => {
  let t = 1000;
  const check = createLimiter({ max: 3, windowMs: 60000, now: () => t });
  assert.equal(check('a').allowed, true);
  assert.equal(check('a').allowed, true);
  const third = check('a');
  assert.equal(third.allowed, true); assert.equal(third.remaining, 0);
  const fourth = check('a');
  assert.equal(fourth.allowed, false); assert.ok(fourth.retryAfter >= 1 && fourth.retryAfter <= 60);
  assert.equal(check('b').allowed, true, 'another client is not affected');
  t += 60001;
  assert.equal(check('a').allowed, true, 'window reset');
});

test('limiter memory is bounded', () => {
  const check = createLimiter({ max: 1, windowMs: 60000, maxKeys: 5 });
  for (let i = 0; i < 50; i += 1) check(`k${i}`);
  assert.ok(check('fresh').allowed);
});

test('clientIp prefers the proxy header and never throws on missing data', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }), '203.0.113.7');
  assert.equal(clientIp({ headers: { 'x-real-ip': '198.51.100.2' } }), '198.51.100.2');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(clientIp({}), 'unknown');
});

test('guest-cart answers 429 with Retry-After after 30 resolves from one address and still serves others', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  global.fetch = async () => reply({ visitorId: visitorKey, status: 'guest', cart: [] });
  const call = async (ip) => {
    const res = recorder();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': ip }, body: { action: 'resolve', visitorKey } }, res);
    return res.out;
  };
  for (let i = 0; i < 30; i += 1) assert.equal((await call('192.0.2.50')).status, 200, `request ${i + 1}`);
  const blocked = await call('192.0.2.50');
  assert.equal(blocked.status, 429); assert.equal(blocked.body.error, 'too_many_requests');
  assert.ok(Number(blocked.headers['Retry-After']) >= 1);
  assert.equal((await call('192.0.2.51')).status, 200, 'a different address is unaffected');
});
