const test = require('node:test');
const assert = require('node:assert/strict');
const editorHost = require('../railway/editor-host.js');
const media = require('../railway/editor-media.js');

// The upload route reads the whole body before checking the image, so it needs a real size limit while reading.
// (It once read `media.MAX_VIDEO_BYTES`, a name editor-media.js does not export, which made the limit NaN: no limit at all.)
test('the editor upload is cut off one byte over the largest allowed image', () => {
  assert.equal(typeof media.MAX_BYTES, 'number');
  assert.equal(editorHost.UPLOAD_LIMIT, media.MAX_BYTES + 1);
  assert.ok(Number.isFinite(editorHost.UPLOAD_LIMIT) && editorHost.UPLOAD_LIMIT > 1024 * 1024);
});

test('an oversized upload is refused with 413', async () => {
  const previous = { until: process.env.EDITOR_ACCESS_KEY_UNTIL, bypass: process.env.EDITOR_AUTH_BYPASS, key: process.env.EDITOR_ACCESS_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.EDITOR_AUTH_BYPASS = '1';
  process.env.EDITOR_ACCESS_KEY_UNTIL = new Date(Date.now() + 3600 * 1000).toISOString();
  process.env.EDITOR_ACCESS_KEY = 'access-key-fake-phrase-123';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-fake-key-0123456789';
  try {
    const sessions = require('../railway/editor-session.js');
    const login = sessions.keyLogin(process.env.EDITOR_ACCESS_KEY, '203.0.113.7');
    assert.equal(login.status, 200);
    const { EventEmitter } = require('node:events');
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url: '/api/editor-upload', headers: { cookie: 'elan_sess=' + login.id, host: 'shop.example', origin: 'https://shop.example', 'content-type': 'image/png' }, socket: { remoteAddress: '203.0.113.7' }, destroy() {} });
    let seen = 0;
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { this.body = body; this.done(); } };
    const finished = new Promise((resolve) => { res.done = resolve; });
    const handled = editorHost.handle(req, res, '/api/editor-upload');
    // Stream more than the limit; the host must answer without waiting for the rest.
    const chunk = Buffer.alloc(1024 * 1024);
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 12; i += 1) { req.emit('data', chunk); seen += 1; }
    req.emit('end');
    assert.equal(await handled, true);
    await finished;
    assert.equal(res.statusCode, 413);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'file_too_large' });
    assert.ok(seen >= 11);
  } finally {
    for (const [name, key] of [['until', 'EDITOR_ACCESS_KEY_UNTIL'], ['bypass', 'EDITOR_AUTH_BYPASS'], ['key', 'EDITOR_ACCESS_KEY'], ['service', 'SUPABASE_SERVICE_ROLE_KEY']]) {
      if (previous[name] === undefined) delete process.env[key]; else process.env[key] = previous[name];
    }
  }
});
