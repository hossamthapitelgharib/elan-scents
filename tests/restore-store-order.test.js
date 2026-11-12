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
async function call(body, { method = 'POST', ip = `10.1.0.${++ipCounter}` } = {}) {
  const res = recorder();
  await handler({ method, headers: { 'x-forwarded-for': ip }, body }, res);
  return res.out;
}

const calls = [];
let databaseRows = [];
let patchStatus = 200;
function stubFetch(rows, { patch = 200 } = {}) {
  calls.length = 0;
  databaseRows = rows.map((row) => ({ ...row }));
  patchStatus = patch;
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const entry = { url: url.toString(), method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(entry);
    if (method !== 'PATCH') {
      const token = url.searchParams.get('restore_token')?.replace(/^eq\./, '').toLowerCase();
      return jsonResponse(databaseRows.filter((row) => String(row.restore_token).toLowerCase() === token).slice(0, 1));
    }
    if (patchStatus !== 200) return jsonResponse({ message: 'write failed' }, patchStatus);
    const token = url.searchParams.get('restore_token')?.replace(/^eq\./, '').toLowerCase();
    const row = databaseRows.find((candidate) => candidate.id === url.searchParams.get('id')?.replace(/^eq\./, '')
      && String(candidate.restore_token).toLowerCase() === token
      && candidate.status === 'pending'
      && Number.isFinite(Date.parse(candidate.created_at))
      && Date.parse(candidate.created_at) >= Date.parse(url.searchParams.get('created_at')?.replace(/^gte\./, '')));
    if (!row) return jsonResponse([]);
    Object.assign(row, entry.body);
    const returned = { request_id: row.request_id, tracking_number: row.tracking_number, items: row.items };
    return jsonResponse([returned]);
  };
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const pendingRow = {
  id: 'row-1', restore_token: TOKEN, request_id: 'req-1', tracking_number: 'ELN-20261020-0001-S01',
  items: [{ productSizeId: 'p1', quantity: 2 }], status: 'pending', customer_phone: '+201000000000',
  customer_email: 'a@b.co', created_at: ago(60 * 60 * 1000)
};
const savedEnv = {};
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) savedEnv[key] = process.env[key];
const savedFetch = global.fetch;
test.beforeEach(() => { process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; });
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  global.fetch = savedFetch;
});

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

test('a valid pending token is atomically consumed and returns only the data needed to restore the cart', async () => {
  stubFetch([pendingRow]);
  const result = await call({ restoreToken: TOKEN.toUpperCase() });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true, status: 'restored', trackingNumber: 'ELN-20261020-0001-S01', requestId: 'req-1',
    items: [{ productSizeId: 'p1', quantity: 2 }]
  });
  assert.equal(JSON.stringify(result.body).includes('+201000000000'), false);
  assert.equal(JSON.stringify(result.body).includes('a@b.co'), false);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /restore_token=eq\.3F6C2A9E-8B1D-4C57-9A0E-7D2B5C1F4E66/);
  assert.equal(calls[1].method, 'PATCH');
  const updateUrl = new URL(calls[1].url);
  assert.equal(updateUrl.searchParams.get('status'), 'eq.pending');
  assert.match(updateUrl.searchParams.get('created_at'), /^gte\./);
  assert.equal(updateUrl.searchParams.get('select'), 'request_id,tracking_number,items');
  assert.match(JSON.stringify(calls[1].body), /"status":"restored"/);
  assert.equal(databaseRows[0].status, 'restored');
});

test('already restored and recently expired tokens cannot be replayed or disclose contact data', async () => {
  stubFetch([{ ...pendingRow, status: 'restored' }]);
  const restored = await call({ token: TOKEN });
  assert.equal(restored.status, 410);
  assert.equal(restored.body.error, 'restoration_already_used');
  assert.equal(calls.length, 1, 'a used token must not be written again');
  assert.doesNotMatch(JSON.stringify(restored.body), /\+201000000000|a@b\.co/);

  stubFetch([{ ...pendingRow, status: 'expired' }]);
  const expired = await call({ token: TOKEN });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error, 'restoration_expired');
  assert.equal(calls.length, 1, 'an expired row must not be written');
  assert.doesNotMatch(JSON.stringify(expired.body), /\+201000000000|a@b\.co/);
});

test('two requests racing for the same pending token produce one success and one conflict', async () => {
  stubFetch([pendingRow]);
  const results = await Promise.all([call({ restoreToken: TOKEN }), call({ restoreToken: TOKEN })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = results.find((result) => result.status === 200);
  const loser = results.find((result) => result.status === 409);
  assert.equal(winner.body.items.length, 1);
  assert.deepEqual(loser.body, { ok: false, error: 'restoration_already_used' });
  assert.doesNotMatch(JSON.stringify(loser.body), /\+201000000000|a@b\.co|productSizeId/);
  assert.equal(calls.filter((entry) => entry.method === 'PATCH').length, 2);
  assert.equal(databaseRows[0].status, 'restored');
});

test('an update failure is a 502, and missing service configuration remains a 503', async () => {
  stubFetch([pendingRow], { patch: 500 });
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

test('the link expires after 30 days, including on the conditional write boundary', async () => {
  assert.equal(handler.RESTORE_TTL_MS, 30 * DAY);
  stubFetch([{ ...pendingRow, created_at: ago(29 * DAY) }]);
  const inside = await call({ restoreToken: TOKEN });
  assert.equal(inside.status, 200);
  assert.match(calls[0].url, /select=[^&]*created_at/);
  assert.match(new URL(calls[1].url).searchParams.get('created_at'), /^gte\./);

  stubFetch([{ ...pendingRow, created_at: ago(31 * DAY) }]);
  const outside = await call({ restoreToken: TOKEN });
  assert.equal(outside.status, 410);
  assert.deepEqual(outside.body, { ok: false, error: 'restoration_expired' });
});

test('an expired or unreadable row never restores the order or returns customer contact details', async () => {
  for (const status of ['pending', 'restored', 'expired']) {
    stubFetch([{ ...pendingRow, status, created_at: ago(45 * DAY) }]);
    const result = await call({ restoreToken: TOKEN });
    assert.equal(result.status, 410, status);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.doesNotMatch(JSON.stringify(result.body), /\+201000000000|a@b\.co/);
    assert.equal(calls.filter((entry) => entry.method === 'PATCH').length, 0, 'an expired link must not write');
  }
  for (const created_at of [undefined, null, '', 'not-a-date']) {
    stubFetch([{ ...pendingRow, created_at }]);
    assert.equal((await call({ restoreToken: TOKEN })).status, 410, String(created_at));
  }
});

test('an unknown token remains 404 and the storefront removes the bearer token before making its API call', async () => {
  stubFetch([]);
  const result = await call({ restoreToken: TOKEN });
  assert.equal(result.status, 404);
  assert.equal(result.body.error, 'restoration_not_found');

  const core = require('node:fs').readFileSync(path.join(root, 'app-core.js'), 'utf8');
  const start = core.indexOf('function restoreCancelledStoreItemsFromToken');
  const end = core.indexOf('\nasync function cartFlush', start + 1);
  const body = core.slice(start, end);
  assert.ok(body.indexOf('history.replaceState') < body.indexOf("fetch('/api/restore-store-order'"), 'the token query must be stripped before the request');
  assert.match(body, /restoration_already_used/);
});
