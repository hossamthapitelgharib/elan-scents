'use strict';
/* Real-Chromium harness (Playwright): runs the real Node server on a free port with throw-away values,
   and opens https://elan.test in the browser, which is routed to that server (so the editor's HTTPS-only
   cookie and origin checks behave as they do on the live Worker). Nothing here reaches the live site,
   Supabase or GitHub: the browser's Supabase calls are answered with empty lists, and the server cannot
   open any outside connection (offline-fetch.js).
   Run with: npm run test:browser (needs `npx playwright install chromium` once). */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const SITE = 'https://elan.test';
const ACCESS_KEY = 'browser-test-key-0123456789';          // a throw-away value that only this local server knows
const SUPABASE_HOST = 'sbgdtuqfrnfeggkwqtrw.supabase.co';
const WIDTHS = [{ name: 'phone', width: 390, height: 844 }, { name: 'tablet', width: 820, height: 1180 }, { name: 'laptop', width: 1366, height: 768 }];

function loadPlaywright() { try { return require('playwright'); } catch (_) { return null; } }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer() {
  const port = await freePort();
  const until = new Date(Date.now() + 2 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port),
    NODE_OPTIONS: '--require=' + path.join(__dirname, 'offline-fetch.js'),
    EDITOR_AUTH_BYPASS: '1', EDITOR_ACCESS_KEY: ACCESS_KEY, EDITOR_ACCESS_KEY_UNTIL: until,
    EDITOR_TARGET_BRANCH: 'browser-test', EDITOR_SITE_ORIGIN: SITE,
    SUPABASE_URL: 'https://' + SUPABASE_HOST, SUPABASE_ANON_KEY: 'anon-dummy-not-real', SUPABASE_SERVICE_ROLE_KEY: 'dummy-not-real-0000000000'
  };
  const child = spawn(process.execPath, ['railway/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const local = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('the test server stopped: ' + log.slice(-400));
    try { const r = await fetch(local + '/health'); if (r.ok) break; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
    if (i === 99) { child.kill(); throw new Error('the test server did not start: ' + log.slice(-400)); }
  }
  return { local, port, stop: () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(); }) };
}

const FORWARDED = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'elan.test' };

/* A browser context whose https://elan.test goes to the local server and whose Supabase answers with empty lists. */
async function openContext(browser, server, size) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'ar-EG', deviceScaleFactor: 1 });
  const problems = [];
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === 'elan.test') {
      const headers = Object.assign({}, request.headers(), FORWARDED); delete headers.host;
      try { return await route.fulfill({ response: await route.fetch({ url: server.local + url.pathname + url.search, headers, maxRedirects: 0 }) }); }
      catch (e) { problems.push('local server: ' + request.url() + ' ' + e.message); return route.abort(); }
    }
    if (url.hostname === SUPABASE_HOST) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (/^\/rest\/v1\//.test(url.pathname)) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: 204, body: '' });       // fonts and anything else outside: never reach the network
  });
  return { context, problems };
}

/* Errors the page itself raises: uncaught exceptions and console errors. A failed request is not one of them. */
function watchErrors(page, sink) {
  page.on('pageerror', (e) => sink.push('pageerror: ' + String(e.message).slice(0, 240)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) sink.push('console.error: ' + m.text().slice(0, 240)); });
}

async function loginAsOwner(context, server) {
  const r = await fetch(server.local + '/editor?key=' + ACCESS_KEY, { redirect: 'manual', headers: FORWARDED });
  const m = /elan_sess=([0-9a-f]+)/.exec(r.headers.get('set-cookie') || '');
  if (!m) throw new Error('the owner key did not open a session (status ' + r.status + ')');
  await context.addCookies([{ name: 'elan_sess', value: m[1], domain: 'elan.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
}

module.exports = { SITE, WIDTHS, loadPlaywright, startServer, openContext, watchErrors, loginAsOwner };
