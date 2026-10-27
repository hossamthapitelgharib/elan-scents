const test = require('node:test');
const assert = require('node:assert/strict');
const editorHost = require('../railway/editor-host.js');
const media = require('../railway/editor-media.js');

// The upload route reads the whole body before checking the file, so it needs a real size limit while reading.
// (It once read `media.MAX_VIDEO_BYTES`, a name editor-media.js did not export, which made the limit NaN: no limit at all.
// Videos are supported again, with their own exported limit.)
test('the editor upload is cut off one byte over the largest file allowed for its type', () => {
  assert.equal(typeof media.MAX_BYTES, 'number');
  assert.equal(typeof media.MAX_VIDEO_BYTES, 'number');
  assert.equal(media.MAX_VIDEO_BYTES, 25 * 1024 * 1024);
  assert.equal(editorHost.uploadLimit('image/png'), media.MAX_BYTES + 1);
  assert.equal(editorHost.uploadLimit('video/mp4'), media.MAX_VIDEO_BYTES + 1);
  assert.equal(editorHost.uploadLimit('video/webm'), media.MAX_VIDEO_BYTES + 1);
  assert.equal(editorHost.uploadLimit('text/html'), media.MAX_BYTES + 1, 'an unsupported type gets the small limit and a 415 afterwards');
  assert.equal(editorHost.UPLOAD_LIMIT, media.MAX_VIDEO_BYTES + 1);
  assert.ok(Number.isFinite(editorHost.UPLOAD_LIMIT) && editorHost.UPLOAD_LIMIT > 1024 * 1024);
});

/* Streams `megabytes` of zeros to the upload route as the signed-in owner and returns the answer. */
async function postUpload(contentType, megabytes) {
  const previous = { until: process.env.EDITOR_ACCESS_KEY_UNTIL, bypass: process.env.EDITOR_AUTH_BYPASS, key: process.env.EDITOR_ACCESS_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY, url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY };
  process.env.EDITOR_AUTH_BYPASS = '1';
  process.env.EDITOR_ACCESS_KEY_UNTIL = new Date(Date.now() + 3600 * 1000).toISOString();
  process.env.EDITOR_ACCESS_KEY = 'access-key-fake-phrase-123';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-fake-key-0123456789';
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY;   // an accepted size then stops at "storage not configured", never reaching the network
  try {
    const sessions = require('../railway/editor-session.js');
    const login = sessions.keyLogin(process.env.EDITOR_ACCESS_KEY, '203.0.113.7');
    assert.equal(login.status, 200);
    const { EventEmitter } = require('node:events');
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url: '/api/editor-upload', headers: { cookie: 'elan_sess=' + login.id, host: 'shop.example', origin: 'https://shop.example', 'content-type': contentType }, socket: { remoteAddress: '203.0.113.7' }, destroy() {} });
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { this.body = body; this.done(); } };
    const finished = new Promise((resolve) => { res.done = resolve; });
    const handled = editorHost.handle(req, res, '/api/editor-upload');
    const chunk = Buffer.alloc(1024 * 1024);
    await new Promise((resolve) => setImmediate(resolve));
    let seen = 0;
    for (let i = 0; i < megabytes; i += 1) { req.emit('data', chunk); seen += 1; }
    req.emit('end');
    assert.equal(await handled, true);
    await finished;
    return { status: res.statusCode, body: JSON.parse(res.body), seen };
  } finally {
    for (const [name, key] of [['until', 'EDITOR_ACCESS_KEY_UNTIL'], ['bypass', 'EDITOR_AUTH_BYPASS'], ['key', 'EDITOR_ACCESS_KEY'], ['service', 'SUPABASE_SERVICE_ROLE_KEY'], ['url', 'SUPABASE_URL'], ['anon', 'SUPABASE_ANON_KEY']]) {
      if (previous[name] === undefined) delete process.env[key]; else process.env[key] = previous[name];
    }
  }
}

test('an oversized picture is refused with 413', async () => {
  const r = await postUpload('image/png', 12);
  assert.equal(r.status, 413);
  assert.deepEqual(r.body, { ok: false, error: 'file_too_large' });
});

test('a video of 12 MB is read in full (pictures are cut off at 10), a video over 25 MB is refused with 413', async () => {
  const fits = await postUpload('video/mp4', 12);
  assert.notEqual(fits.status, 413, 'the size is fine; the next check (storage) decides');
  assert.equal(fits.seen, 12);
  const big = await postUpload('video/webm', 27);
  assert.equal(big.status, 413);
  assert.deepEqual(big.body, { ok: false, error: 'file_too_large' });
});
