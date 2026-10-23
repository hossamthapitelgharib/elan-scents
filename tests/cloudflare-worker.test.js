const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const build = require('../scripts/build-cloudflare.js');
const core = require('../cloudflare/worker-core.js');
const registry = require('../cloudflare/api-registry.js');
const server = require('../railway/server.js');
const root = path.resolve(__dirname, '..');

const SB = 'https://sb.example.test';
const ORIGIN = 'https://shop.example.test';
const MANAGED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'EDITOR_ENV', 'EDITOR_TARGET_BRANCH', 'EDITOR_BRANCH',
  'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_PUBLIC_DOMAIN', 'EDITOR_SITE_ORIGIN', 'ELAN_EDITOR_ORIGIN', 'ELAN_STORE_ORIGIN', 'EDITOR_AUTH_BYPASS', 'EDITOR_ACCESS_KEY',
  'EDITOR_SESSION_SECRET', 'STORE_ORDER_WEBHOOK_SECRET'];

const built = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elan-cf-worker-'));
  const result = build.build({ outDir: path.join(dir, 'dist'), generatedDir: path.join(dir, 'gen') });
  return { dir, dist: path.join(dir, 'dist'), editorFiles: require(path.join(dir, 'gen', 'editor-files.js')), result };
})();
test.after(() => fs.rmSync(built.dir, { recursive: true, force: true }));

/* A stand-in for the ASSETS binding: exact file match only (html_handling "none"), 404 otherwise. */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ASSETS = {
  calls: [],
  async fetch(input) {
    const request = input instanceof Request ? input : new Request(input);
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    this.calls.push(pathname);
    const file = path.join(built.dist, pathname);
    if (pathname === '/_headers' || !file.startsWith(built.dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : fs.readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ETag: '"x"' } });
  }
};
const deps = { api: registry.api, editorHost: registry.editorHost, editorFiles: built.editorFiles };

function withEnv(values, fn) {
  const saved = {};
  for (const name of MANAGED) { saved[name] = process.env[name]; delete process.env[name]; }
  Object.assign(process.env, values);
  const restore = () => { for (const name of MANAGED) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } };
  return Promise.resolve().then(fn).finally(restore);
}
const call = (p, init, env, customDeps) => core.handleRequest(new Request(ORIGIN + p, init), Object.assign({ ASSETS }, env || {}), {}, customDeps || deps);
const post = (p, body, headers) => call(p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });

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
const configured = { SUPABASE_URL: SB, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value' };

test('the API list matches the files in api/ (and never exposes helpers or inherited names)', () => {
  const files = fs.readdirSync(path.join(root, 'api')).filter((f) => f.endsWith('.js') && !f.startsWith('_')).map((f) => f.slice(0, -3));
  assert.deepEqual(Object.keys(registry.api).filter((k) => k !== 'editor').sort(), files.sort());
  for (const [name, load] of Object.entries(registry.api)) assert.equal(typeof load(), 'function', name + ' must export a handler function');
});

test('health, storefront root and unknown paths', async () => {
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.headers.get('strict-transport-security'), /max-age=/);

  ASSETS.calls.length = 0;
  const home = await call('/');
  assert.equal(home.status, 200);
  assert.deepEqual(ASSETS.calls, ['/index.html']);
  assert.equal(await home.text(), fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const head = await call('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const missing = await call('/railway/server.js');
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Not found');
  assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');
  const wrongMethod = await call('/index.html', { method: 'POST', body: '{}' });
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(await wrongMethod.json(), { error: 'method_not_allowed' });
});

test('unknown API names are 404 and cannot reach inherited properties or helper modules', async () => {
  for (const p of ['/api/nope', '/api/constructor', '/api/__proto__', '/api/toString', '/api/_auth', '/api/', '/api']) {
    const r = await call(p);
    assert.equal(r.status, 404, p);
    assert.deepEqual(await r.json(), { error: 'not_found' }, p);
  }
  assert.equal((await call('/api/../railway/server')).status, 404, 'the URL is normalised to /railway/server, which is never public');
});

test('a handler gets Node-style req and res: query, JSON and form bodies, headers, caller address, helpers', async () => {
  const seen = [];
  const custom = Object.assign({}, deps, { api: {
    echo: () => (req, res) => { seen.push(req); res.status(201).setHeader('X-Test', 'yes'); res.json({ method: req.method, url: req.url, query: req.query, body: req.body, ip: req.headers['x-real-ip'], remote: req.socket.remoteAddress, host: req.headers.host, proto: req.headers['x-forwarded-proto'] }); },
    cookies: () => (req, res) => { res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']); res.send('plain'); },
    boom: () => () => { throw new Error('secret detail'); },
    silent: () => () => {},
    late: () => async (req, res) => { await new Promise((r) => setTimeout(r, 5)); res.status(202).json({ ok: true }); },
    'store-order-status': () => (req, res) => res.json({ reached: 'store-order-status' })
  } });
  const withCaller = { 'CF-Connecting-IP': '203.0.113.9', 'X-Real-IP': '6.6.6.6', 'X-Forwarded-For': '7.7.7.7', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' };

  const get = await call('/api/echo?a=1&a=2&b=x%20y', { headers: withCaller }, {}, custom);
  assert.equal(get.status, 201);
  assert.equal(get.headers.get('x-test'), 'yes');
  const g = await get.json();
  assert.deepEqual(g.query, { a: ['1', '2'], b: 'x y' });
  assert.equal(g.url, '/api/echo?a=1&a=2&b=x%20y');
  assert.equal(g.ip, '203.0.113.9', 'a client-sent X-Real-IP must never be believed');
  assert.equal(g.remote, '203.0.113.9');
  assert.equal(g.host, 'shop.example.test');
  assert.equal(g.proto, 'https');
  assert.equal(g.body, undefined);
  assert.equal(seen[0].headers['x-forwarded-for'], undefined);
  assert.equal(seen[0].headers['x-forwarded-host'], 'shop.example.test');

  const json = await call('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"n":1,"t":"ع"}' }, {}, custom);
  assert.deepEqual((await json.json()).body, { n: 1, t: 'ع' });
  const form = await call('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1&a=2&c=3' }, {}, custom);
  assert.deepEqual((await form.json()).body, { a: ['1', '2'], c: '3' });
  const text = await call('/api/echo', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' }, {}, custom);
  assert.equal((await text.json()).body, 'hello');
  const empty = await call('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, {}, custom);
  assert.equal((await empty.json()).body, undefined);
  const bad = await call('/api/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' }, {}, custom);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'invalid_json' });
  const big = await call('/api/echo', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x'.repeat(1000001) }, {}, custom);
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'payload_too_large' });
  const exactlyAtLimit = await call('/api/echo', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x'.repeat(1000000) }, {}, custom);
  assert.equal(exactlyAtLimit.status, 201);

  const cookies = await call('/api/cookies', {}, {}, custom);
  assert.deepEqual(cookies.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(await cookies.text(), 'plain');

  const errors = [];
  const original = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const boom = await call('/api/boom', {}, {}, custom);
    assert.equal(boom.status, 500);
    const body = await boom.text();
    assert.deepEqual(JSON.parse(body), { error: 'server_error' });
    assert.doesNotMatch(body, /secret detail/, 'internal messages stay in the log');
    const silent = await call('/api/silent', {}, {}, custom);
    assert.equal(silent.status, 500, 'a handler that never answers must not hang the request');
  } finally { console.error = original; }
  assert.ok(errors.some((e) => /secret detail/.test(e)));

  const late = await call('/api/late', {}, {}, custom);
  assert.equal(late.status, 202);
  for (const p of ['/api/store-order-completed', '/api/store-order-status-check']) {
    assert.deepEqual(await (await call(p, {}, {}, custom)).json(), { reached: 'store-order-status' }, p);
  }
});

test('Worker variables and secrets become process.env, and the site origin defaults to the one the visitor used', async () => {
  await withEnv({}, async () => {
    await call('/health', {}, { SUPABASE_URL: SB, FLAG: 'on', NOT_A_STRING: { a: 1 } });
    assert.equal(process.env.SUPABASE_URL, SB);
    assert.equal(process.env.FLAG, 'on');
    assert.equal(process.env.NOT_A_STRING, undefined);
    delete process.env.FLAG;
    for (const name of ['EDITOR_SITE_ORIGIN', 'ELAN_EDITOR_ORIGIN', 'ELAN_STORE_ORIGIN']) assert.equal(process.env[name], ORIGIN, name);
    await call('/health', {}, { EDITOR_SITE_ORIGIN: 'https://custom.example.test' });
    assert.equal(process.env.EDITOR_SITE_ORIGIN, 'https://custom.example.test', 'an explicit value always wins');
    assert.equal(process.env.ELAN_STORE_ORIGIN, ORIGIN);
  });
});

test('the owner editor works on the Worker: login page, sign-in, cookie session, private page, sign-out', async () => {
  await withEnv(configured, async () => {
    const restore = fakeSupabase('platform_admin');
    try {
      const anonymous = await call('/editor');
      assert.equal(anonymous.status, 200);
      assert.match(await anonymous.text(), /دخول المالكة/);
      assert.equal(anonymous.headers.get('cache-control'), 'no-store');
      assert.equal(anonymous.headers.get('x-frame-options'), 'DENY');
      assert.match(anonymous.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      for (const p of ['/editor-login.js', '/editor-login.css', '/editor-media.js']) {
        const r = await call(p);
        assert.equal(r.status, 200, p);
        assert.equal((await r.text()), fs.readFileSync(path.join(root, 'editor', p.slice(1)), 'utf8'), p);
      }
      assert.equal((await call('/editor-guard.js')).status, 404, 'the guard script is for signed-in owners only');
      assert.equal((await call('/api/editor-session')).status, 401);
      assert.equal((await call('/editor/elan-editor.html')).status, 404);
      assert.equal((await call('/editor/login.html')).status, 404);

      const refused = await post('/api/editor-login', { email: 'owner@example.test', password: 'wrong' });
      assert.equal(refused.status, 401);
      const crossOrigin = await post('/api/editor-login', { email: 'a@b.test', password: 'right' }, { Origin: 'https://evil.example' });
      assert.equal(crossOrigin.status, 403);

      const login = await post('/api/editor-login', { email: 'owner@example.test', password: 'right' }, { Origin: ORIGIN });
      assert.equal(login.status, 200);
      const setCookie = login.headers.get('set-cookie');
      assert.match(setCookie, /^elan_sess=v1\./);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Secure/);
      const cookie = setCookie.split(';')[0];

      const page = await call('/editor', { headers: { Cookie: cookie } });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes('window.ELAN_EDITOR_SITE_ORIGIN=' + JSON.stringify(ORIGIN)), 'the editor frames this same site');
      assert.ok(html.includes('<script src="/editor-guard.js"></script>'));
      const csp = page.headers.get('content-security-policy');
      assert.ok(csp.includes("frame-src 'self' " + ORIGIN), csp);
      assert.match(csp, /script-src 'self' 'sha256-/);
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      assert.equal((await call('/editor-guard.js', { headers: { Cookie: cookie } })).status, 200);
      assert.equal((await call('/api/editor-session', { headers: { Cookie: cookie } })).status, 200);

      const ticket = await post('/api/editor-bridge-ticket', {}, { Cookie: cookie, Origin: ORIGIN });
      assert.equal(ticket.status, 200);
      const issued = await ticket.json();
      assert.equal(issued.ok, true);
      const delegated = await call('/api/editor-session', { headers: { 'X-Elan-Editor-Ticket': issued.ticket } });
      assert.equal(delegated.status, 200, 'a ticket issued by this Worker is accepted by this Worker (same origin for editor and storefront)');

      const logout = await post('/api/editor-logout', {}, { Cookie: cookie, Origin: ORIGIN });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    } finally { restore(); }
  });
});

test('/api/editor reads the committed design from the assets when GitHub is not configured, and answers "published?" from the assets', async () => {
  await withEnv(Object.assign({}, configured, { EDITOR_SITE_ORIGIN: ORIGIN }), async () => {
    const restore = fakeSupabase('platform_admin');
    try {
      const login = await post('/api/editor-login', { email: 'owner@example.test', password: 'right' }, { Origin: ORIGIN });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const state = await call('/api/editor?action=state', { headers: { Cookie: cookie } });
      assert.equal(state.status, 200);
      const body = await state.json();
      assert.equal(body.ok, true);
      assert.equal(body.readOnly, true);
      const crypto = require('node:crypto');
      const text = fs.readFileSync(path.join(root, 'design', 'home.json'), 'utf8');
      const blob = Buffer.from(text, 'utf8');
      assert.equal(body.revision, crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + blob.length + '\0'), blob])).digest('hex'));

      Object.assign(process.env, { GITHUB_TOKEN: 'ghp_test_value_only', EDITOR_ENV: 'production', EDITOR_TARGET_BRANCH: 'main' });
      ASSETS.calls.length = 0;
      const live = await post('/api/editor', { action: 'status', revision: body.revision }, { Cookie: cookie, Origin: ORIGIN });
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { ok: true, published: true, revision: body.revision, liveRevision: body.revision });
      assert.ok(ASSETS.calls.includes('/design/home.json'), 'the Worker must not fetch its own public URL');
      const stale = await post('/api/editor', { action: 'status', revision: '0'.repeat(40) }, { Cookie: cookie, Origin: ORIGIN });
      assert.equal((await stale.json()).published, false);
      assert.equal((await post('/api/editor', { action: 'state' }, {})).status, 401, 'no cookie, no ticket: no access');
    } finally { restore(); }
  });
});

test('the same request gets the same answer from the Worker and from railway/server.js', async () => {
  await withEnv(Object.assign({}, configured, { EDITOR_SITE_ORIGIN: ORIGIN }), async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const restore = fakeSupabase('customer');
    try {
      const cases = [
        ['GET', '/api/config'], ['GET', '/api/nope'], ['GET', '/api/notifications'], ['GET', '/api/dashboard-orders'], ['GET', '/api/customer-orders'],
        ['POST', '/api/store-order-status', {}], ['POST', '/api/guest-cart', {}], ['POST', '/api/store-order-completed', {}], ['GET', '/api/platform-stores'],
        ['GET', '/api/editor'], ['GET', '/api/editor-session'], ['POST', '/api/editor-login', { email: 'x@example.test', password: 'wrong' }],
        ['GET', '/editor'], ['GET', '/editor-login.js'], ['GET', '/editor-login.css'], ['GET', '/editor-guard.js'], ['GET', '/editor/elan-editor.html'], ['PUT', '/api/config'], ['DELETE', '/index.html']
      ];
      for (const [method, p, payload] of cases) {
        const init = { method, headers: { 'Content-Type': 'application/json' } };
        if (payload !== undefined) init.body = JSON.stringify(payload);
        const railway = await fetch(base + p, init);
        const worker = await call(p, init);
        assert.equal(worker.status, railway.status, method + ' ' + p + ' status');
        assert.equal(await worker.text(), await railway.text(), method + ' ' + p + ' body');
        for (const h of ['content-type', 'cache-control', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy']) {
          assert.equal(worker.headers.get(h), railway.headers.get(h), method + ' ' + p + ' ' + h);
        }
      }
    } finally { restore(); server.close(); }
  });
});

test('the request shim streams the body only when asked, and a handler can stop reading', async () => {
  const request = new Request(ORIGIN + '/api/x', { method: 'POST', body: 'abcdef' });
  const req = core.makeRequest(request, new URL(request.url));
  const chunks = [];
  await new Promise((resolve) => { req.on('data', (c) => { chunks.push(Buffer.from(c).toString()); req.destroy(); }); req.on('end', resolve); setTimeout(resolve, 30); });
  assert.equal(chunks.join(''), 'abcdef');
  const noBody = core.makeRequest(new Request(ORIGIN + '/api/x'), new URL(ORIGIN + '/api/x'));
  await new Promise((resolve) => noBody.on('end', resolve));
  assert.equal(noBody.method, 'GET');
});

test('the editor page and its CSP are the same whether the hashes were computed at build time or scanned from the page', async () => {
  const host = require('../railway/editor-host.js');
  const crypto = require('node:crypto');
  const provider = (skip, patch) => (name) => {
    if (name === skip) return null;
    if (patch && Object.prototype.hasOwnProperty.call(patch, name)) return patch[name];
    return Object.prototype.hasOwnProperty.call(built.editorFiles, name) ? built.editorFiles[name] : null;
  };
  await withEnv({ EDITOR_SITE_ORIGIN: ORIGIN }, async () => {
    try {
      host.setFileProvider(provider());
      const fast = host.buildPage();
      host.setFileProvider(provider('elan-editor.hashes.json'));
      const scanned = host.buildPage();
      assert.deepEqual(fast, scanned);
      // Hashes left over from a different page are ignored rather than trusted.
      host.setFileProvider(provider(null, { 'elan-editor.hashes.json': JSON.stringify({ digest: 'stale', headScripts: ["'sha256-wrong'"], bodyScripts: [], handlers: [] }) }));
      assert.deepEqual(host.buildPage(), scanned);
      host.setFileProvider(provider(null, { 'elan-editor.hashes.json': '{not json' }));
      assert.deepEqual(host.buildPage(), scanned);

      // Reference: the way the page was hashed before the build step existed (scan the finished page).
      const sha = (s) => "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";
      let html = built.editorFiles['elan-editor.html'];
      html = html.replace('</head>', '<script>window.ELAN_EDITOR_SITE_ORIGIN=' + JSON.stringify(ORIGIN) + ';</script></head>');
      html = html.replace('</body>', '<script src="/editor-guard.js"></script><script src="/editor-media.js"></script><script src="/editor/editor-live-library.js?v=20261016-01"></script></body>');
      const hashes = [];
      html.replace(/<script>([\s\S]*?)<\/script>/g, (_, code) => { hashes.push(sha(code)); return ''; });
      const handlers = [];
      html.replace(/\son[a-z]+="([^"]*)"/g, (_, code) => { handlers.push(sha(code.replace(/&quot;/g, '"').replace(/&#39;/g, "'"))); return ''; });
      assert.equal(fast.html, html);
      assert.ok(fast.csp.includes("script-src 'self' " + hashes.join(' ') + " 'unsafe-hashes' " + handlers.join(' ')), 'same hashes in the same order as scanning the finished page');
      assert.ok(hashes.length > 1 && handlers.length > 0, 'the editor page really has inline scripts and handlers to hash');
    } finally { host.setFileProvider(provider()); }
  });
});
