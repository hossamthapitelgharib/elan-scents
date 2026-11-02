const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function start(port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'railway', 'server.js')], {
      env: { PATH: process.env.PATH, PORT: String(port) }
    });
    p.stdout.on('data', (data) => {
      if (String(data).includes('listening')) resolve(p);
    });
    p.on('error', reject);
  });
}

test('Railway serves only the allow-listed editor geometry asset, not the private editor page', async () => {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const server = await start(port);
  try {
    const base = 'http://127.0.0.1:' + port;
    const asset = await fetch(base + '/editor/editor-geometry.js?v=20261016-04');
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /ElanEditorGeometry/);
    assert.equal((await fetch(base + '/editor/elan-editor.html')).status, 404);
  } finally {
    server.kill();
  }
});

/* ---- caching and compression ---- */
const zlibNode = require('node:zlib');
async function withServer(fn) {
  const srv = require('../railway/server.js');
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try { await fn(base); } finally { srv.close(); }
}

test('static files carry validators and answer a repeat request with 304', async () => {
  await withServer(async (base) => {
    const first = await fetch(base + '/app-core.js');
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.match(etag, /^W\/"/);
    assert.ok(first.headers.get('last-modified'));
    await first.arrayBuffer();
    const again = await fetch(base + '/app-core.js', { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal((await again.arrayBuffer()).byteLength, 0);
    const byDate = await fetch(base + '/app-core.js', { headers: { 'If-Modified-Since': first.headers.get('last-modified') } });
    assert.equal(byDate.status, 304);
    const changed = await fetch(base + '/app-core.js', { headers: { 'If-None-Match': 'W/"other"' } });
    assert.equal(changed.status, 200);
  });
});

test('versioned scripts and styles are immutable, fonts are immutable, images are cached for an hour, unlisted files revalidate', async () => {
  await withServer(async (base) => {
    const cc = async (p) => (await fetch(base + p)).headers.get('cache-control');
    assert.equal(await cc('/app-core.js'), 'public, max-age=31536000, immutable');
    assert.equal(await cc('/style.css'), 'public, max-age=31536000, immutable');
    assert.match(await cc('/index.html'), /no-store/);
    assert.match(await cc('/assets/fonts/ibm-plex-sans-arabic-400.woff2'), /max-age=31536000, immutable/);
    assert.match(await cc('/assets/footer-background.webp'), /max-age=3600/);
    assert.equal(await cc('/vendor/thumbmark.js'), 'no-cache', 'a file with no rule is never left to browser guesswork');
  });
});

test('text files are compressed when the browser accepts it, binary files and ranges are not', async () => {
  await withServer(async (base) => {
    const plain = await (await fetch(base + '/app-core.js', { headers: { 'Accept-Encoding': 'identity' } })).arrayBuffer();
    const br = await fetch(base + '/app-core.js', { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(br.headers.get('vary'), 'Accept-Encoding');
    // fetch() decodes for us, so check the wire size through a raw request
    const raw = await new Promise((resolve, reject) => require('node:http').get(base + '/app-core.js', { headers: { 'Accept-Encoding': 'br, gzip' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) })); res.on('error', reject);
    }));
    assert.equal(raw.res.headers['content-encoding'], 'br');
    assert.equal(Number(raw.res.headers['content-length']), raw.body.length);
    assert.ok(raw.body.length < plain.byteLength / 2, 'compressed to under half');
    assert.equal(zlibNode.brotliDecompressSync(raw.body).length, plain.byteLength, 'decodes to the same bytes');
    const gz = await new Promise((resolve) => require('node:http').get(base + '/app-core.js', { headers: { 'Accept-Encoding': 'gzip' } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ res, body: Buffer.concat(c) })); }));
    assert.equal(gz.res.headers['content-encoding'], 'gzip');
    assert.equal(zlibNode.gunzipSync(gz.body).length, plain.byteLength);
    const none = await fetch(base + '/app-core.js', { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(none.headers.get('content-encoding'), null);
    const ranged = await new Promise((resolve) => require('node:http').get(base + '/app-core.js', { headers: { 'Accept-Encoding': 'br', Range: 'bytes=0-9' } }, (res) => { res.resume(); res.on('end', () => resolve(res)); }));
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.headers['content-encoding'], undefined, 'a byte range is never compressed');
    const font = await new Promise((resolve) => require('node:http').get(base + '/assets/fonts/el-messiri-400.woff2', { headers: { 'Accept-Encoding': 'br, gzip' } }, (res) => { res.resume(); res.on('end', () => resolve(res)); }));
    assert.equal(font.headers['content-encoding'], undefined, 'already-compressed formats are sent as they are');
  });
});
