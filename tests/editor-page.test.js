const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('production editor lives under editor/ and is gated by login', () => {
  const page = read('editor/elan-editor.html');
  const login = read('editor/editor-login.js');
  const loginHtml = read('editor/login.html');
  const guard = read('editor/editor-guard.js');

  assert.match(page, /elan-editor-bridge\/v1/);
  assert.match(page, /noindex/);
  assert.match(loginHtml, /دخول المالكة/);
  assert.match(loginHtml, /editor-login\.js/);
  assert.doesNotMatch(login, /localStorage|sessionStorage|document\.cookie/);
  assert.match(guard, /editor-logout/);
  assert.match(guard, /editor-session/);
});

test('edit mode loads only for the editor iframe and never for customers', () => {
  const boot = read('edit-boot.js');
  const index = read('index.html');
  assert.match(boot, /elan_editor/);
  assert.match(boot, /window\.parent === window/);
  assert.match(boot, /edit-mode\.js/);
  assert.match(index, /edit-boot\.js\?v=/);
  assert.doesNotMatch(index, /edit-mode\.js|elan-host-bridge\.js|edit-model\.js/);
});

test('edit-mode uses same-origin bridge and confirms server-side saves', () => {
  const mode = read('edit-mode.js');
  assert.match(mode, /allowedEditorOrigins:\s*\[location\.origin\]/);
  assert.doesNotMatch(mode, /allowedEditorOrigins:\s*\[\s*'\*'/);
  assert.match(mode, /expectedRevision/);
  assert.match(mode, /page\.save/);
  assert.doesNotMatch(mode, /localStorage|sessionStorage|document\.cookie|eval\(|new Function/);
});

test('vercel.json no longer routes /editor to the deleted prototype', () => {
  const cfg = JSON.parse(read('vercel.json'));
  const rewrites = (cfg.rewrites || []).map((r) => r.source + '->' + r.destination).join(' ');
  assert.doesNotMatch(rewrites, /\/editor->\/editor\.html/);
  const src = (cfg.headers || []).map((h) => h.source).join(' ');
  assert.doesNotMatch(src, /editor\.html/);
  assert.doesNotMatch(src, /edit-host\.js/);
  for (const f of ['edit-boot.js', 'edit-mode.js', 'edit-model.js', 'elan-host-bridge.js']) {
    assert.ok(src.includes(f), f + ' should stay in no-store headers');
  }
});

test('railway host serves the owner login page at /editor', async () => {
  const server = require('../railway/server.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/editor');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(await res.text(), /editor-login\.js/);
  } finally {
    server.close();
  }
});
