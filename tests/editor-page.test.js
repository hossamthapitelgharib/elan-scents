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
  const boot = read('editor/edit-boot.js');
  const index = read('index.html');
  assert.match(boot, /elan_editor/);
  assert.match(boot, /window\.parent === window/);
  assert.doesNotMatch(boot, /element-registry\.js/);
  assert.match(boot, /edit-mode\.js/);
  assert.match(index, /edit-boot\.js\?v=/);
  assert.doesNotMatch(index, /edit-mode\.js|elan-host-bridge\.js|edit-model\.js/);
});

test('edit-mode uses same-origin bridge and defers saves to the parent editor', () => {
  const mode = read('editor/edit-mode.js');
  const bridge = read('editor/elan-host-bridge.js');
  assert.match(mode, /allowedEditorOrigins:\s*\[location\.origin\]/);
  assert.doesNotMatch(mode, /allowedEditorOrigins:\s*\[\s*'\*'/);
  assert.match(mode, /page\.save/);
  assert.match(mode, /page\.getState/);
  assert.match(bridge, /'page\.getState'.*'element\.select'.*'element\.edit'/);
  assert.doesNotMatch(mode, /localStorage|sessionStorage|document\.cookie|eval\(|new Function/);
});

test('design layer survives edit-mode starting before app-core defines render', () => {
  const layer = read('design-layer.js');
  assert.match(layer, /if \(typeof window\.render\s*===\s*'function'\) redraw\(\);/);
  assert.match(layer, /typeof window\.render\s*===\s*'function' && document\.getElementById\('main'\)/);
  assert.match(layer, /waitFor\(function \(\) \{[\s\S]*?\}, redraw, 15000\)/);
});

test('live editor keeps creation and editing actions in the right-click menu and gates save/refresh on bridge readiness', () => {
  const page = read('editor/elan-editor.html');
  const host = read('railway/editor-host.js');
  assert.match(page, /platformUrl='__ELAN_PLATFORM_URL__'\|\|location\.origin\+'\/'/);
  assert.match(host, /EDITOR_SITE_ORIGIN/);
  assert.match(page, /function showLiveMenu\(info\)/);
  assert.match(page, /إنشاء كارت عطر/);
  assert.match(page, /element\.edit/);
  assert.match(page, /if\(liveMode\)originalHeaderButtons\.forEach\(b=>b\.disabled=!bridgeReady\)/);
  assert.match(page, /if\(b===refreshBtn\)b\.disabled=!bridgeReady/);
  assert.match(page, /رفع التعديل إلى GitHub/);
  assert.match(page, /النشر على Railway/);
  const mode = read('editor/edit-mode.js');
  assert.match(mode, /p\.kind === 'banner'.*p\.kind === 'text_block'.*p\.kind === 'text'/);
  assert.match(page, /c!==deviceBox&&c!==refreshBtn/);
});

test('vercel.json no longer routes /editor to the deleted prototype', () => {
  const cfg = JSON.parse(read('vercel.json'));
  const rewrites = (cfg.rewrites || []).map((r) => r.source + '->' + r.destination).join(' ');
  assert.doesNotMatch(rewrites, /\/editor->\/editor\.html/);
  const src = (cfg.headers || []).map((h) => h.source).join(' ');
  assert.doesNotMatch(src, /editor\.html/);
  assert.doesNotMatch(src, /edit-host\.js/);
  for (const f of ['edit-boot.js', 'edit-mode.js', 'edit-model.js', 'elan-host-bridge.js']) {
    assert.ok(src.includes('editor/' + f), f + ' should stay in no-store headers under editor/');
  }
  assert.doesNotMatch(src, /element-registry\.js/);
  assert.doesNotMatch(src, /\|edit-mode\.js\||\|edit-model\.js\|/);
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

test('Railway serves the consolidated editor implementation only under /editor/', async () => {
  const server = require('../railway/server.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/editor/element-registry.js')).status, 404);
    assert.equal((await fetch(base + '/element-registry.js')).status, 404);
    const moved = await fetch(base + '/editor/edit-mode.js');
    assert.equal(moved.status, 200);
    assert.match(moved.headers.get('cache-control'), /no-store/);
    assert.match(await moved.text(), /allowedEditorOrigins:\s*\[location\.origin\]/);
    assert.equal((await fetch(base + '/edit-mode.js')).status, 404);
    assert.equal((await fetch(base + '/edit-model.js')).status, 404);
  } finally {
    server.close();
  }
});
