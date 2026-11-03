'use strict';
/* Bounded local load/stress checks. These spawn the Railway server on loopback only;
   they never contact the live shop, Supabase, GitHub, or any external service. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'railway', 'server.js');
const REQUESTS = Number(process.env.LOAD_REQUESTS || 240);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 24);
const MAX_P95_MS = Number(process.env.LOAD_MAX_P95_MS || 2500);
let child;
let base;

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.unref();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try {
      const response = await fetch(url);
      if (response.status === 200 && (await response.text()) === 'ok') return;
    } catch (_) { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('local load-test server did not become healthy');
}

async function one(pathname) {
  const started = performance.now();
  try {
    const response = await fetch(base + pathname, { headers: { 'x-load-test': 'local-only' } });
    const body = await response.text();
    return { pathname, status: response.status, bytes: Buffer.byteLength(body), ms: performance.now() - started };
  } catch (error) {
    return { pathname, status: 0, bytes: 0, ms: performance.now() - started, error: String(error.message || error) };
  }
}

async function burst(paths, total = REQUESTS, concurrency = CONCURRENCY) {
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= total) return;
      results[index] = await one(paths[index % paths.length]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return results;
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function assertHealthy(results, expected) {
  assert.equal(results.length, expected);
  assert.ok(results.every((r) => r.status > 0), 'no request should fail at the transport layer: ' + JSON.stringify(results.find((r) => r.status === 0)));
  const p95 = percentile(results.map((r) => r.ms), 0.95);
  assert.ok(p95 <= MAX_P95_MS, `p95 ${p95.toFixed(1)}ms exceeded ${MAX_P95_MS}ms`);
  return p95;
}

test.before(async () => {
  const port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      PORT: String(port),
      SUPABASE_URL: 'https://load-test.supabase.invalid',
      SUPABASE_ANON_KEY: 'load-test-public-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  base = 'http://127.0.0.1:' + port;
  try {
    await waitForHealth(base + '/health');
  } catch (error) {
    child.kill();
    throw new Error(error.message + '\n' + output.slice(-1000));
  }
});

test.after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
});

test('health endpoint survives a bounded concurrent burst', async () => {
  const results = await burst(['/health']);
  const p95 = assertHealthy(results, REQUESTS);
  assert.ok(results.every((r) => r.status === 200 && r.bytes === 2));
  console.log(`load health: ${REQUESTS} requests, concurrency ${CONCURRENCY}, p95 ${p95.toFixed(1)}ms`);
});

test('mixed public traffic remains available under bounded stress', async () => {
  const paths = ['/health', '/', '/api/config', '/does-not-exist'];
  const results = await burst(paths, Math.max(120, Math.floor(REQUESTS / 2)), Math.max(8, Math.floor(CONCURRENCY / 2)));
  const p95 = assertHealthy(results, Math.max(120, Math.floor(REQUESTS / 2)));
  for (const result of results) {
    assert.ok([200, 404].includes(result.status), `${result.pathname} returned ${result.status}`);
    if (result.pathname === '/health' || result.pathname === '/' || result.pathname === '/api/config') assert.equal(result.status, 200);
    if (result.pathname === '/does-not-exist') assert.equal(result.status, 404);
  }
  console.log(`stress mixed: ${results.length} requests, p95 ${p95.toFixed(1)}ms`);
});
