const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-audit-log'));

function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader(name, value) { (out.headers = out.headers || {})[name] = value; return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const accountId = '0b7d8b0e-5b5e-4c3e-9d54-0c2a8f4f2b11';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

function fake(role, rpcAnswer) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return response({ id: adminId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: adminId, role }]);
    if (url.pathname === '/rest/v1/rpc/platform_audit_entries') {
      calls.push({ args: JSON.parse(options.body || '{}'), headers: options.headers, method: options.method });
      return typeof rpcAnswer === 'function' ? rpcAnswer(calls.length) : rpcAnswer;
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  return calls;
}
async function call(req) { const res = recorder(); await handler({ headers: { authorization: 'Bearer token' }, ...req }, res); return res.out; }
const row = (n, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, created_at: `2026-10-30T10:0${n}:00Z`, action: 'store_account_linked', target_type: 'store_account',
  target_id: accountId, actor_email: 'owner@example.invalid', store_id: storeId, store_name: 'Store A', subject_email: 'staff@example.invalid',
  details: { store_id: storeId, user_id: adminId, previous_role: 'customer' }, ...extra
});

test('only a platform admin may read it: customers and store accounts get 403 and no database function runs', async () => {
  for (const role of ['customer', 'store_admin']) {
    const calls = fake(role, response([]));
    const out = await call({ method: 'GET', query: {} });
    assert.equal(out.status, 403, role);
    assert.equal(out.body.error, 'forbidden');
    assert.equal(calls.length, 0);
  }
  global.fetch = async () => { throw new Error('no request without a token'); };
  const res = recorder();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.out.status, 401);
});

test('it only reads: every other method is refused before any database call', async () => {
  const calls = fake('platform_admin', response([]));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await call({ method })).status, 405, method);
  assert.equal(calls.length, 0);
});

test('it answers with the newest entries, asks the function for one row more than the page, and is never cached', async () => {
  const calls = fake('platform_admin', response([row(3), row(2), row(1)]));
  const out = await call({ method: 'GET', query: { limit: '2', offset: '4' } });
  assert.equal(out.status, 200);
  assert.equal(out.headers['Cache-Control'], 'no-store');
  assert.deepEqual({ ...calls[0].args }, { p_limit: 3, p_offset: 4 });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer service-key');
  assert.equal(out.body.entries.length, 2);
  assert.equal(out.body.hasMore, true);
  assert.equal(out.body.limit, 2);
  assert.equal(out.body.offset, 4);
  assert.deepEqual({ ...out.body.entries[0] }, {
    id: row(3).id, createdAt: '2026-10-30T10:03:00Z', action: 'store_account_linked', targetType: 'store_account', targetId: accountId,
    actorEmail: 'owner@example.invalid', storeId, storeName: 'Store A', subjectEmail: 'staff@example.invalid', detail: { previousRole: 'customer' }
  });
});

test('the last page has no more, and the defaults are 50 from the start', async () => {
  const calls = fake('platform_admin', response([row(1)]));
  const out = await call({ method: 'GET', query: {} });
  assert.deepEqual({ ...calls[0].args }, { p_limit: 51, p_offset: 0 });
  assert.equal(out.body.hasMore, false);
  assert.equal(out.body.entries.length, 1);
  const empty = fake('platform_admin', response([]));
  const none = await call({ method: 'GET', query: {} });
  assert.deepEqual([...none.body.entries], []);
  assert.equal(none.body.hasMore, false);
  assert.equal(empty.length, 1);
});

test('a bad page is refused before the database is asked', async () => {
  const calls = fake('platform_admin', response([]));
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: 'abc' }, { offset: '-1' }, { offset: '1.5' }, { offset: '1000001' }]) {
    const out = await call({ method: 'GET', query });
    assert.equal(out.status, 400, JSON.stringify(query));
    assert.equal(out.body.error, 'invalid_page');
  }
  assert.equal(calls.length, 0);
});

test('only the listed detail keys leave the server; ids and unknown keys do not', async () => {
  fake('platform_admin', response([row(1, { details: { store_id: storeId, user_id: adminId, role_back_to_customer: true, previous_role: 'customer', secret: 'x', nested: { a: 1 }, count: 5 } })]));
  const out = await call({ method: 'GET', query: {} });
  assert.deepEqual({ ...out.body.entries[0].detail }, { previousRole: 'customer', roleBackToCustomer: true });
  assert.ok(!JSON.stringify(out.body).includes(adminId), 'the user id of the audited account is not in the answer');
  assert.ok(!JSON.stringify(out.body).includes('secret'));
});

test('missing names show as empty strings and a null target stays null', async () => {
  fake('platform_admin', response([row(1, { actor_email: null, store_id: null, store_name: null, subject_email: null, target_id: null, details: null })]));
  const entry = (await call({ method: 'GET', query: {} })).body.entries[0];
  assert.equal(entry.actorEmail, '');
  assert.equal(entry.storeName, '');
  assert.equal(entry.subjectEmail, '');
  assert.equal(entry.storeId, null);
  assert.equal(entry.targetId, null);
  assert.deepEqual({ ...entry.detail }, {});
});

test('a database failure is a 502 with a stable code, never the raw database text', async () => {
  fake('platform_admin', response({ message: 'permission denied for function platform_audit_entries', code: '42501' }, 400));
  let out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 502);
  assert.equal(out.body.error, 'audit_log_unavailable');
  assert.ok(!JSON.stringify(out.body).includes('permission'));
  fake('platform_admin', response({ unexpected: true }));
  out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 502, 'a non-list answer is a failure too');
  fake('platform_admin', () => { throw new TypeError('Failed to fetch'); });
  out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 502);
  assert.equal(out.body.error, 'audit_log_unavailable');
});

test('it is registered for the Worker and the migration files are the ledger version and its rollback', () => {
  const registry = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'api-registry.js'), 'utf8');
  assert.match(registry, /'platform-audit-log': \(\) => require\('\.\.\/api\/platform-audit-log\.js'\)/);
  const root = path.join(__dirname, '..', 'supabase');
  const name = '20261030063700_platform_audit_entries.sql';
  const crypto = require('node:crypto');
  assert.equal(crypto.createHash('md5').update(fs.readFileSync(path.join(root, 'migrations', name))).digest('hex'), '1dcd9859e872d907d8ae125e628f974f', 'the file is the statement in the live ledger');
  const up = fs.readFileSync(path.join(root, 'migrations', name), 'utf8');
  assert.match(up, /revoke all on function public\.platform_audit_entries\(integer, integer\) from public, anon, authenticated;/);
  assert.match(up, /grant execute on function public\.platform_audit_entries\(integer, integer\) to service_role;/);
  assert.doesNotMatch(up.replace(/^--.*$/gm, ''), /\b(insert|update|delete)\b/i, 'the function only reads');
  assert.match(fs.readFileSync(path.join(root, 'rollback', name), 'utf8'), /drop function if exists public\.platform_audit_entries\(integer, integer\);/);
  const sqlTest = fs.readFileSync(path.join(__dirname, 'platform-audit-entries.test.sql'), 'utf8');
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /^rollback;/m);
  assert.doesNotMatch(sqlTest, /^commit;/m);
  assert.match(sqlTest, /@example\.invalid/);
  assert.doesNotMatch(sqlTest, /@(gmail|hotmail|outlook|yahoo)\./i);
});
