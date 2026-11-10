// /api/signup-carry (api/signup-carry.js): the cart and hearts of the browser that registered reach the account even when the confirmation link
// opens in another browser. `stash` has no token and must tell a caller nothing about any id; `claim` works only with the account's own token.
// The server and the database are faked; every id and address is synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'STATE_STORE_REQUIRED'];
const savedEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const originalFetch = global.fetch;
for (const key of KEYS) delete process.env[key];
process.env.SUPABASE_URL = 'https://carry-test.example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
const handler = require('../api/signup-carry');

const NEW_USER = 'e0000000-0000-4000-8000-0000000000a1';
const OTHER_USER = 'e0000000-0000-4000-8000-0000000000a2';
const SP1 = 'e0000000-0000-4000-8000-0000000000b1';
const SZ1 = 'e0000000-0000-4000-8000-0000000000c1';
const SZ2 = 'e0000000-0000-4000-8000-0000000000c2';
let ipCounter = 0;

/* world: { rpc: (name, args) => ({ ok, data }), role } */
async function call(body, { method = 'POST', token, headers = {}, ip, world = {} } = {}) {
  const log = { fetches: [], rpc: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const json = (value, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => value });
    log.fetches.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return token ? json({ id: NEW_USER, email: 'buyer@example.invalid', email_confirmed_at: '2026-11-09T00:00:00Z' }) : json({}, false);
    if (url.includes('/rest/v1/profiles')) return json([{ id: NEW_USER, role: world.role || 'customer' }]);
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url);
    if (rpc) {
      const args = JSON.parse(options.body);
      log.rpc.push({ name: rpc[1], args, headers: options.headers });
      const answer = world.rpc ? world.rpc(rpc[1], args) : { ok: true, data: true };
      return json(answer.data, answer.ok);
    }
    throw new Error('unexpected request ' + url);
  };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  const req = { method, headers: Object.assign({ 'x-real-ip': ip || `198.51.100.${++ipCounter % 250}` }, token ? { authorization: 'Bearer ' + token } : {}, headers), body };
  await handler(req, res);
  return { res, log };
}

test.after(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const stashBody = (extra = {}) => ({ action: 'stash', userId: NEW_USER, cart: [{ sid: SZ1, storeProductId: SP1, q: 2 }], favs: [SZ1], ...extra });

test('stash: the server receives the cleaned lists with the service key, and nothing else the caller added', async () => {
  const { res, log } = await call(stashBody({
    cart: [{ sid: SZ1, storeProductId: SP1, q: 2, role: 'platform_admin', price: 1 }, null, 'text', [1], { sid: SZ2, storeProductId: SP1, quantity: 3 }],
    favs: [SZ1, SZ2, 'junk', 5, null, { id: SZ1 }],
    email: 'someone@example.invalid', role: 'platform_admin'
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(log.rpc.length, 1);
  assert.equal(log.rpc[0].name, 'stash_signup_carry');
  assert.deepEqual(log.rpc[0].args, {
    p_user_id: NEW_USER,
    p_cart: [{ sid: SZ1, storeProductId: SP1, q: 2 }, { sid: SZ2, storeProductId: SP1, q: 3 }],
    p_favs: [SZ1, SZ2]
  });
  assert.equal(log.rpc[0].headers.apikey, 'unit-test-server-secret');
  assert.equal(log.rpc[0].headers.Authorization, 'Bearer unit-test-server-secret');
  assert.equal(log.fetches.some((f) => f.url.endsWith('/auth/v1/user')), false, 'there is no token to check before the account is confirmed');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('stash: the answer is the same whatever the database decided, so an id cannot be probed', async () => {
  const accepted = await call(stashBody(), { world: { rpc: () => ({ ok: true, data: true }) } });
  const refused = await call(stashBody(), { world: { rpc: () => ({ ok: true, data: false }) } });
  assert.equal(accepted.res.statusCode, 200);
  assert.deepEqual(refused.res.body, accepted.res.body);
  assert.equal(refused.res.statusCode, accepted.res.statusCode);
});

test('stash: a bad id, no lists, or a request that is not a plain same-site POST never reach the database', async () => {
  const cases = [
    [stashBody({ userId: 'not-a-uuid' }), 400],
    [stashBody({ userId: undefined }), 400],
    [stashBody({ userId: { id: NEW_USER } }), 400],
    [{ action: 'unknown', userId: NEW_USER }, 400],
    [{ userId: NEW_USER, cart: [{ sid: SZ1, storeProductId: SP1, q: 1 }] }, 400, 'no action'],
    [stashBody({ cart: [], favs: [] }), 200],
    [stashBody({ cart: 'x', favs: { a: 1 } }), 200]
  ];
  for (const [body, status] of cases) {
    const { res, log } = await call(body);
    assert.equal(res.statusCode, status, JSON.stringify(body));
    assert.equal(log.rpc.length, 0, 'no database call for ' + JSON.stringify(body));
  }
  const get = await call(stashBody(), { method: 'GET' });
  assert.equal(get.res.statusCode, 405);
  const cross = await call(stashBody(), { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.res.statusCode, 403);
  assert.equal(cross.log.rpc.length, 0);
  const same = await call(stashBody(), { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(same.res.statusCode, 200);
  assert.equal(same.log.rpc.length, 1);
  const big = await call(stashBody({ cart: Array.from({ length: 100 }, () => ({ sid: SZ1, storeProductId: SP1, q: 1, pad: 'x'.repeat(300) })) }));
  assert.equal(big.res.statusCode, 413);
  assert.equal(big.log.rpc.length, 0);
});

test('stash: at most 100 cart lines and 200 hearts are forwarded', async () => {
  const cart = Array.from({ length: 120 }, (_, i) => ({ sid: SZ1, storeProductId: SP1, q: (i % 9) + 1 }));
  const favs = Array.from({ length: 205 }, () => SZ2);
  const { res, log } = await call(stashBody({ cart, favs }));
  assert.equal(res.statusCode, 200);
  assert.equal(log.rpc[0].args.p_cart.length, 100);
  assert.equal(log.rpc[0].args.p_favs.length, 200);
});

test('stash: one address may try only ten times a minute', async () => {
  const ip = '203.0.113.77';
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await call(stashBody(), { ip })).res.statusCode);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429, 429]);
  const other = await call(stashBody(), { ip: '203.0.113.78' });
  assert.equal(other.res.statusCode, 200, 'another address is not affected');
});

test('stash: a database failure or a missing server key is an error, never a pretend success', async () => {
  const failed = await call(stashBody(), { world: { rpc: () => ({ ok: false, data: { message: 'boom' } }) } });
  assert.equal(failed.res.statusCode, 502);
  assert.deepEqual(failed.res.body, { ok: false, error: 'signup_carry_failed' });
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const down = await call(stashBody());
    assert.equal(down.res.statusCode, 503);
    assert.equal(down.log.rpc.length, 0);
  } finally { process.env.SUPABASE_SERVICE_ROLE_KEY = key; }
});

test('claim: only with the account\'s own token, for that account only, and the answer is counts, not the lists', async () => {
  const noToken = await call({ action: 'claim' });
  assert.equal(noToken.res.statusCode, 401);
  assert.equal(noToken.log.rpc.length, 0);
  const { res, log } = await call({ action: 'claim', userId: OTHER_USER, p_user_id: OTHER_USER }, {
    token: 'user-token',
    world: { rpc: () => ({ ok: true, data: { claimed: true, cart: 2, favs: 1, secret: 'x' } }) }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, claimed: true, cart: 2, favs: 1 });
  assert.equal(log.rpc.length, 1);
  assert.equal(log.rpc[0].name, 'claim_signup_carry');
  assert.deepEqual(log.rpc[0].args, { p_user_id: NEW_USER }, 'the account is the token\'s, whatever id the body names');
  assert.equal(log.rpc[0].headers.Authorization, 'Bearer unit-test-server-secret');
});

test('claim: nothing waiting, a database failure and the rate limit', async () => {
  const none = await call({ action: 'claim' }, { token: 'user-token', world: { rpc: () => ({ ok: true, data: { claimed: false, cart: 0, favs: 0 } }) } });
  assert.deepEqual(none.res.body, { ok: true, claimed: false, cart: 0, favs: 0 });
  const odd = await call({ action: 'claim' }, { token: 'user-token', world: { rpc: () => ({ ok: true, data: null }) } });
  assert.deepEqual(odd.res.body, { ok: true, claimed: false, cart: 0, favs: 0 });
  const failed = await call({ action: 'claim' }, { token: 'user-token', world: { rpc: () => ({ ok: false, data: {} }) } });
  assert.equal(failed.res.statusCode, 502);
  assert.deepEqual(failed.res.body, { ok: false, error: 'signup_carry_failed' });
  const ip = '203.0.113.90';
  let last;
  for (let i = 0; i < 31; i++) last = await call({ action: 'claim' }, { token: 'user-token', ip });
  assert.equal(last.res.statusCode, 429);
});

test('the handler is registered for the Worker and the two database functions are server-only', () => {
  const registry = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'api-registry.js'), 'utf8');
  assert.match(registry, /'signup-carry': \(\) => require\('\.\.\/api\/signup-carry\.js'\)/);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261109072338_signup_carry.sql'), 'utf8');
  assert.match(migration, /revoke all on function public\.stash_signup_carry\(uuid, jsonb, jsonb\) from public, anon, authenticated/i);
  assert.match(migration, /revoke all on function public\.claim_signup_carry\(uuid\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.stash_signup_carry\(uuid, jsonb, jsonb\) to service_role/i);
  assert.match(migration, /grant execute on function public\.claim_signup_carry\(uuid\) to service_role/i);
});
