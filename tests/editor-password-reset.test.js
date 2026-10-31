/* Forgotten editor password (owner request 2026-10-30): the owner asks for a temporary link, Supabase Auth emails it, /editor-reset takes the
   token from the link and a new password, and the answer to "send me a link" never says whether the account exists. Fake Supabase only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sessions = require('../railway/editor-session.js');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const SB = 'https://sb.example.test';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.signature-of-the-recovery-link-0123456789';

function fakeAuth({ known = ['owner@example.test'], recoverStatus, userStatus = 200, userBody = {} } = {}) {
  const real = global.fetch, calls = [];
  const saved = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'].map((k) => [k, process.env[k]]);
  process.env.SUPABASE_URL = SB; process.env.SUPABASE_ANON_KEY = 'anon-key';
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('http://127.0.0.1')) return real(url, opts);
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url.startsWith(SB + '/auth/v1/recover')) {
      // Supabase answers 200 for a known and an unknown address alike
      return reply(recoverStatus || 200, {});
    }
    if (url === SB + '/auth/v1/user' && opts.method === 'PUT') return reply(userStatus, userBody);
    if (url.startsWith(SB + '/auth/v1/logout')) return reply(204, {});
    return reply(500, {});
  };
  return { calls, known, restore() { global.fetch = real; for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

test('asking for a link calls Supabase Auth recover for the address, with the redirect to the reset page, and answers 200', async () => {
  const f = fakeAuth();
  try {
    const r = await sessions.requestPasswordReset('Owner@Example.test ', 'ip-a-1', 'https://site.example.test/editor-reset');
    assert.deepEqual(r, { status: 200 });
    const call = f.calls.find((c) => c.url.includes('/auth/v1/recover'));
    assert.equal(call.method, 'POST');
    assert.equal(call.url, SB + '/auth/v1/recover?redirect_to=' + encodeURIComponent('https://site.example.test/editor-reset'));
    assert.equal(call.headers.apikey, 'anon-key');
    assert.deepEqual(call.body, { email: 'owner@example.test' }, 'trimmed and lower-cased');
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('the answer is the same for an address with an account and one without, and when Supabase refuses', async () => {
  for (const recoverStatus of [200, 400, 404, 422, 429]) {
    const f = fakeAuth({ recoverStatus });
    try {
      const known = await sessions.requestPasswordReset('owner' + recoverStatus + '@example.test', 'ip-b-' + recoverStatus, 'https://site.example.test/editor-reset');
      const unknown = await sessions.requestPasswordReset('nobody' + recoverStatus + '@example.test', 'ip-c-' + recoverStatus, 'https://site.example.test/editor-reset');
      assert.deepEqual(known, { status: 200 }, 'Supabase said ' + recoverStatus);
      assert.deepEqual(unknown, known);
    } finally { f.restore(); }
  }
});

test('a link is not sent twice to the same address within a minute, and the answer does not change', async () => {
  const f = fakeAuth();
  try {
    assert.deepEqual(await sessions.requestPasswordReset('twice@example.test', 'ip-d-1', ''), { status: 200 });
    assert.deepEqual(await sessions.requestPasswordReset('TWICE@example.test', 'ip-d-2', ''), { status: 200 });
    assert.equal(f.calls.filter((c) => c.url.includes('/recover')).length, 1);
  } finally { f.restore(); }
});

test('one IP gets five link requests per 15 minutes, then a 429 that says nothing about any account', async () => {
  const f = fakeAuth();
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await sessions.requestPasswordReset('n' + i + '@example.test', 'ip-e', '')).status, 200);
    assert.deepEqual(await sessions.requestPasswordReset('n9@example.test', 'ip-e', ''), { status: 429, error: 'too_many_attempts' });
    assert.equal(f.calls.length, 5);
  } finally { f.restore(); }
});

test('a malformed address, or no Supabase configuration, is refused before anything is sent', async () => {
  const f = fakeAuth();
  try {
    for (const bad of ['', 'not-an-email', 'a@b', 5, null, 'a@b.c'.padEnd(250, 'x')]) assert.equal((await sessions.requestPasswordReset(bad, 'ip-f', '')).status, 400, String(bad).slice(0, 20));
    assert.equal(f.calls.length, 0);
    delete process.env.SUPABASE_ANON_KEY;
    assert.equal((await sessions.requestPasswordReset('a@b.test', 'ip-f2', '')).error, 'supabase_service_configuration_missing');
  } finally { f.restore(); }
});

test('Supabase being unreachable is reported without saying anything about the address', async () => {
  const f = fakeAuth();
  const before = global.fetch;
  global.fetch = async (url, opts) => { if (String(url).includes('/recover')) throw new Error('network'); return before(url, opts); };
  try { assert.deepEqual(await sessions.requestPasswordReset('down@example.test', 'ip-g', ''), { status: 502, error: 'auth_unreachable' }); }
  finally { global.fetch = before; f.restore(); }
});

test('the new password goes to Supabase with the recovery token, then every session of the account is ended', async () => {
  const f = fakeAuth();
  try {
    const r = await sessions.resetPassword(TOKEN, 'a-long-new-password', 'ip-h-1');
    assert.deepEqual(r, { status: 200 });
    const put = f.calls.find((c) => c.method === 'PUT');
    assert.equal(put.url, SB + '/auth/v1/user');
    assert.equal(put.headers.Authorization, 'Bearer ' + TOKEN);
    assert.deepEqual(put.body, { password: 'a-long-new-password' });
    const out = f.calls.find((c) => c.url.includes('/auth/v1/logout'));
    assert.ok(out && out.url.endsWith('scope=global'), 'a stolen old session does not survive the reset');
    assert.equal(out.headers.Authorization, 'Bearer ' + TOKEN);
    assert.doesNotMatch(JSON.stringify(r), /password|token|eyJ/i, 'nothing secret is ever sent back');
  } finally { f.restore(); }
});

test('an expired or used link, a weak or unchanged password, and a short password are told apart', async () => {
  let f = fakeAuth({ userStatus: 401, userBody: { error_code: 'bad_jwt' } });
  try { assert.deepEqual(await sessions.resetPassword(TOKEN, 'a-long-new-password', 'ip-i-1'), { status: 401, error: 'invalid_or_expired_link' }); assert.ok(!f.calls.some((c) => c.url.includes('/logout')), 'no logout after a failed reset'); } finally { f.restore(); }
  f = fakeAuth({ userStatus: 422, userBody: { error_code: 'same_password' } });
  try { assert.deepEqual(await sessions.resetPassword(TOKEN, 'a-long-new-password', 'ip-i-2'), { status: 422, error: 'same_password' }); } finally { f.restore(); }
  f = fakeAuth({ userStatus: 422, userBody: { error_code: 'weak_password' } });
  try { assert.deepEqual(await sessions.resetPassword(TOKEN, 'a-long-new-password', 'ip-i-3'), { status: 422, error: 'weak_password' }); } finally { f.restore(); }
  f = fakeAuth({ userStatus: 500 });
  try { assert.deepEqual(await sessions.resetPassword(TOKEN, 'a-long-new-password', 'ip-i-4'), { status: 502, error: 'reset_failed' }); } finally { f.restore(); }
  f = fakeAuth();
  try {
    assert.deepEqual(await sessions.resetPassword(TOKEN, 'short', 'ip-i-5'), { status: 400, error: 'weak_password' });
    assert.equal((await sessions.resetPassword('', 'a-long-new-password', 'ip-i-5')).error, 'invalid_or_expired_link');
    assert.equal((await sessions.resetPassword('bad token with spaces', 'a-long-new-password', 'ip-i-5')).error, 'invalid_or_expired_link');
    assert.equal(f.calls.length, 0, 'refused before any request to Supabase');
  } finally { f.restore(); }
});

test('one IP gets ten password changes per 15 minutes', async () => {
  const f = fakeAuth({ userStatus: 401 });
  try {
    for (let i = 0; i < 10; i += 1) assert.equal((await sessions.resetPassword(TOKEN, 'a-long-new-password', 'ip-j')).status, 401);
    assert.deepEqual(await sessions.resetPassword(TOKEN, 'a-long-new-password', 'ip-j'), { status: 429, error: 'too_many_attempts' });
  } finally { f.restore(); }
});

/* ---------- over HTTP ---------- */

const SITE = 'https://storefront.example.test/';
function startServer() {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'EDITOR_TARGET_BRANCH', 'EDITOR_BRANCH', 'EDITOR_ENV']) delete process.env[name];
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; process.env.EDITOR_SITE_ORIGIN = SITE;
  const server = require('../railway/server.js');
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const at = (s, p) => 'http://127.0.0.1:' + s.address().port + p;
const post = (s, p, body, headers) => fetch(at(s, p), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });

test('over HTTP: the link request answers {ok:true} for any address, uses the configured site for the redirect, and refuses other origins', async () => {
  const f = fakeAuth(); const s = await startServer();
  try {
    const a = await post(s, '/api/editor-forgot-password', { email: 'http-one@example.test' });
    const b = await post(s, '/api/editor-forgot-password', { email: 'http-two@example.test' }, { Host: 'attacker.example' });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.deepEqual(await a.json(), { ok: true });
    assert.deepEqual(await b.json(), { ok: true });
    assert.equal(a.headers.get('cache-control'), 'no-store');
    for (const call of f.calls.filter((c) => c.url.includes('/recover'))) {
      assert.equal(new URL(call.url).searchParams.get('redirect_to'), 'https://storefront.example.test/editor-reset', 'never taken from a request header');
    }
    assert.equal((await post(s, '/api/editor-forgot-password', { email: 'x@example.test' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(at(s, '/api/editor-forgot-password'))).status, 403, 'GET is not accepted');
    assert.equal((await post(s, '/api/editor-forgot-password', { email: 'nope' })).status, 400);
  } finally { s.close(); f.restore(); }
});

test('over HTTP: resetting needs the same origin, changes the password, and never echoes the token or the password', async () => {
  const f = fakeAuth(); const s = await startServer();
  try {
    assert.equal((await post(s, '/api/editor-reset-password', { accessToken: TOKEN, password: 'a-long-new-password' }, { Origin: 'https://evil.example' })).status, 403);
    const ok = await post(s, '/api/editor-reset-password', { accessToken: TOKEN, password: 'a-long-new-password' });
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.equal(text, JSON.stringify({ ok: true }));
    assert.equal((await post(s, '/api/editor-reset-password', 'x')).status, 400);
  } finally { s.close(); f.restore(); }
});

test('over HTTP: the reset page and its script are public, never cached, locked down, and not framable', async () => {
  const f = fakeAuth(); const s = await startServer();
  try {
    const page = await fetch(at(s, '/editor-reset'));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /كلمة سر جديدة/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(page.headers.get('content-security-policy'), /form-action 'none'/);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
    const js = await fetch(at(s, '/editor-reset.js'));
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const login = await (await fetch(at(s, '/editor'))).text();
    assert.match(login, /نسيت كلمة السر؟/);
    assert.match(login, /id="forgotBtn"/);
    assert.equal((await fetch(at(s, '/editor/reset.html'))).status, 404, 'the file itself is not a public path');
  } finally { s.close(); f.restore(); }
});

/* ---------- the pages ---------- */

test('the reset page takes the token from the link once, scrubs it from the address, keeps it only in memory, and clears the passwords', () => {
  const js = read('editor/editor-reset.js');
  assert.match(js, /location\.hash/);
  assert.match(js, /history\.replaceState\(null, '', location\.pathname\)/);
  assert.match(js, /params\.get\('type'\) === 'recovery'/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie|console\./, 'the token and passwords are never stored or logged');
  assert.match(js, /a\.value = ''; b\.value = ''/);
  assert.match(js, /token = ''/);
  assert.match(js, /\/api\/editor-reset-password/);
  assert.match(js, /var MIN = 10/);
  assert.equal(sessions.MIN_NEW_PASSWORD, 10, 'the page and the server agree');
  const html = read('editor/reset.html');
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>|\son\w+=/, 'no inline script or handler (the page CSP forbids them)');
  assert.match(html, /name="referrer" content="no-referrer"/);
});

test('the login page asks for the email in the same box and never says whether an account exists', () => {
  const js = read('editor/editor-login.js');
  assert.match(js, /\/api\/editor-forgot-password/);
  assert.match(js, /لو فيه حساب بالبريد ده/);
  assert.doesNotMatch(js, /مفيش حساب|الحساب مش موجود|not found|no account/i);
  assert.doesNotMatch(read('editor/login.html'), /<script(?![^>]*\ssrc=)[^>]*>|\son\w+=/);
});

test('a recovery link that lands on the login page is passed on to the reset page with its token', () => {
  const js = read('editor/editor-login.js');
  assert.match(js, /location\.replace\('\/editor-reset' \+ location\.hash\)/);
  assert.ok(js.indexOf("type=recovery") < js.indexOf("var msg = document.getElementById('msg')"), 'before anything else runs');
});

test('the Cloudflare bundle carries the two new private editor files, and no secret is in them', () => {
  const build = read('scripts/build-cloudflare.js');
  assert.match(build, /'reset\.html', 'editor-reset\.js'/);
  for (const file of ['editor/reset.html', 'editor/editor-reset.js', 'railway/editor-session.js']) assert.doesNotMatch(read(file), /service_role|SERVICE_ROLE_KEY=|eyJ[A-Za-z0-9_-]{20,}\./, file);
});
