const test = require('node:test');
const assert = require('node:assert/strict');
const sessions = require('../railway/editor-session.js');

const SB = 'https://sb.example.test';
const MIN = 60 * 1000, HOUR = 60 * MIN, REUSE_WINDOW = 10 * 1000; // Supabase's default refresh-token reuse interval is 10 seconds
let now;
let seq = 0; // tokens are unique across the whole file, like real ones
const advance = (ms) => { now += ms; };

/* A fake Supabase that rotates refresh tokens the way the real one does: a refresh token can be used once,
   and again only inside the reuse window; later it is rejected. */
function fakeSupabase() {
  const real = global.fetch;
  const stats = { password: 0, refresh: 0, network: false, deny: false };
  const firstUse = new Map();
  const child = new Map();
  const pair = () => { seq += 1; return { access_token: 'T' + seq, refresh_token: 'R' + seq, expires_in: 3600 }; };
  global.fetch = async (url, opts) => {
    url = String(url);
    if (url.startsWith('http://127.0.0.1')) return real(url, opts);
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json, text: async () => '' });
    if (url.startsWith(SB + '/auth/v1/token?grant_type=password')) { stats.password += 1; return reply(200, pair()); }
    if (url.startsWith(SB + '/auth/v1/token?grant_type=refresh_token')) {
      stats.refresh += 1;
      if (stats.network) throw new Error('offline');
      if (stats.deny) return reply(400, { error: 'invalid_grant' });
      const old = JSON.parse(opts.body).refresh_token;
      if (!firstUse.has(old)) { firstUse.set(old, now); child.set(old, pair()); return reply(200, child.get(old)); }
      if (now - firstUse.get(old) <= REUSE_WINDOW) return reply(200, child.get(old));
      return reply(400, { error: 'refresh_token_already_used' });
    }
    if (url.startsWith(SB + '/auth/v1/user')) return reply(200, { id: 'u1', email: 'owner@example.test' });
    if (url.startsWith(SB + '/rest/v1/profiles')) return reply(200, [{ id: 'u1', role: 'platform_admin' }]);
    return reply(500, {});
  };
  return { stats, restore: () => { global.fetch = real; } };
}

let ipCounter = 0;
async function start() {
  process.env.SUPABASE_URL = SB; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.EDITOR_SESSION_SECRET = 'a-test-secret-that-is-long-enough';
  now = 1800000000000;
  sessions.__setClock(() => now);
  const fake = fakeSupabase();
  const login = await sessions.login('owner@example.test', 'right', 'ip-' + (++ipCounter));
  assert.equal(login.status, 200);
  return { fake, cookie: login.id, done() { fake.restore(); sessions.__setClock(null); } };
}

test('a stale cookie keeps working after the token was refreshed (refresh-token rotation)', async () => {
  const t = await start();
  try {
    advance(HOUR - 30 * 1000);                       // the access token is about to expire
    const first = await sessions.get(t.cookie);
    assert.ok(first, 'the session survives the refresh');
    assert.ok(first.renewed, 'a renewed cookie is handed back so the browser stores the rotated refresh token');
    advance(20 * 1000);                              // beyond the reuse window; a second tab or an in-flight request still sends the old cookie
    const stale = await sessions.get(t.cookie);
    assert.ok(stale, 'the old cookie must not log the admin out');
    assert.equal(stale.token, first.token);
    const renewed = await sessions.get(first.renewed);
    assert.ok(renewed);
    assert.equal(renewed.token, first.token);
    assert.equal(t.fake.stats.refresh, 1, 'one refresh serves every request that carries the old refresh token');
  } finally { t.done(); }
});

test('concurrent requests share a single refresh', async () => {
  const t = await start();
  try {
    advance(HOUR - 30 * 1000);
    const all = await Promise.all([sessions.get(t.cookie), sessions.get(t.cookie), sessions.get(t.cookie)]);
    assert.ok(all.every(Boolean));
    assert.equal(new Set(all.map((s) => s.token)).size, 1);
    assert.equal(t.fake.stats.refresh, 1);
  } finally { t.done(); }
});

test('activity slides the idle timeout; idleness and the absolute limit end the session', async () => {
  const t = await start();
  try {
    let cookie = t.cookie;
    for (let i = 0; i < 6; i += 1) {                 // 6 x 100 minutes = 10 hours minus a little: always inside the 2 hour idle window
      advance(100 * MIN);
      const s = await sessions.get(cookie);
      if (i < 5) { assert.ok(s, 'still signed in after ' + (i + 1) * 100 + ' minutes of regular activity'); cookie = s.renewed || cookie; }
    }
    advance(10 * MIN);                               // now past 10 hours since login
    assert.equal(await sessions.get(cookie), null, 'the absolute limit still applies');
  } finally { t.done(); }
  const idle = await start();
  try {
    advance(2 * HOUR + MIN);
    assert.equal(await sessions.get(idle.cookie), null, 'two idle hours end the session');
  } finally { idle.done(); }
});

test('logging out revokes every cookie value the session ever had', async () => {
  const t = await start();
  try {
    advance(10 * MIN);
    const s = await sessions.get(t.cookie);
    assert.ok(s.renewed, 'the cookie is renewed once it is a few minutes old');
    sessions.destroy(s.renewed);
    assert.equal(await sessions.get(s.renewed), null);
    assert.equal(await sessions.get(t.cookie), null, 'the first cookie value is revoked too');
  } finally { t.done(); }
});

test('a refresh that Supabase refuses ends the session; an offline refresh does not while the token is still valid', async () => {
  const denied = await start();
  try {
    advance(HOUR - 30 * 1000);
    denied.fake.stats.deny = true;
    assert.equal(await sessions.get(denied.cookie), null);
  } finally { denied.done(); }
  const offline = await start();
  try {
    advance(HOUR - 30 * 1000);
    offline.fake.stats.network = true;
    const s = await sessions.get(offline.cookie);
    assert.ok(s, 'still valid for another 30 seconds, so the editor keeps working while Supabase is unreachable');
  } finally { offline.done(); }
});

test('the host sends the renewed cookie on /api/editor-session and the old cookie keeps working', async () => {
  const t = await start();
  const server = require('../railway/server.js');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const first = await fetch(base + '/api/editor-session', { headers: { cookie: 'elan_sess=' + t.cookie } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('set-cookie'), null, 'a brand new cookie needs no renewal');
    advance(10 * MIN);
    const second = await fetch(base + '/api/editor-session', { headers: { cookie: 'elan_sess=' + t.cookie } });
    assert.equal(second.status, 200);
    const set = second.headers.get('set-cookie');
    assert.ok(set, 'a cookie that is several minutes old is renewed');
    assert.match(set, /^elan_sess=v1\./); assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.doesNotMatch(set, /Max-Age|Expires/);
    const renewed = set.split(';')[0].slice('elan_sess='.length);
    assert.notEqual(renewed, t.cookie);
    assert.equal((await fetch(base + '/api/editor-session', { headers: { cookie: 'elan_sess=' + renewed } })).status, 200);
    const out = await fetch(base + '/api/editor-logout', { method: 'POST', headers: { cookie: 'elan_sess=' + renewed, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(out.status, 200);
    assert.equal((await fetch(base + '/api/editor-session', { headers: { cookie: 'elan_sess=' + t.cookie } })).status, 401, 'logout also kills the original cookie value');
  } finally { server.close(); t.done(); }
});
