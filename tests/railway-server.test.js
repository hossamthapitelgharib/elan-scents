const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../railway/server.js');

function listen() { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

test('railway host serves the storefront, API routes, rewrites and blocks private files', async () => {
  const port = await listen();
  const base = 'http://127.0.0.1:' + port;
  try {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/app.js')).status, 200);

    const cfg = await fetch(base + '/api/config');
    assert.equal(cfg.status, 200);
    assert.deepEqual(Object.keys(await cfg.json()).sort(), ['key', 'url']);

    assert.equal((await fetch(base + '/api/no-such-function')).status, 404);
    assert.equal((await fetch(base + '/api/_auth')).status, 404);
    // rewrite alias reaches the same handler as /api/store-order-status
    const a = await fetch(base + '/api/store-order-completed', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const b = await fetch(base + '/api/store-order-status', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(a.status, b.status);

    for (const p of ['/package.json', '/vercel.json', '/api/_auth.js', '/tests/regression.test.js', '/railway/server.js', '/supabase/migrations', '/CLAUDE.md', '/.git/config', '/%2e%2e/etc/passwd']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
    const bad = await fetch(base + '/api/guest-cart', { method: 'POST', body: '{oops', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('railway host supports byte ranges for the hero video', async () => {
  const s = require('http').createServer(server.listeners('request')[0]);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const base = 'http://127.0.0.1:' + s.address().port;
    const full = await fetch(base + '/assets/hero.mp4', { method: 'HEAD' });
    if (full.status !== 200) return; // no video in this checkout
    const part = await fetch(base + '/assets/hero.mp4', { headers: { range: 'bytes=0-9' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
  } finally { s.close(); }
});
