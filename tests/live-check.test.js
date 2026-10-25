'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probe, summarize } = require('../scripts/live-check.js');

/* A fake site that answers like the Worker does, with or without its service-role key and webhook secret. */
function fakeSite({ serviceKey, webhookSecret, csp = "default-src 'self'; script-src 'self'; script-src-attr 'none'", inlineScript = false }) {
  return http.createServer((req, res) => {
    req.resume();
    const send = (status, body, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers)); res.end(body); };
    if (req.url === '/health') return send(200, 'ok', { 'Content-Type': 'text/plain' });
    if (req.url === '/api/config') return send(200, JSON.stringify({ url: 'https://example.supabase.co', key: 'public-anon' }));
    if (req.url === '/') return send(200, '<html lang="ar">' + (inlineScript ? '<script>alert(1)</script>' : '<script src="/hero-video.js"></script>') + '</html>', Object.assign({ 'Content-Type': 'text/html' }, csp ? { 'Content-Security-Policy': csp } : {}));
    if (/^\/(index|account|dashboard|store-dashboard|platform-dashboard)\.html$/.test(req.url)) return send(200, '<html></html>', Object.assign({ 'Content-Type': 'text/html' }, csp ? { 'Content-Security-Policy': csp } : {}));
    if (req.url === '/hero-video.js') return send(200, "document.getElementById('heroVideo')", { 'Content-Type': 'text/javascript' });
    if (req.url === '/api/customer-orders') return serviceKey ? send(401, '{"error":"unauthorized"}') : send(503, '{"error":"supabase_service_configuration_missing"}');
    if (req.url === '/api/store-order-status') return webhookSecret ? send(401, '{"error":"unauthorized"}') : send(503, '{"error":"webhook_secret_not_configured"}');
    if (req.url === '/editor') return send(200, '<html></html>', { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' });
    if (req.url.startsWith('/api/editor')) return send(401, '{"error":"unauthorized"}');
    if (req.url === '/assets/hero.mp4') return send(req.headers.range ? 206 : 200, 'x');
    return send(404, '{}');
  });
}

async function runAgainst(options) {
  const server = fakeSite(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    // The script only accepts https addresses; the fake site is plain http, so route the same paths to it.
    const base = 'http://127.0.0.1:' + server.address().port;
    return await probe(base);
  } finally { server.close(); }
}

test('a healthy site with its service-role key passes, an unset webhook secret is only a note', async () => {
  const results = await runAgainst({ serviceKey: true, webhookSecret: false });
  assert.equal(summarize(results).ok, true, JSON.stringify(results.filter((r) => !r.ok)));
  const hook = results.find((r) => r.name === 'STORE_ORDER_WEBHOOK_SECRET');
  assert.equal(hook.kind, 'info');
  assert.match(hook.detail, /not set/);
});

test('a Worker without SUPABASE_SERVICE_ROLE_KEY fails the check and says it is missing', async () => {
  const results = await runAgainst({ serviceKey: false, webhookSecret: false });
  const summary = summarize(results);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failed.map((r) => r.name), ['SUPABASE_SERVICE_ROLE_KEY is set on the Worker']);
  assert.match(summary.failed[0].detail, /missing/);
});

test('a webhook secret that is set shows up as set', async () => {
  const results = await runAgainst({ serviceKey: true, webhookSecret: true });
  assert.match(results.find((r) => r.name === 'STORE_ORDER_WEBHOOK_SECRET').detail, /^set/);
});

test('an unreachable site fails every required check instead of throwing', async () => {
  const results = await probe('http://127.0.0.1:1', undefined);
  assert.equal(summarize(results).ok, false);
  assert.ok(results.every((r) => typeof r.detail === 'string'));
});

test('a storefront without the page policy, with unsafe-inline scripts or with an inline script fails the check', async () => {
  for (const options of [{ csp: '' }, { csp: "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'" }, { csp: "default-src 'self'; script-src 'self'" }, { inlineScript: true }]) {
    const results = await runAgainst(Object.assign({ serviceKey: true, webhookSecret: false }, options));
    const summary = summarize(results);
    assert.equal(summary.ok, false, JSON.stringify(options));
    assert.ok(summary.failed.map((r) => r.name).includes('the storefront is served with a Content-Security-Policy that allows scripts from the site itself only'), JSON.stringify(options));
  }
});

test('a page that lost its policy (a missing _headers rule) fails the check even when the root address has it', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    const csp = { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; script-src-attr 'none'" };
    const send = (status, body, headers) => { res.writeHead(status, Object.assign({ 'Content-Type': 'text/html' }, headers)); res.end(body); };
    if (req.url === '/') return send(200, '<html lang="ar"></html>', csp);
    if (req.url === '/account.html') return send(200, '<html></html>', {});
    if (/\.html$/.test(req.url)) return send(200, '<html></html>', csp);
    send(404, '{}', {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const results = await probe('http://127.0.0.1:' + server.address().port);
    const row = results.find((r) => r.name === 'every page carries the same Content-Security-Policy');
    assert.equal(row.ok, false);
    assert.match(row.detail, /\/account\.html/);
    assert.doesNotMatch(row.detail, /\/dashboard\.html/);
  } finally { server.close(); }
});
