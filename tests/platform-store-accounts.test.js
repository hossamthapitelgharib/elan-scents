const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-store-accounts'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const accountId = '0b7d8b0e-5b5e-4c3e-9d54-0c2a8f4f2b11';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

/* A fake Supabase: the role of the caller, and what each database function answers. */
function fake(role, rpc = {}) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return response({ id: adminId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: adminId, role }]);
    const match = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/);
    if (match) {
      calls.push({ name: match[1], args: JSON.parse(options.body || '{}'), headers: options.headers });
      const answer = rpc[match[1]];
      if (!answer) throw new Error(`unexpected rpc ${match[1]}`);
      return typeof answer === 'function' ? answer(JSON.parse(options.body || '{}')) : answer;
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  return calls;
}
async function call(req) { const res = recorder(); await handler({ headers: { authorization: 'Bearer token' }, ...req }, res); return res.out; }

test('only a platform admin may use it: customers and store accounts get 403 and no database function runs', async () => {
  for (const role of ['customer', 'store_admin']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const calls = fake(role);
      const out = await call({ method, body: { storeId, email: 'a@example.invalid', accountId } });
      assert.equal(out.status, 403, `${role} ${method}`);
      assert.equal(calls.length, 0);
    }
  }
  global.fetch = async () => { throw new Error('no request without a token'); };
  const res = recorder();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.out.status, 401);
});

test('other methods are refused', async () => {
  const calls = fake('platform_admin');
  assert.equal((await call({ method: 'PUT' })).status, 405);
  assert.equal((await call({ method: 'PATCH' })).status, 405);
  assert.equal(calls.length, 0);
});

test('GET lists the accounts with email and name, optionally for one store, through the database function only', async () => {
  const row = { account_id: accountId, store_id: storeId, store_name: 'Store A', user_id: 'u1', email: 'staff@example.invalid', full_name: 'Staff One', account_role: 'store_admin', profile_role: 'store_admin', created_at: '2026-10-28T10:00:00Z' };
  const calls = fake('platform_admin', { platform_store_accounts: response([row]) });
  let out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.accounts, [{ accountId, storeId, storeName: 'Store A', email: 'staff@example.invalid', fullName: 'Staff One', accountRole: 'store_admin', profileRole: 'store_admin', createdAt: '2026-10-28T10:00:00Z' }]);
  assert.equal(calls[0].args.p_store_id, null);
  assert.ok(!('user_id' in out.body.accounts[0]) && !('userId' in out.body.accounts[0]), 'the raw user id is not sent to the page');
  out = await call({ method: 'GET', query: { storeId } });
  assert.equal(calls[1].args.p_store_id, storeId);
  out = await call({ method: 'GET', query: { storeId: 'not-a-uuid' } });
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'invalid_store_id');
  assert.equal(calls.length, 2, 'a bad id never reaches the database');
});

test('GET reports an unreachable database as 502', async () => {
  fake('platform_admin', { platform_store_accounts: response({ message: 'boom' }, 500) });
  const out = await call({ method: 'GET', query: {} });
  assert.equal(out.status, 502);
  assert.equal(out.body.error, 'store_accounts_unavailable');
});

test('POST links an account: the email is trimmed, the admin is the actor, new is 201 and repeated is 200', async () => {
  let answer = { account_id: accountId, store_id: storeId, user_id: 'u1', already_linked: false };
  const calls = fake('platform_admin', { platform_link_store_account: () => response(answer) });
  let out = await call({ method: 'POST', body: { storeId, email: '  Staff@Example.invalid ' } });
  assert.equal(out.status, 201);
  assert.deepEqual(out.body, { ok: true, accountId, storeId, alreadyLinked: false });
  assert.deepEqual(calls[0].args, { p_store_id: storeId, p_email: 'Staff@Example.invalid', p_actor: adminId });
  assert.equal(calls[0].headers.Authorization, 'Bearer service-key');
  answer = { ...answer, already_linked: true };
  out = await call({ method: 'POST', body: { storeId, email: 'staff@example.invalid' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.alreadyLinked, true);
});

test('POST checks its input before calling the database', async () => {
  const calls = fake('platform_admin', { platform_link_store_account: response({}) });
  for (const [body, error] of [
    [{ email: 'a@example.invalid' }, 'invalid_store_id'],
    [{ storeId: 'nope', email: 'a@example.invalid' }, 'invalid_store_id'],
    [{ storeId, email: '' }, 'invalid_email'],
    [{ storeId, email: '   ' }, 'invalid_email'],
    [{ storeId, email: 'x'.repeat(321) }, 'invalid_email'],
    [{ storeId, email: ['a@example.invalid'] }, 'invalid_email'],
    [null, 'invalid_store_id']
  ]) {
    const out = await call({ method: 'POST', body });
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.equal(out.body.error, error);
  }
  assert.equal(calls.length, 0);
});

test('POST turns each refusal of the database function into a stable code', async () => {
  const cases = [
    ['Invalid email', 400, 'invalid_email'],
    ['Store not found', 404, 'store_not_found'],
    ['User not found', 404, 'user_not_found'],
    ['Email not confirmed', 409, 'email_not_confirmed'],
    ['Platform admin cannot be a store account', 409, 'platform_admin_not_linkable'],
    ['Customer has order history', 409, 'customer_has_order_history']
  ];
  for (const [message, status, error] of cases) {
    fake('platform_admin', { platform_link_store_account: response({ code: 'P0001', message }, 400) });
    const out = await call({ method: 'POST', body: { storeId, email: 'a@example.invalid' } });
    assert.equal(out.status, status, message);
    assert.equal(out.body.error, error);
  }
  fake('platform_admin', { platform_link_store_account: response({ code: 'XX000', message: 'something internal with details' }, 500) });
  const out = await call({ method: 'POST', body: { storeId, email: 'a@example.invalid' } });
  assert.equal(out.status, 502);
  assert.equal(out.body.error, 'store_account_link_failed');
  assert.ok(!JSON.stringify(out.body).includes('internal'), 'database text is not echoed to the page');
});

test('DELETE removes the link by account id from the body or the query', async () => {
  const calls = fake('platform_admin', { platform_unlink_store_account: response({ account_id: accountId, store_id: storeId, user_id: 'u1', role_back_to_customer: true }) });
  let out = await call({ method: 'DELETE', body: { accountId } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, accountId, roleBackToCustomer: true });
  assert.deepEqual(calls[0].args, { p_account_id: accountId, p_actor: adminId });
  out = await call({ method: 'DELETE', query: { accountId } });
  assert.equal(out.status, 200);
  out = await call({ method: 'DELETE', body: { accountId: 'nope' } });
  assert.equal(out.status, 400);
  assert.equal(out.body.error, 'invalid_account_id');
  assert.equal(calls.length, 2);
});

test('DELETE reports an unknown account as 404 and any other failure as 502', async () => {
  fake('platform_admin', { platform_unlink_store_account: response({ code: 'P0001', message: 'Account not found' }, 400) });
  let out = await call({ method: 'DELETE', body: { accountId } });
  assert.equal(out.status, 404);
  assert.equal(out.body.error, 'account_not_found');
  fake('platform_admin', { platform_unlink_store_account: response({ message: 'db down' }, 500) });
  out = await call({ method: 'DELETE', body: { accountId } });
  assert.equal(out.status, 502);
  assert.equal(out.body.error, 'store_account_unlink_failed');
});

test('the temporary owner key has no user id, so the audit row gets no actor instead of a bad value', async () => {
  const calls = fake('platform_admin', { platform_link_store_account: response({ account_id: accountId, store_id: storeId, already_linked: false }) });
  const res = recorder();
  await handler({ method: 'POST', headers: {}, __editorKeyAdmin: true, body: { storeId, email: 'a@example.invalid' } }, res);
  assert.equal(res.out.status, 201);
  assert.equal(calls[0].args.p_actor, null);
});
