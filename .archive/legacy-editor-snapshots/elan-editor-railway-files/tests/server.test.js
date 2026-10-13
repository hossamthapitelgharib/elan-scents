const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function start(port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, PORT: String(port) } });
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
    p.on('error', reject);
  });
}

test('health check answers, unknown paths 404, and the editor refuses anonymous callers', async () => {
  const port = 38000 + Math.floor(Math.random() * 1000);
  const p = await start(port);
  try {
    const base = 'http://127.0.0.1:' + port;
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/nope')).status, 404);
    const r = await fetch(base + '/api/editor');
    assert.ok(r.status === 401 || r.status === 503);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const big = await fetch(base + '/api/editor', { method: 'POST', body: 'x'.repeat(500000) });
    assert.equal(big.status, 413);
  } finally { p.kill(); }
});
