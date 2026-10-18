const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'auth-session.js'), 'utf8');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role, exp) => 'h.' + b64({ role, exp }) + '.s';
const inSeconds = (s) => Math.floor(Date.now() / 1000) + s;
const ANON = jwt('anon', inSeconds(99999));

/* Loads auth-session.js in a browser-like sandbox. `server(url, init)` plays Supabase and the site API. */
function load(session, server) {
  const store = new Map(session ? [['elan_auth_session', JSON.stringify(session)]] : []);
  const events = [];
  const handlers = {};
  const calls = [];
  const sandbox = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    navigator: {}, document: { visibilityState: 'visible', addEventListener() {} },
    Headers, CustomEvent, Promise, setTimeout, setInterval() {}, atob, escape, decodeURIComponent, JSON, Object, Array, String, Number, Date, Math,
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    dispatchEvent(e) { events.push(e.type); (handlers[e.type] || []).forEach((fn) => fn(e)); return true; },
    fetch: async (url, init) => { calls.push({ url: String(url), init }); const r = await server(String(url), init || {}); return { ok: r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) }; }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  return { window: sandbox, store, events, calls, stored: () => JSON.parse(store.get('elan_auth_session') || 'null') };
}
const CONFIG = { status: 200, body: { url: 'https://sb.example.test', key: ANON } };
const bearer = (init) => String((init.headers || {}).Authorization || '').replace(/^Bearer /, '');

test('a request made with an expired token is sent with a refreshed one', async () => {
  const old = { access_token: jwt('authenticated', inSeconds(-30)), refresh_token: 'r1', user: { id: 'u1' } };
  const fresh = jwt('authenticated', inSeconds(3600));
  const t = load(old, (url, init) => {
    if (url === '/api/config') return CONFIG;
    if (url.includes('grant_type=refresh_token')) return { status: 200, body: { access_token: fresh, refresh_token: 'r2', expires_in: 3600 } };
    return { status: bearer(init) === fresh ? 200 : 401, body: {} };
  });
  const r = await t.window.fetch('/api/customer-orders', { headers: { Authorization: 'Bearer ' + old.access_token } });
  assert.equal(r.status, 200);
  assert.equal(t.stored().access_token, fresh, 'the new session is stored');
  assert.equal(t.stored().refresh_token, 'r2');
  assert.deepEqual(t.stored().user, { id: 'u1' }, 'fields that the refresh response does not repeat are kept');
  assert.ok(t.events.includes('elan-auth-refreshed'));
});

test('a 401 on a token that looked valid triggers one refresh and one retry', async () => {
  const old = { access_token: jwt('authenticated', inSeconds(3000)), refresh_token: 'r1' };
  const fresh = jwt('authenticated', inSeconds(3600));
  const t = load(old, (url, init) => {
    if (url === '/api/config') return CONFIG;
    if (url.includes('grant_type=refresh_token')) return { status: 200, body: { access_token: fresh, refresh_token: 'r2' } };
    return { status: bearer(init) === fresh ? 200 : 401, body: {} };
  });
  const r = await t.window.fetch('https://sb.example.test/rest/v1/cart_items', { headers: { Authorization: 'Bearer ' + old.access_token, apikey: ANON } });
  assert.equal(r.status, 200);
  assert.equal(t.calls.filter((c) => c.url.includes('grant_type=refresh_token')).length, 1);
  assert.equal(t.calls.filter((c) => c.url.includes('/rest/v1/cart_items')).length, 2);
});

test('requests with the anonymous key or no token are never touched', async () => {
  const t = load({ access_token: jwt('authenticated', inSeconds(-30)), refresh_token: 'r1' }, () => ({ status: 200, body: {} }));
  await t.window.fetch('https://sb.example.test/rest/v1/public_products', { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } });
  await t.window.fetch('/api/config');
  assert.equal(t.calls.filter((c) => c.url.includes('grant_type')).length, 0);
});

test('parallel requests share a single refresh', async () => {
  const old = { access_token: jwt('authenticated', inSeconds(-5)), refresh_token: 'r1' };
  const fresh = jwt('authenticated', inSeconds(3600));
  const t = load(old, (url) => url === '/api/config' ? CONFIG : url.includes('grant_type=refresh_token') ? { status: 200, body: { access_token: fresh, refresh_token: 'r2' } } : { status: 200, body: {} });
  const headers = { Authorization: 'Bearer ' + old.access_token };
  await Promise.all([t.window.fetch('/api/a', { headers }), t.window.fetch('/api/b', { headers }), t.window.fetch('/api/c', { headers })]);
  assert.equal(t.calls.filter((c) => c.url.includes('grant_type=refresh_token')).length, 1);
});

test('when Supabase refuses the refresh token the session ends and the page is told', async () => {
  const old = { access_token: jwt('authenticated', inSeconds(-5)), refresh_token: 'dead' };
  const t = load(old, (url) => url === '/api/config' ? CONFIG : url.includes('grant_type=refresh_token') ? { status: 400, body: { error: 'invalid_grant' } } : { status: 401, body: {} });
  const r = await t.window.fetch('/api/customer-orders', { headers: { Authorization: 'Bearer ' + old.access_token } });
  assert.equal(r.status, 401);
  assert.equal(t.stored(), null, 'the dead session is removed');
  assert.ok(t.events.includes('elan-auth-expired'));
});

test('if another tab already rotated the token, this tab adopts its session instead of ending', async () => {
  const old = { access_token: jwt('authenticated', inSeconds(-5)), refresh_token: 'r1' };
  const theirs = { access_token: jwt('authenticated', inSeconds(3600)), refresh_token: 'r2' };
  let t;
  t = load(old, (url, init) => {
    if (url === '/api/config') return CONFIG;
    if (url.includes('grant_type=refresh_token')) { t.store.set('elan_auth_session', JSON.stringify(theirs)); return { status: 400, body: { error: 'refresh_token_already_used' } }; }
    return { status: bearer(init) === theirs.access_token ? 200 : 401, body: {} };
  });
  const r = await t.window.fetch('/api/customer-orders', { headers: { Authorization: 'Bearer ' + old.access_token } });
  assert.equal(r.status, 200);
  assert.equal(t.stored().refresh_token, 'r2');
  assert.ok(!t.events.includes('elan-auth-expired'));
});

test('an offline refresh keeps the session', async () => {
  const old = { access_token: jwt('authenticated', inSeconds(30)), refresh_token: 'r1' };
  const t = load(old, (url) => { if (url === '/api/config') return CONFIG; if (url.includes('grant_type')) throw new Error('offline'); return { status: 200, body: {} }; });
  const r = await t.window.fetch('/api/customer-orders', { headers: { Authorization: 'Bearer ' + old.access_token } });
  assert.equal(r.status, 200);
  assert.ok(t.stored(), 'the session is still stored');
});

test('signOut revokes the session on the server and clears it locally', async () => {
  const session = { access_token: jwt('authenticated', inSeconds(3000)), refresh_token: 'r1' };
  const t = load(session, (url) => url === '/api/config' ? CONFIG : { status: 204, body: {} });
  await t.window.ElanAuth.signOut();
  assert.equal(t.stored(), null);
  const out = t.calls.find((c) => c.url.includes('/auth/v1/logout?scope=local'));
  assert.ok(out, 'the server is told to revoke this session');
  assert.equal(bearer(out.init), session.access_token);
});
