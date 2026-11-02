const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const media = require('../railway/editor-media.js');
const editorHost = require('../railway/editor-host.js');

/* Videos do not pass through the Worker: the server signs an upload address on Supabase Storage, the browser uploads to it, and the
   server then checks the stored file and records it. These tests run that with a fake Supabase (no network, dummy keys). */
const SB = 'https://sb.example.test';
const SIGNED = (p) => '/object/upload/sign/site-media/' + p + '?token=one-time-token';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(240, 2)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(240, 3)]);
const MB = 1024 * 1024;
const PATH_RE = /^uploads\/\d{4}\/[0-9a-f]{20}\.(mp4|webm)$/;

function setEnv() {
  const previous = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY, fetch: global.fetch };
  process.env.SUPABASE_URL = SB; process.env.SUPABASE_ANON_KEY = 'anon-key-fake';
  return () => {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
  };
}
const admin = { token: 'admin-token' };

/* A fake storage + library. `stored` is what the public address returns (bytes and the full size the range answer reports). */
function fakeStorage(opts) {
  opts = opts || {};
  const calls = [];
  global.fetch = async (url, init) => {
    url = String(url); init = init || {};
    const method = init.method || 'GET';
    calls.push({ url, method, headers: init.headers || {}, body: init.body });
    if (opts.unreachable === url) throw new Error('network down');
    let m;
    if (method === 'POST' && (m = /\/storage\/v1\/object\/upload\/sign\/site-media\/(.+)$/.exec(url))) {
      if (opts.signStatus) return { ok: false, status: opts.signStatus, json: async () => ({}) };
      const p = opts.signedUrl || SIGNED(m[1]);
      return { ok: true, status: 200, json: async () => ({ url: p }) };
    }
    if (method === 'GET' && url.startsWith(SB + '/storage/v1/object/public/site-media/')) {
      if (opts.missing) return new Response('{"error":"not_found"}', { status: 404 });
      const st = opts.stored;
      if (opts.ignoreRange) return new Response(st.stream(), { status: 200, headers: { 'content-length': String(st.size) } });
      return new Response(st.bytes.subarray(0, 256), { status: 206, headers: st.size ? { 'content-range': 'bytes 0-255/' + st.size } : {} });
    }
    if (method === 'DELETE' && url.startsWith(SB + '/storage/v1/object/site-media/')) return { ok: true, status: 200, json: async () => ({}) };
    if (method === 'POST' && url === SB + '/rest/v1/media_library') return { ok: !opts.recordFails, status: opts.recordFails ? 403 : 201, json: async () => ({}) };
    throw new Error('unexpected request ' + method + ' ' + url);
  };
  return calls;
}

test('signing a video upload: an admin session, a video type, within the bucket limit, and an address on our own storage', async () => {
  const restore = setEnv();
  try {
    const calls = fakeStorage();
    const r = await media.signVideoUpload(admin, 'video/mp4', 30 * MB);
    assert.equal(r.status, 200);
    assert.match(r.path, PATH_RE);
    assert.ok(r.path.endsWith('.mp4'));
    assert.equal(r.uploadUrl, SB + '/storage/v1' + SIGNED(r.path));
    assert.equal(r.apikey, 'anon-key-fake', 'only the public anon key goes to the browser');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, 'Bearer admin-token', 'signed as the admin session, never with a service key');
    assert.equal(calls[0].body, '{}');
    assert.equal((await media.signVideoUpload(admin, 'video/webm', 50 * MB)).status, 200, 'exactly the bucket limit is fine');
  } finally { restore(); }
});

test('signing refuses before any network call: pictures and other types, empty or oversized files, a missing configuration', async () => {
  const restore = setEnv();
  try {
    const calls = fakeStorage();
    assert.equal(media.MAX_VIDEO_BYTES, 50 * MB, 'the limit is the site-media bucket ceiling, not the Worker');
    for (const type of ['image/png', 'text/html', 'video/quicktime', 'application/octet-stream', '']) assert.equal((await media.signVideoUpload(admin, type, MB)).status, 415, type);
    for (const size of [0, -5, 1.5, NaN, 'abc', undefined, null]) assert.equal((await media.signVideoUpload(admin, 'video/mp4', size)).status, 400, String(size));
    const big = await media.signVideoUpload(admin, 'video/mp4', 50 * MB + 1);
    assert.equal(big.status, 413); assert.equal(big.error, 'file_too_large');
    assert.equal(calls.length, 0);
    delete process.env.SUPABASE_URL;
    assert.equal((await media.signVideoUpload(admin, 'video/mp4', MB)).status, 503);
  } finally { restore(); }
});

test('signing reports storage trouble and never passes on an address that is not our storage for the chosen path', async () => {
  const restore = setEnv();
  try {
    fakeStorage({ signStatus: 403 });
    assert.equal((await media.signVideoUpload(admin, 'video/mp4', MB)).status, 403, 'not an admin');
    fakeStorage({ signStatus: 500 });
    assert.equal((await media.signVideoUpload(admin, 'video/mp4', MB)).status, 502);
    global.fetch = async () => { throw new Error('down'); };
    assert.equal((await media.signVideoUpload(admin, 'video/mp4', MB)).error, 'storage_unreachable');
    for (const signedUrl of ['/object/upload/sign/site-media/uploads/2020/other.mp4?token=t', '/object/upload/sign/other-bucket/x?token=t', '//evil.example/x?token=t', '/object/upload/sign/site-media/uploads/2026/aaaaaaaaaaaaaaaaaaaa.mp4']) {
      fakeStorage({ signedUrl });
      const r = await media.signVideoUpload(admin, 'video/mp4', MB);
      assert.equal(r.status, 502, String(signedUrl));
      assert.equal(r.uploadUrl, undefined);
    }
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });   // an answer with no address at all
    assert.equal((await media.signVideoUpload(admin, 'video/mp4', MB)).status, 502);
  } finally { restore(); }
});

const PATH = 'uploads/2026/0123456789abcdef0123';
const stored = (bytes, size) => ({ bytes, size });

test('finishing a video upload checks the stored file, then records it in the library as a video', async () => {
  const restore = setEnv();
  try {
    const calls = fakeStorage({ stored: stored(MP4, 31 * MB) });
    const r = await media.finishVideoUpload(admin, PATH + '.mp4', 'video/mp4', 'clip.mp4');
    assert.equal(r.status, 200);
    assert.equal(r.url, SB + '/storage/v1/object/public/site-media/' + PATH + '.mp4');
    assert.equal(calls[0].headers.Range, 'bytes=0-255', 'only the start of the file is fetched, never all of it');
    const row = JSON.parse(calls.find((c) => c.url === SB + '/rest/v1/media_library').body);
    assert.equal(row.file_type, 'video'); assert.equal(row.mime_type, 'video/mp4'); assert.equal(row.size_bytes, 31 * MB);
    assert.equal(row.storage_path, PATH + '.mp4'); assert.equal(row.title, 'clip.mp4'); assert.equal(row.source, 'device_upload');
    assert.equal(calls.some((c) => c.method === 'DELETE'), false);
    fakeStorage({ stored: stored(WEBM, 2 * MB) });
    assert.equal((await media.finishVideoUpload(admin, PATH + '.webm', 'video/webm', '')).status, 200);
  } finally { restore(); }
});

test('a stored file that is not the video it claims to be, or is too big, is removed from storage and never recorded', async () => {
  const restore = setEnv();
  try {
    const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(300, ' '));
    for (const [bytes, size, type, status] of [[html, 4000, 'video/mp4', 415], [html, 4000, 'video/webm', 415], [WEBM, 4000, 'video/mp4', 415], [MP4, 50 * MB + 1, 'video/mp4', 413]]) {
      const calls = fakeStorage({ stored: stored(bytes, size) });
      const r = await media.finishVideoUpload(admin, PATH + '.' + (type === 'video/mp4' ? 'mp4' : 'webm'), type, 'x');
      assert.equal(r.status, status, type + ' ' + size);
      assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1, 'the bad file is deleted again');
      assert.equal(calls.some((c) => c.url === SB + '/rest/v1/media_library'), false, 'and not put in the library');
    }
  } finally { restore(); }
});

test('finishing refuses a path that is not one the server issues, a picture type, and a file that is missing or cannot be measured', async () => {
  const restore = setEnv();
  try {
    let calls = fakeStorage({ stored: stored(MP4, MB) });
    for (const p of ['../x.mp4', 'uploads/2026/short.mp4', 'uploads/26/0123456789abcdef0123.mp4', PATH + '.mp4/../..', PATH + '.webm', 'other/2026/0123456789abcdef0123.mp4', PATH.toUpperCase() + '.mp4', null, undefined, 5, {}]) {
      assert.equal((await media.finishVideoUpload(admin, p, 'video/mp4', 'x')).status, 400, String(p));
    }
    assert.equal((await media.finishVideoUpload(admin, PATH + '.png', 'image/png', 'x')).status, 415);
    assert.equal(calls.length, 0, 'refused before any network call');
    calls = fakeStorage({ missing: true });
    const gone = await media.finishVideoUpload(admin, PATH + '.mp4', 'video/mp4', 'x');
    assert.equal(gone.status, 404); assert.equal(gone.error, 'upload_not_found');
    assert.equal(calls.some((c) => c.method === 'DELETE'), false, 'nothing to delete');
    fakeStorage({ stored: stored(MP4, 0) });
    assert.equal((await media.finishVideoUpload(admin, PATH + '.mp4', 'video/mp4', 'x')).error, 'upload_unverifiable');
    fakeStorage({ stored: stored(MP4, MB), recordFails: true });
    assert.equal((await media.finishVideoUpload(admin, PATH + '.mp4', 'video/mp4', 'x')).error, 'library_record_failed');
  } finally { restore(); }
});

test('even when storage ignores the Range header only the first bytes of the file are read', async () => {
  const restore = setEnv();
  try {
    let pulled = 0;
    const big = { size: 40 * MB, stream: () => new ReadableStream({ pull(c) { pulled += 1; c.enqueue(pulled === 1 ? Buffer.concat([MP4, Buffer.alloc(65536)]) : Buffer.alloc(65536)); if (pulled > 600) c.close(); } }) };
    fakeStorage({ stored: big, ignoreRange: true });
    const r = await media.finishVideoUpload(admin, PATH + '.mp4', 'video/mp4', 'x');
    assert.equal(r.status, 200);
    assert.ok(pulled < 5, 'the stream was cancelled after the first chunk, not read to the end (' + pulled + ' reads)');
  } finally { restore(); }
});

test('pictures still go through the server, and a video sent that way is refused before it is read', async () => {
  const restore = setEnv();
  try {
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('must not reach storage'); };
    const r = await media.upload(admin, MP4, 'video/mp4', 'x');
    assert.equal(r.status, 415); assert.equal(r.error, 'video_needs_direct_upload');
    assert.equal(calls, 0);
    assert.equal(editorHost.uploadLimit(), media.MAX_BYTES + 1, 'the server route only ever takes a picture');
  } finally { restore(); }
});

/* The same flow through the real server routes, signed in as an admin. */
const url = (s, p) => 'http://127.0.0.1:' + s.address().port + p;
async function server() { const s = require('../railway/server.js'); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s; }
function fakeSupabase(state) {
  const real = global.fetch;
  global.fetch = async (u, o) => {
    u = String(u); o = o || {};
    if (u.startsWith('http://127.0.0.1')) return real(u, o);
    const method = o.method || 'GET'; state.log.push(method + ' ' + u.replace(SB, ''));
    const reply = (s, j) => ({ ok: s < 300, status: s, json: async () => j, text: async () => '' });
    if (u.startsWith(SB + '/auth/v1/token')) return reply(200, { access_token: 'admin-token', refresh_token: 'ref', expires_in: 3600 });
    if (u.startsWith(SB + '/auth/v1/user')) return reply(200, { id: 'u1', email: 'owner@example.test' });
    if (u.startsWith(SB + '/rest/v1/profiles')) return reply(200, [{ id: 'u1', role: 'platform_admin' }]);
    if (u.startsWith(SB + '/rest/v1/media_library') && method === 'POST') { state.rows.push(JSON.parse(o.body)); return reply(201, {}); }
    let m;
    if (method === 'POST' && (m = /\/storage\/v1\/object\/upload\/sign\/site-media\/(.+)$/.exec(u))) return reply(200, { url: SIGNED(m[1]) });
    if (method === 'GET' && u.startsWith(SB + '/storage/v1/object/public/site-media/')) return new Response(state.file.subarray(0, 256), { status: 206, headers: { 'content-range': 'bytes 0-255/' + state.size } });
    if (method === 'DELETE') return reply(200, {});
    throw new Error('unexpected ' + method + ' ' + u);
  };
  return () => { global.fetch = real; };
}
async function login(s) {
  const r = await fetch(url(s, '/api/editor-login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password: 'right' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test('the sign and done routes need an admin session, the same origin and a JSON body; the old route turns videos away', async () => {
  const restoreEnv = setEnv(); process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-fake-key-0123456789';
  const state = { log: [], rows: [], file: WEBM, size: 12 * MB };
  const restore = fakeSupabase(state); const s = await server();
  const post = (p, body, headers) => fetch(url(s, p), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    for (const p of ['/api/editor-upload-sign', '/api/editor-upload-done']) assert.equal((await post(p, {})).status, 401, p + ' without a session');
    const cookie = await login(s);
    assert.equal((await post('/api/editor-upload-sign', { type: 'video/webm', size: MB }, { cookie, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(url(s, '/api/editor-upload-sign'), { headers: { cookie } })).status, 403, 'GET is not allowed');
    assert.equal((await post('/api/editor-upload-sign', 'not json', { cookie })).status, 400);
    assert.equal((await post('/api/editor-upload-sign', { type: 'image/png', size: MB }, { cookie })).status, 415);
    assert.equal((await post('/api/editor-upload-sign', { type: 'video/webm', size: 60 * MB }, { cookie })).status, 413);

    const sign = await post('/api/editor-upload-sign', { type: 'video/webm', size: 12 * MB }, { cookie });
    assert.equal(sign.status, 200);
    const signed = await sign.json();
    assert.equal(signed.ok, true); assert.match(signed.path, PATH_RE);
    assert.equal(signed.uploadUrl, SB + '/storage/v1' + SIGNED(signed.path)); assert.equal(signed.apikey, 'anon-key-fake');
    assert.equal(JSON.stringify(signed).includes('service-fake-key'), false, 'no service key reaches the browser');

    // (the browser uploads to signed.uploadUrl here; the fake storage already "holds" the file)
    const done = await post('/api/editor-upload-done', { path: signed.path, type: 'video/webm', name: 'مقطع.webm' }, { cookie });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).url, SB + '/storage/v1/object/public/site-media/' + signed.path);
    assert.equal(state.rows.length, 1); assert.equal(state.rows[0].file_type, 'video'); assert.equal(state.rows[0].size_bytes, 12 * MB); assert.equal(state.rows[0].title, 'مقطع.webm');

    state.file = Buffer.from('<html>not a video</html>'.padEnd(300, ' '));
    const fake = await post('/api/editor-upload-done', { path: signed.path, type: 'video/webm', name: 'evil.webm' }, { cookie });
    assert.equal(fake.status, 415); assert.equal((await fake.json()).error, 'file_does_not_match_type');
    assert.equal(state.rows.length, 1, 'a fake video is not recorded');
    assert.ok(state.log.some((l) => l.startsWith('DELETE /storage/v1/object/site-media/')), 'and is removed from storage');
    assert.equal((await post('/api/editor-upload-done', { path: '../../etc/passwd', type: 'video/webm' }, { cookie })).status, 400);

    state.log.length = 0;
    const old = await fetch(url(s, '/api/editor-upload'), { method: 'POST', headers: { cookie, 'Content-Type': 'video/mp4' }, body: MP4 });
    assert.equal(old.status, 415); assert.equal((await old.json()).error, 'video_needs_direct_upload');
    assert.equal(state.log.some((l) => l.includes('/storage/')), false, 'nothing was sent to storage');
  } finally { restore(); restoreEnv(); delete process.env.SUPABASE_SERVICE_ROLE_KEY; s.close(); }
});

test('the editor page may connect to our Supabase storage (for the video upload) and nowhere else outside the site', () => {
  const restore = setEnv();
  try {
    const csp = editorHost.buildPage().csp;
    assert.match(csp, new RegExp("connect-src 'self' " + SB.replace(/\./g, '\\.') + ';'));
    assert.doesNotMatch(csp, /connect-src[^;]*\*/);
    delete process.env.SUPABASE_URL;
    assert.match(editorHost.buildPage().csp, /connect-src 'self';/);
  } finally { restore(); }
});

test('the picker sends a video to the signed address with the public key, shows progress, and keeps pictures on the server route', () => {
  const picker = fs.readFileSync(path.join(__dirname, '..', 'editor', 'editor-media.js'), 'utf8');
  assert.match(picker, /\/api\/editor-upload-sign/); assert.match(picker, /\/api\/editor-upload-done/);
  assert.match(picker, /x\.open\('PUT', s\.uploadUrl\)/);
  assert.match(picker, /setRequestHeader\('apikey', s\.apikey\)/);
  assert.match(picker, /x\.upload\.onprogress/);
  assert.match(picker, /isVideo \? 50 : 10\) \* 1024 \* 1024/);
  assert.match(picker, /fetch\('\/api\/editor-upload', \{ method: 'POST'/, 'a picture still goes through the server');
  assert.doesNotMatch(picker, /service|supabase\.co|localStorage|sessionStorage/);
});
