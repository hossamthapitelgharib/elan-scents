const test = require('node:test');
const assert = require('node:assert/strict');
const editorHost = require('../railway/editor-host.js');
const media = require('../railway/editor-media.js');

// The upload route reads the whole body before checking the file, so it needs a real size limit while reading.
// (It once read `media.MAX_VIDEO_BYTES`, a name editor-media.js did not export, which made the limit NaN: no limit at all.)
// Only pictures come through this route now; a video is uploaded straight to storage (tests/editor-direct-upload.test.js).
test('the editor upload route is cut off one byte over the largest picture, whatever type is claimed', () => {
  assert.equal(typeof media.MAX_BYTES, 'number');
  assert.equal(media.MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(media.MAX_VIDEO_BYTES, 50 * 1024 * 1024, 'the bucket ceiling, applied by Supabase itself');
  for (const type of ['image/png', 'video/mp4', 'text/html']) assert.equal(editorHost.uploadLimit(type), media.MAX_BYTES + 1, type);
  assert.ok(Number.isFinite(editorHost.uploadLimit()) && editorHost.uploadLimit() > 1024 * 1024);
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

test('a video sent to this route is turned away without reading its body', async () => {
  const r = await postUpload('video/mp4', 12);
  assert.equal(r.status, 415);
  assert.deepEqual(r.body, { ok: false, error: 'video_needs_direct_upload' });
  assert.equal(r.seen, 12, 'the test fed the stream, but the route answered at once');
});
