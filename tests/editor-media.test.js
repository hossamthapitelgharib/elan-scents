const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

const SB = 'https://sb.example.test';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
function env() { process.env.SUPABASE_URL = SB; process.env.SUPABASE_ANON_KEY = 'anon'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; }
function start() { const s = require('../railway/server.js'); return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s))); }
const url = (s, p) => 'http://127.0.0.1:' + s.address().port + p;

function fakeSupabase(log, opts) {
  opts = opts || {};
  const real = global.fetch;
  global.fetch = async (u, o) => {
    u = String(u);
    if (u.startsWith('http://127.0.0.1')) return real(u, o);
    log.push({ url: u, method: (o && o.method) || 'GET', auth: o && o.headers && o.headers.Authorization });
    let r = { s: 200, j: {} };
    if (u.startsWith(SB + '/auth/v1/token')) r = { s: 200, j: { access_token: 'admin-token', refresh_token: 'ref', expires_in: 3600 } };
    else if (u.startsWith(SB + '/auth/v1/user')) r = { s: 200, j: { id: 'u1', email: 'owner@example.test' } };
    else if (u.startsWith(SB + '/rest/v1/profiles')) r = { s: 200, j: [{ id: 'u1', role: 'platform_admin' }] };
    else if (u.startsWith(SB + '/rest/v1/media_library') && (!o || !o.method || o.method === 'GET')) r = { s: 200, j: [{ id: '1', file_url: SB + '/storage/v1/object/public/site-media/uploads/2026/a.png', title: 'a', category: 'banners' }] };
    else if (u.startsWith(SB + '/rest/v1/media_library')) r = { s: opts.recordFails ? 403 : 201, j: {} };
    else if (u.startsWith(SB + '/storage/v1/object/site-media/')) r = { s: opts.storageFails ? 403 : 200, j: { Key: 'ok' } };
    return { ok: r.s < 300, status: r.s, json: async () => r.j, text: async () => '' };
  };
  return () => { global.fetch = real; };
}
async function login(s) {
  const r = await fetch(url(s, '/api/editor-login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password: 'right' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

test('media library and upload need an admin session and use that session, never a service key', async () => {
  env(); const log = []; const restore = fakeSupabase(log); const s = await start();
  try {
    assert.equal((await fetch(url(s, '/api/editor-media'))).status, 401);
    assert.equal((await fetch(url(s, '/api/editor-upload'), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })).status, 401);
    const cookie = await login(s);
    const lib = await fetch(url(s, '/api/editor-media?offset=0'), { headers: { cookie } });
    assert.equal(lib.status, 200);
    const j = await lib.json();
    assert.equal(j.items.length, 1); assert.match(j.items[0].url, /site-media/);
    const up = await fetch(url(s, '/api/editor-upload'), { method: 'POST', headers: { cookie, 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('صورة.png') }, body: PNG });
    assert.equal(up.status, 200);
    const out = await up.json();
    assert.match(out.url, /^https:\/\/sb\.example\.test\/storage\/v1\/object\/public\/site-media\/uploads\/\d{4}\/[0-9a-f]{20}\.png$/);
    const calls = log.filter((c) => /storage|media_library/.test(c.url));
    assert.ok(calls.length >= 3 && calls.every((c) => c.auth === 'Bearer admin-token'), 'every media call uses the admin session');
    assert.equal(calls.some((c) => c.auth === 'Bearer service'), false);
  } finally { restore(); s.close(); }
});

test('uploads are checked: only real images, size-limited, same-origin, and a failed record is reported', async () => {
  env(); const log = []; let restore = fakeSupabase(log); const s = await start();
  try {
    const cookie = await login(s);
    const send = (type, body, extra) => fetch(url(s, '/api/editor-upload'), { method: 'POST', headers: Object.assign({ cookie, 'Content-Type': type }, extra || {}), body });
    assert.equal((await send('text/html', '<script>')).status, 415);
    assert.equal((await send('image/png', Buffer.from('not really a png at all'))).status, 415);
    assert.equal((await send('image/png', Buffer.alloc(0))).status, 400);
    assert.equal((await send('image/png', Buffer.alloc(10 * 1024 * 1024 + 5, 1))).status, 413);
    assert.equal((await send('image/png', PNG, { Origin: 'https://evil.example' })).status, 403);
    restore(); restore = fakeSupabase(log, { storageFails: true });
    assert.equal((await send('image/png', PNG)).status, 403);
    restore(); restore = fakeSupabase(log, { recordFails: true });
    const half = await send('image/png', PNG);
    assert.equal(half.status, 502); assert.equal((await half.json()).error, 'library_record_failed');
  } finally { restore(); s.close(); }
});

test('the editor window hands media tools to its own picker', () => {
  const html = fs.readFileSync(path.join(root, 'editor/elan-editor.html'), 'utf8');
  const picker = fs.readFileSync(path.join(root, 'editor/editor-media.js'), 'utf8');
  const mode = fs.readFileSync(path.join(root, 'edit-mode.js'), 'utf8');
  assert.match(html, /t\.ui==='media'&&window\.elanLiveMedia/);
  assert.match(html, /t\.ui==='media_new'&&window\.elanLiveMediaNew/);
  assert.match(picker, /\/api\/editor-upload/);
  assert.doesNotMatch(picker, /localStorage|sessionStorage|supabase\.co/);
  assert.match(mode, /id: 'create_banner', label: 'إنشاء بانر صورة أو فيديو', ui: 'media_new'/);
  assert.match(mode, /id: 'create_image'/);
});
