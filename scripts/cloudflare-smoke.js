#!/usr/bin/env node
/* Élan Scents — smoke test of the Cloudflare Worker running for real (wrangler dev, i.e. the workerd runtime).
   Usage: node scripts/cloudflare-smoke.js http://127.0.0.1:8787
   The Worker must have been started with the fake values in .dev.vars written by .github/workflows/cloudflare-worker.yml:
   SUPABASE_URL=http://127.0.0.1:54321 plus the fake secrets below. This script starts the fake Supabase on that port.
   It exists because tests/cloudflare-*.test.js run the Worker code in Node, which cannot prove that things like the asset layer
   (_headers, Range, ETag), AES-GCM cookies or the assets binding behave the same inside workerd. Fake values only. */
const http = require('http');

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const FAKE_SUPABASE_PORT = Number(process.env.FAKE_SUPABASE_PORT) || 54321;
const ACCESS_KEY = process.env.SMOKE_ACCESS_KEY || 'smoke-access-key-0123456789';
const WEBHOOK_SECRET = process.env.SMOKE_WEBHOOK_SECRET || 'smoke-webhook-secret-0123456789';
const USER_ID = '11111111-1111-4111-8111-111111111111';

const failures = [];
let passed = 0;
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log('ok   ' + name); return; }
  failures.push(name + (detail === undefined ? '' : ' -> ' + detail));
  console.log('FAIL ' + name + (detail === undefined ? '' : ' -> ' + detail));
  console.log('::error title=Worker smoke test::' + String(name + (detail === undefined ? '' : ' -> ' + detail)).replace(/[\r\n]+/g, ' ').slice(0, 400));
}

function startFakeSupabase() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith('/auth/v1/token?grant_type=password')) {
        let body = {}; try { body = JSON.parse(raw); } catch (_) { /* bad body */ }
        return body.password === 'right-password' ? send(200, { access_token: 'user-token-fake', refresh_token: 'refresh-fake', expires_in: 3600 }) : send(400, { error: 'invalid_grant' });
      }
      if (req.url === '/auth/v1/user') return req.headers.authorization === 'Bearer user-token-fake' ? send(200, { id: USER_ID, email: 'owner@example.test' }) : send(401, {});
      if (req.url.startsWith('/rest/v1/profiles')) return send(200, [{ id: USER_ID, role: 'platform_admin' }]);
      return send(404, { error: 'not_found_in_fake_supabase', url: req.url });
    });
  });
  return new Promise((resolve) => server.listen(FAKE_SUPABASE_PORT, '127.0.0.1', () => resolve(server)));
}

async function waitUntilReady() {
  const until = Date.now() + 180000;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.status === 200) return true;
      last = 'status ' + r.status + ' ' + (await r.text()).slice(0, 80);
    } catch (e) { last = String(e && e.message); }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  check('the Worker answers /health within 3 minutes', false, last);
  return false;
}

const get = (p, init) => fetch(BASE + p, Object.assign({ redirect: 'manual' }, init));
const post = (p, body, headers) => fetch(BASE + p, { method: 'POST', redirect: 'manual', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });

async function main() {
  const fake = await startFakeSupabase();
  try {
    if (!(await waitUntilReady())) return;

    const health = await get('/health');
    check('/health is ok', health.status === 200 && (await health.text()) === 'ok');

    const home = await get('/');
    const homeText = await home.text();
    check('the storefront is served', home.status === 200 && /<html lang="ar"/.test(homeText), home.status);
    check('storefront headers', home.headers.get('cache-control') === 'no-store, max-age=0, must-revalidate' && home.headers.get('x-content-type-options') === 'nosniff' && /camera=\(\)/.test(home.headers.get('permissions-policy') || ''), JSON.stringify([...home.headers]));
    const fonts = await get('/fonts.css');
    const fontUrl = (/\/assets\/fonts\/[^"')\s]+\.woff2/.exec(await fonts.text()) || [])[0];
    check('fonts.css names a font file', Boolean(fontUrl));
    if (fontUrl) {
      const font = await get(fontUrl);
      check('a font file is cached for a year (immutable) by the _headers rules', font.status === 200 && font.headers.get('cache-control') === 'public, max-age=31536000, immutable', font.status + ' ' + font.headers.get('cache-control'));
      await font.arrayBuffer();
    }
    const css = await get('/style.css');
    check('a stylesheet is served as text/css with no-cache', css.status === 200 && /^text\/css/.test(css.headers.get('content-type') || '') && css.headers.get('cache-control') === 'no-cache', css.status + ' ' + css.headers.get('content-type') + ' ' + css.headers.get('cache-control'));
    await css.arrayBuffer();
    const json = await get('/design/home.json');
    check('design/home.json is served', json.status === 200 && JSON.parse(await json.text()).version >= 1);

    for (const p of ['/package.json', '/railway/server.js', '/lib/secure.js', '/api/_auth.js', '/editor/elan-editor.html', '/server.js', '/wrangler.jsonc', '/CLAUDE.md']) {
      const r = await get(p);
      check('blocked: ' + p, r.status === 404, r.status);
      await r.arrayBuffer();
    }

    const video = await get('/assets/hero.mp4', { headers: { range: 'bytes=0-99' } });
    const videoBytes = (await video.arrayBuffer()).byteLength;
    check('the hero video answers a Range request with 206', video.status === 206 && videoBytes === 100 && /^bytes 0-99\/\d+$/.test(video.headers.get('content-range') || ''), video.status + ' ' + videoBytes + ' ' + video.headers.get('content-range'));
    check('a range answer keeps the hero video cache rule and says it accepts ranges', video.headers.get('cache-control') === 'public, max-age=31536000, immutable' && video.headers.get('accept-ranges') === 'bytes', video.headers.get('cache-control') + ' ' + video.headers.get('accept-ranges'));
    const total = Number((/\/(\d+)$/.exec(video.headers.get('content-range') || '') || [])[1]);
    const wholeVideo = await get('/assets/hero.mp4');
    check('the hero video without a Range is the whole file with the cache rule', wholeVideo.status === 200 && (await wholeVideo.arrayBuffer()).byteLength === total && wholeVideo.headers.get('cache-control') === 'public, max-age=31536000, immutable' && /^video\/mp4/.test(wholeVideo.headers.get('content-type') || ''), wholeVideo.status + ' ' + total + ' ' + wholeVideo.headers.get('content-type'));
    const beyond = await get('/assets/hero.mp4', { headers: { range: 'bytes=' + (total + 10) + '-' } });
    check('a range beyond the end of the video is 416', beyond.status === 416 && beyond.headers.get('content-range') === 'bytes */' + total, beyond.status + ' ' + beyond.headers.get('content-range'));
    await beyond.arrayBuffer();
    const first = await get('/index.html');
    const etag = first.headers.get('etag');
    await first.arrayBuffer();
    if (etag) {
      const again = await get('/index.html', { headers: { 'if-none-match': etag } });
      check('a file with a matching ETag answers 304', again.status === 304, again.status);
    } else check('static files carry an ETag', false);

    const cfg = await get('/api/config');
    const cfgBody = await cfg.json();
    check('/api/config returns the fake Supabase address', cfg.status === 200 && cfgBody.url === 'http://127.0.0.1:' + FAKE_SUPABASE_PORT, JSON.stringify(cfgBody));
    const denied = await post('/api/store-order-completed', {}, { 'x-store-webhook-secret': 'wrong' });
    check('the old webhook path reaches store-order-status and refuses a wrong secret', denied.status === 401, denied.status + ' ' + (await denied.text()).slice(0, 100));
    const gone = await get('/api/not-a-route');
    check('unknown /api route is 404 JSON', gone.status === 404 && (await gone.json()).error === 'not_found');

    // Owner editor with the temporary access key: exercises the cookie, the editor page and its CSP inside workerd.
    const login = await get('/editor');
    check('the editor login page is served', login.status === 200 && login.headers.get('x-frame-options') === 'DENY');
    await login.arrayBuffer();
    const key = await get('/editor?key=' + encodeURIComponent(ACCESS_KEY));
    const keyCookie = (key.headers.get('set-cookie') || '').split(';')[0];
    check('the access key signs the owner in', key.status === 302 && /^elan_sess=/.test(keyCookie), key.status + ' ' + key.headers.get('set-cookie'));
    const page = await get('/editor', { headers: { cookie: keyCookie } });
    const pageText = await page.text();
    check('the signed-in owner gets the editor page with a content-security-policy', page.status === 200 && /frame-src 'self'/.test(page.headers.get('content-security-policy') || '') && pageText.length > 100000, page.status + ' ' + pageText.length);

    // Owner editor with email and password against the fake Supabase: exercises AES-256-GCM sealing and unsealing in workerd.
    const bad = await post('/api/editor-login', { email: 'owner@example.test', password: 'wrong' }, { origin: BASE });
    check('a wrong password is refused', bad.status === 401, bad.status);
    await bad.arrayBuffer();
    const ok = await post('/api/editor-login', { email: 'owner@example.test', password: 'right-password' }, { origin: BASE });
    const sealed = (ok.headers.get('set-cookie') || '').split(';')[0];
    check('email sign-in seals a cookie', ok.status === 200 && /^elan_sess=v1\./.test(sealed), ok.status + ' ' + (ok.headers.get('set-cookie') || '').slice(0, 30));
    await ok.arrayBuffer();
    const session = await get('/api/editor-session', { headers: { cookie: sealed } });
    check('the sealed cookie is accepted on the next request', session.status === 200, session.status);
    await session.arrayBuffer();
    const forged = await get('/api/editor-session', { headers: { cookie: sealed.slice(0, -4) + 'AAAA' } });
    check('a tampered cookie is refused', forged.status === 401, forged.status);
    await forged.arrayBuffer();
    const state = await get('/api/editor?action=state', { headers: { cookie: sealed } });
    const stateBody = await state.json().catch(() => ({}));
    check('/api/editor reads the design that was built into the Worker', state.status === 200 && stateBody.ok === true && stateBody.readOnly === true && typeof stateBody.revision === 'string', state.status + ' ' + JSON.stringify(stateBody).slice(0, 120));
    const noCookie = await get('/api/editor?action=state');
    check('/api/editor refuses an anonymous caller', noCookie.status === 401, noCookie.status);
    await noCookie.arrayBuffer();
    const out = await post('/api/editor-logout', {}, { cookie: sealed, origin: BASE });
    check('sign-out works', out.status === 200, out.status);
    await out.arrayBuffer();

    // A webhook with the right secret gets past authentication (then fails on the fake database, which is fine here).
    const authed = await post('/api/store-order-status', { trackingNumber: 'T-1', status: 'processing' }, { 'x-store-webhook-secret': WEBHOOK_SECRET });
    check('the right webhook secret passes authentication', authed.status !== 401 && authed.status !== 503, authed.status + ' ' + (await authed.text()).slice(0, 100));
  } finally {
    fake.close();
  }
}

main().then(() => {
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
}, (e) => {
  console.log('::error title=Worker smoke test::' + String(e && e.stack || e).replace(/[\r\n]+/g, ' ').slice(0, 400));
  process.exit(1);
});
