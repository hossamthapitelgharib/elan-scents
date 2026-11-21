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

 function loadPlaywright() { return require('playwright'); }

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
      catch (e) {
        problems.push('local server: ' + request.url() + ' ' + e.message);
        // route.fetch/route.fulfill may have completed while the page/context is closing.
        // Never call a second terminal operation: Playwright reports "Route is already handled".
        if (typeof route.isHandled === 'function' && route.isHandled()) return;
        try { return await route.abort(); } catch (abortError) {
          if (!/already handled/i.test(String(abortError && abortError.message))) throw abortError;
          return;   // already handled: falling through would fulfill the same route a second time
        }
      }
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

/* A route callback can still settle while a page/context is being closed. Keep that
   teardown race from becoming an unhandled rejection, but never hide real failures. */
function safeFulfill(route, options) {
  return route.fulfill(options).catch((error) => {
    if (/already handled/i.test(String(error && error.message))) return undefined;
    throw error;
  });
}

/* The editor limits key logins to 10 per address per 15 minutes. A test file that opens the editor more than ten times would hit that limit
   (it did, at the eleventh), so each login comes from its own made-up address, like ten different phones would. */
let loginSeq = 0;
async function loginAsOwner(context, server) {
  const r = await fetch(server.local + '/editor?key=' + ACCESS_KEY, { redirect: 'manual', headers: Object.assign({ 'x-forwarded-for': '10.20.30.' + (++loginSeq % 250 + 1) }, FORWARDED) });
  const m = /elan_sess=([A-Za-z0-9._~-]+)/.exec(r.headers.get('set-cookie') || '');
  if (!m) throw new Error('the owner key did not open a session (status ' + r.status + ')');
  await context.addCookies([{ name: 'elan_sess', value: m[1], domain: 'elan.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
}

/* Wait until a page (or the platform frame inside the editor) has stopped changing, instead of sleeping a fixed second and a half after every load: the height and width of the page, how many
   elements and loaded pictures it has, the font state and the root classes (hero-pending and the like) must be the same on several samples in a row, and in the editor the frame's own box too.
   It returns as soon as that holds (normally a few hundred milliseconds), never before `min`, and gives up quietly after `max` like the sleep it replaces (the test's own checks follow). */
const QUIET_SIGNATURE = () => {
  const d = document, de = d.documentElement;
  return [de.scrollHeight, de.scrollWidth, d.getElementsByTagName('*').length, Array.from(d.images).filter((i) => i.complete).length, d.fonts ? d.fonts.status : '', de.className, d.body ? d.body.className : ''].join('|');
};
async function quiet(page, frame, options) {
  const o = Object.assign({ min: 500, max: 6000, same: 4, step: 100 }, options || {}), started = Date.now();
  let last = null, run = 0;
  while (Date.now() - started < o.max) {
    const inner = await (frame || page).evaluate(QUIET_SIGNATURE).catch(() => 'x');
    let outer = '';
    if (frame) { const b = await page.locator('iframe').first().boundingBox().catch(() => null); outer = b ? [b.x, b.y, b.width, b.height].join(',') : ''; }
    const now = inner + '#' + outer;
    run = now === last ? run + 1 : 0; last = now;
    if (run >= o.same - 1 && Date.now() - started >= o.min) return;
    await page.waitForTimeout(o.step);
  }
}

module.exports = { SITE, WIDTHS, loadPlaywright, startServer, openContext, watchErrors, safeFulfill, loginAsOwner, quiet };
