const { loadCoreSource } = require('./load-core');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'guest-cart'));
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() {}, json(body) { out.body = body; return this; } }; }
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const visitorKey = '8ac7c4ab-02f0-4c2c-9cde-b29151ee7712';
const productId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';

test('guest cart API rejects invalid methods and non-random browser keys', async () => {
  const a = recorder(); await handler({ method: 'GET', headers: {} }, a); assert.equal(a.out.status, 405);
  const b = recorder(); await handler({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey: 'screen-1440x900' } }, b); assert.equal(b.out.status, 400);
  assert.equal(b.out.body.error, 'invalid_browser_key');
});

test('resolve stores only server HMACs and returns this browser basket', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return response({ visitorId: productId, status: 'guest', cart: [{ sid: productId, storeProductId: productId, q: 2, productSnapshot: { name: 'private snapshot' } }] });
  };
  const res = recorder();
  await handler({ method: 'POST', headers: {}, body: { action: 'resolve', visitorKey } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.visitorId, productId); assert.equal(res.out.body.cart[0].q, 2);
  assert.equal(Object.hasOwn(res.out.body.cart[0], 'productSnapshot'), false);
  assert.match(calls[0].url, /rpc\/resolve_guest_browser$/);
  const payload = JSON.parse(calls[0].options.body);
  assert.match(payload.p_fingerprint_hash, /^[a-f0-9]{64}$/); assert.match(payload.p_analytics_hash, /^[a-f0-9]{64}$/);
});

test('claim transfers both server HMACs with the authenticated customer ID', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return response({ id: 'a6d53c31-c9d7-428a-82f4-c742bf923690' });
    return response({ claimed: true, cart: 2, items: 1 });
  };
  const res = recorder();
  await handler({ method: 'POST', headers: { authorization: 'Bearer unit-test-token' }, body: { action: 'claim', visitorKey } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.claimed, true);
  assert.match(calls[1].url, /rpc\/claim_guest_browser_cart$/);
  const payload = JSON.parse(calls[1].options.body);
  assert.match(payload.p_fingerprint_hash, /^[a-f0-9]{64}$/);
  assert.match(payload.p_analytics_hash, /^[a-f0-9]{64}$/);
  assert.equal(payload.p_user_id, 'a6d53c31-c9d7-428a-82f4-c742bf923690');
});

test('legacy guest activity route accepts cart removal and writes to the unified detailed ledger', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const calls = [];
  global.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return response(true); };
  const res = recorder();
  await handler({ method: 'POST', headers: {}, body: { action: 'track', visitorKey, eventType: 'cart_remove', productId } }, res);
  assert.equal(res.out.status, 200); assert.equal(res.out.body.tracked, true);
  assert.match(calls[0].url, /rpc\/record_guest_product_activity$/);
  assert.equal(JSON.parse(calls[0].options.body).p_event_type, 'cart_remove');
});

test('guest capture is automatic, browser-local, and its migration keeps only isolated analytics after claim', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const identity = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');
  const core = loadCoreSource();
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261010014327_guest_browser_identity_analytics.sql'), 'utf8');
  assert.match(html, /guest-identity\.js\?v=[0-9A-Za-z-]+/);
  assert.match(identity, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(identity, /randomUUID/);
  assert.match(identity, /setTimeout\(function \(\) \{ startSession\(\)/);
  // Owner decision (2026-10-15): coarse device signals are collected for counting people only. The raw
  // user-agent string is still never read in the browser, and nothing here may move a basket.
  assert.doesNotMatch(identity, /navigator\.userAgent(?!Data)|screenWidth/);
  assert.doesNotMatch(identity, /request\('(?:save|claim)'[^;]*parts/);
  assert.match(identity, /track: track/);
  assert.match(core, /GuestIdentity\.claim/);
  assert.match(core, /trackGuestProduct\('cart_add'/);
  assert.match(core, /trackGuestProduct\('view'/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /guest_analytics_visits/);
  assert.match(migration, /guest_product_analytics/);
  assert.match(migration, /delete from public\.guest_visitors/i);
  assert.match(migration, /guest_analytics_summary/);
});

test('the vendor folder for the ThumbmarkJS build exists and CLAUDE.md tells Manus how to fill it', () => {
  const root = path.join(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, 'vendor')));
  assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /vendor\/thumbmark\.js/);
  assert.match(fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8'), /\/vendor\/thumbmark\.js/);
});

function cookieRes() {
  const headers = {};
  return { headers, out: {}, status(n) { this.out.status = n; return this; }, setHeader(k, v) { headers[k] = v; }, json(body) { this.out.body = body; return this; } };
}
const otherKey = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
function useDatabase(handlerFn) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-server-secret';
  const calls = [];
  global.fetch = async (url, options = {}) => { calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null }); return handlerFn(String(url)); };
  return calls;
}

test('forget (the visitor refused tracking) erases the browser through forget_guest_browser with the same hashes resolve uses, then expires the cookie', async () => {
  const calls = useDatabase(() => response({ visitorId: productId, status: 'guest', cart: [], forgotten: true }));
  await handler({ method: 'POST', headers: { 'x-forwarded-proto': 'https' }, body: { action: 'resolve', visitorKey } }, cookieRes());
  const resolved = calls[0].body;
  calls.length = 0;
  const res = cookieRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-proto': 'https' }, body: { action: 'forget', visitorKey } }, res);
  assert.equal(res.out.status, 200);
  assert.deepEqual(res.out.body, { ok: true, forgotten: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /rpc\/forget_guest_browser$/);
  assert.equal(calls[0].body.p_fingerprint_hash, resolved.p_fingerprint_hash, 'the same fingerprint hash the visitor row was stored under');
  assert.equal(calls[0].body.p_analytics_hash, resolved.p_analytics_hash, 'the same analytics hash the counters were stored under');
  assert.equal(res.headers['Set-Cookie'], 'elan_gid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure');
  assert.ok(!JSON.stringify(calls[0].body).includes(visitorKey), 'the raw browser key is never stored or sent on');
});

test('forget erases both the key the page sends and the key in the HttpOnly cookie when they differ', async () => {
  const calls = useDatabase(() => response({ forgotten: true }));
  const res = cookieRes();
  await handler({ method: 'POST', headers: { cookie: 'elan_gid=' + otherKey }, body: { action: 'forget', visitorKey } }, res);
  assert.equal(res.out.status, 200);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body.p_fingerprint_hash, calls[1].body.p_fingerprint_hash);
  // the cookie alone is enough (the page lost its storage)
  calls.length = 0;
  const alone = cookieRes();
  await handler({ method: 'POST', headers: { cookie: 'elan_gid=' + otherKey }, body: { action: 'forget' } }, alone);
  assert.equal(alone.out.status, 200); assert.equal(calls.length, 1);
});

test('forget with no key at all has nothing to erase: no database call, the cookie is still expired', async () => {
  const calls = useDatabase(() => response({}));
  const res = cookieRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'forget' } }, res);
  assert.equal(res.out.status, 200);
  assert.deepEqual(res.out.body, { ok: true, forgotten: false });
  assert.equal(calls.length, 0);
  assert.match(res.headers['Set-Cookie'], /^elan_gid=; Max-Age=0;/);
  // a value that is not a browser key is ignored like no key
  const junk = cookieRes();
  await handler({ method: 'POST', headers: { cookie: 'elan_gid=not-a-key' }, body: { action: 'forget', visitorKey: 'screen-1440x900' } }, junk);
  assert.equal(junk.out.body.forgotten, false); assert.equal(calls.length, 0);
});

test('a failed erase answers 502 and leaves the cookie alone, so the browser can retry', async () => {
  useDatabase(() => response({ message: 'down' }, 500));
  const failed = cookieRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'forget', visitorKey } }, failed);
  assert.equal(failed.out.status, 502);
  assert.equal(failed.headers['Set-Cookie'], undefined);
  global.fetch = async () => { throw new Error('network'); };
  const thrown = cookieRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'forget', visitorKey } }, thrown);
  assert.equal(thrown.out.status, 502);
  assert.equal(thrown.headers['Set-Cookie'], undefined);
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const unavailable = cookieRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'forget', visitorKey } }, unavailable);
  assert.equal(unavailable.out.status, 503);
  if (saved.url) process.env.SUPABASE_URL = saved.url; if (saved.key) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
});

test('forget refuses a cross-site request and is rate-limited per address', async () => {
  const calls = useDatabase(() => response({ forgotten: true }));
  const blocked = cookieRes();
  await handler({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { action: 'forget', visitorKey } }, blocked);
  assert.equal(blocked.out.status, 403);
  assert.equal(blocked.headers['Set-Cookie'], undefined);
  assert.equal(calls.length, 0);
  let last;
  for (let i = 0; i < 35; i++) { last = cookieRes(); await handler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.77' }, body: { action: 'forget', visitorKey } }, last); }
  assert.equal(last.out.status, 429, 'more than 30 erase requests a minute from one address are refused');
});

test('the erase function is called with service role only, and the migration and rollback exist for it', () => {
  const root = path.join(__dirname, '..');
  const migration = fs.readdirSync(path.join(root, 'supabase', 'migrations')).find((f) => /_forget_guest_browser\.sql$/.test(f));
  assert.ok(migration, 'migration file for forget_guest_browser');
  const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', migration), 'utf8');
  assert.match(sql, /revoke all on function public\.forget_guest_browser\(text, text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.forget_guest_browser\(text, text\) to service_role/);
  assert.match(sql, /status = 'guest'/, 'only guest rows; a converted visitor row belongs to a registered customer');
  assert.doesNotMatch(sql, /delete from public\.guest_conversions|delete from public\.profiles|user_id\s*=/i, 'no registered-customer data is deleted');
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', migration)), 'rollback file');
  assert.ok(fs.existsSync(path.join(root, 'tests', 'guest-forget.test.sql')), 'database test is in the repository');
});

test('every table that holds a visitor\'s own rows is covered by the erase function, so a new one cannot be forgotten', () => {
  const root = path.join(__dirname, '..');
  const snapshot = fs.readdirSync(path.join(root, 'supabase', 'schema-snapshot')).filter((f) => /^tables-\d+\.txt$/.test(f))
    .map((f) => fs.readFileSync(path.join(root, 'supabase', 'schema-snapshot', f), 'utf8')).join('\n');
  const VISITOR_COLUMNS = /^\s{2}(guest_id|visitor_hash|analytics_hash|hash_a|fingerprint_hash)\s/m;
  const found = [];
  for (const block of snapshot.split(/\n(?=TABLE )/)) {
    const m = /^TABLE (\w+)/.exec(block);
    if (m && VISITOR_COLUMNS.test(block)) found.push(m[1]);
  }
  assert.ok(found.length >= 8, 'found the visitor tables: ' + found.join(', '));
  // guest_conversions links a visitor to a registered customer (user_id): it belongs to the customer and is kept on purpose
  const KEPT_ON_PURPOSE = new Set(['guest_conversions']);
  const migration = fs.readdirSync(path.join(root, 'supabase', 'migrations')).find((f) => /_forget_guest_browser\.sql$/.test(f));
  const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', migration), 'utf8');
  for (const table of found.filter((t) => !KEPT_ON_PURPOSE.has(t))) {
    assert.ok(new RegExp('delete from public\\.' + table + '\\b').test(sql), table + ' is erased by forget_guest_browser');
  }
});
