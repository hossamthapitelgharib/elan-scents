const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

const SB = 'https://sb.example.test';
function env() {
  process.env.SUPABASE_URL = SB; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
}
function start() {
  const server = require('../railway/server.js');
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function fakeSupabase(role) {
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    url = String(url);
    if (url.startsWith('http://127.0.0.1')) return real(url, opts);
    let r;
    if (url.startsWith(SB + '/auth/v1/token')) r = JSON.parse(opts.body).password === 'right' ? { s: 200, j: { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 } } : { s: 400, j: {} };
    else if (url.startsWith(SB + '/auth/v1/user')) r = { s: 200, j: { id: 'u1', email: 'owner@example.test' } };
    else if (url.startsWith(SB + '/rest/v1/profiles')) r = { s: 200, j: [{ id: 'u1', role }] };
    else r = { s: 500, j: {} };
    return { ok: r.s < 300, status: r.s, json: async () => r.j, text: async () => '' };
  };
  return () => { global.fetch = real; };
}
const url = (s, p) => 'http://127.0.0.1:' + s.address().port + p;
const post = (s, p, body, headers) => fetch(url(s, p), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

test('the owner editor page is private: anonymous visitors only ever get the login page', async () => {
  env(); const s = await start();
  try {
    const page = await fetch(url(s, '/editor'));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /دخول المالكة/);
    assert.doesNotMatch(html, /elan-editor-bridge/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    for (const p of ['/editor/elan-editor.html', '/editor/login.html', '/editor-guard.js', '/api/editor-session']) {
      const r = await fetch(url(s, p));
      assert.ok(r.status === 404 || r.status === 401, p + ' -> ' + r.status);
    }
    assert.equal((await fetch(url(s, '/api/editor'))).status, 401);
  } finally { s.close(); }
});

test('only an admin can log in; the session is a browser-session cookie and logout ends it', async () => {
  env(); const s = await start(); let restore = fakeSupabase('platform_admin');
  try {
    assert.equal((await post(s, '/api/editor-login', { email: 'a@b.c', password: 'wrong' })).status, 401);
    restore(); restore = fakeSupabase('customer');
    const denied = await post(s, '/api/editor-login', { email: 'a@b.c', password: 'right' });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get('set-cookie'), null);
    restore(); restore = fakeSupabase('platform_admin');
    const ok = await post(s, '/api/editor-login', { email: 'owner@example.test', password: 'right' });
    assert.equal(ok.status, 200);
    const set = ok.headers.get('set-cookie');
    assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.doesNotMatch(set, /Max-Age|Expires/);
    const cookie = cookieOf(ok);

    const page = await fetch(url(s, '/editor'), { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /elan-editor-bridge/);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /frame-src 'self'/); assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*'unsafe-inline'/);
    assert.equal((await fetch(url(s, '/api/editor-session'), { headers: { cookie } })).status, 200);

    assert.equal((await post(s, '/api/editor-logout', {}, { cookie })).status, 200);
    assert.equal((await fetch(url(s, '/api/editor-session'), { headers: { cookie } })).status, 401);
    assert.match(await (await fetch(url(s, '/editor'), { headers: { cookie } })).text(), /دخول المالكة/);
  } finally { restore(); s.close(); }
});

test('cross-site login attempts are refused', async () => {
  env(); const s = await start(); const restore = fakeSupabase('platform_admin');
  try { assert.equal((await post(s, '/api/editor-login', { email: 'a@b.c', password: 'right' }, { Origin: 'https://evil.example' })).status, 403); }
  finally { restore(); s.close(); }
});

test('edit mode only loads inside the editor window and never talks to customers', () => {
  const boot = fs.readFileSync(path.join(root, 'edit-boot.js'), 'utf8');
  assert.match(boot, /window\.parent === window/);
  assert.match(boot, /elan_editor/);
  assert.match(boot, /edit-mode\.js/);
  const edit = fs.readFileSync(path.join(root, 'edit-mode.js'), 'utf8');
  assert.match(edit, /allowedEditorOrigins: \[location\.origin\]/);
  assert.doesNotMatch(edit, /localStorage|sessionStorage|document\.cookie|eval\(|new Function/);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /edit-mode|elan-host-bridge/);
  assert.match(html, /edit-boot\.js/);
});

test('free-form edits are validated and resolved per screen size', () => {
  const ED = require('../design-schema.js');
  const ok = ED.normalize({ version: 1, edits: { all: { 'sec:brands:title': { text: { ar: 'س' }, style: { color: '#aa2222', fontSize: 30 } } }, mobile: { 'card:abc': { dx: 12.6, dy: -5, w: 120 } } } }, { strict: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.design.edits.mobile['card:abc'].dx, 13);
  assert.equal(ED.deviceOf(500), 'mobile'); assert.equal(ED.deviceOf(800), 'tablet'); assert.equal(ED.deviceOf(1300), 'desktop');
  assert.equal(ED.editFor(ok.design, 'mobile', 'card:abc').w, 120);
  assert.equal(ED.editFor(ok.design, 'desktop', 'card:abc'), null);
  const bad = [
    { all: { 'x y': { dx: 1 } } }, { watch: {} }, { all: { 'sec:brands': { dx: 99999 } } },
    { all: { 'sec:brands': { style: { color: 'red' } } } }, { all: { 'sec:brands': { style: { backgroundImage: 'url(x)' } } } },
    { all: { 'sec:brands': { html: '<img onerror=1>' } } }, { all: { 'sec:brands': { w: 2 } } }
  ];
  bad.forEach((e) => assert.equal(ED.normalize({ version: 1, edits: e }, { strict: true }).ok, false, JSON.stringify(e)));
  assert.equal(ED.isEmpty(ED.normalize({ version: 1, edits: { all: { hero: { hidden: true } } } }).design), false);
  assert.ok(Buffer.byteLength(ED.serialize(ok.design)) < ED.LIMITS.bytes);
});
