const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const handler = require(path.join(root, 'api', 'restore-store-order'));
const TOKEN = '3f6c2a9e-8b1d-4c57-9a0e-7d2b5c1f4e66';
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function recorder() {
  const out = { headers: {} };
  return {
    out,
    status(n) { out.status = n; return this; },
    setHeader(name, value) { out.headers[String(name).toLowerCase()] = value; return this; },
    json(body) { out.body = body; return this; },
    end() { return this; }
  };
}
let ipCounter = 0;
// Every call gets its own client address unless a test pins one, so the per-IP limiter never leaks between tests.
async function call(body, { method = 'POST', ip = `10.1.0.${++ipCounter}` } = {}) {
  const res = recorder();
  await handler({ method, headers: { 'x-forwarded-for': ip }, body }, res);
  return res.out;
}

const calls = [];
function stubFetch(rows) {
  calls.length = 0;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if (init.method === 'PATCH') return jsonResponse([]);
    return jsonResponse(rows);
  };
}
const pendingRow = { id: 'row-1', request_id: 'req-1', tracking_number: 'ELN-20261020-0001-S01', items: [{ productSizeId: 'p1', quantity: 2 }], status: 'pending', customer_phone: '+201000000000', customer_email: 'a@b.co' };

test.beforeEach(() => { process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; });

test('only POST is accepted and a missing token is a 400', async () => {
  stubFetch([]);
  assert.equal((await call({}, { method: 'GET' })).status, 405);
  const missing = await call({});
  assert.equal(missing.status, 400);
  assert.equal(calls.length, 0);
});

test('a token that is not a UUID is answered 404 without ever reaching the database', async () => {
  stubFetch([pendingRow]);
  for (const bad of ['abc', "x' or '1'='1", '3f6c2a9e-8b1d-4c57-9a0e', `${TOKEN}0`, { $ne: null }, ['a'], 12345]) {
    const result = await call({ restoreToken: bad });
    assert.equal(result.status, 404, JSON.stringify(bad));
    assert.equal(result.body.error, 'restoration_not_found');
  }
  assert.equal(calls.length, 0, 'malformed tokens must be rejected before any Supabase call');
});

test('a valid pending token is restored once and returns the same payload as before', async () => {
  stubFetch([pendingRow]);
  const result = await call({ restoreToken: TOKEN.toUpperCase() });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true, status: 'restored', trackingNumber: 'ELN-20261020-0001-S01', requestId: 'req-1',
    items: [{ productSizeId: 'p1', quantity: 2 }], customer: { phone: '+201000000000', email: 'a@b.co' }
  });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /restore_token=eq\.3F6C2A9E-8B1D-4C57-9A0E-7D2B5C1F4E66/);
  assert.equal(calls[1].method, 'PATCH');
  assert.match(calls[1].body, /"status":"restored"/);
});

test('an already restored token is idempotent and does not write again', async () => {
  stubFetch([{ ...pendingRow, status: 'restored' }]);
  const result = await call({ token: TOKEN });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('an unknown token and a failing update keep their previous status codes', async () => {
  stubFetch([]);
  assert.equal((await call({ restoreToken: TOKEN })).status, 404);
  global.fetch = async (url, init = {}) => (init.method === 'PATCH' ? jsonResponse({}, 500) : jsonResponse([pendingRow]));
  assert.equal((await call({ restoreToken: TOKEN })).status, 502);
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal((await call({ restoreToken: TOKEN })).status, 503);
});

test('one client address is limited to 30 attempts a minute and other clients are unaffected', async () => {
  stubFetch([]);
  const ip = '203.0.113.7';
  for (let i = 0; i < 30; i += 1) assert.equal((await call({ restoreToken: TOKEN }, { ip })).status, 404);
  const hitsBefore = calls.length;
  const blocked = await call({ restoreToken: TOKEN }, { ip });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'too_many_requests');
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
  assert.equal(calls.length, hitsBefore, 'a limited request must not reach Supabase');
  assert.equal((await call({ restoreToken: TOKEN })).status, 404, 'a different client is not limited');
});
