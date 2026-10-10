const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('editor page is the approved editor, locked behind login, never remembers the session', () => {
  const html = read('editor.html');
  const login = read('editor-login.js');
  assert.match(html, /noindex/);
  assert.match(html, /elan-editor-bridge\/v1/);
  assert.match(html, /address\.value=location\.origin/);
  assert.match(html, /id="elan-gate"/);
  assert.match(html, /src="\/editor-login\.js\?v=/);
  assert.doesNotMatch(login, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(html, /elan-scents\.vercel\.app/);
});

test('edit mode loads only for the editor and never for customers', () => {
  const boot = read('edit-boot.js');
  const index = read('index.html');
  assert.match(boot, /elan_editor/);
  assert.match(boot, /window\.parent === window/);
  assert.match(index, /edit-boot\.js\?v=/);
  assert.doesNotMatch(index, /edit-host\.js|edit-model\.js|elan-host-bridge\.js/);
});

test('edit host uses the bridge with same-origin only and confirms saves from the server', () => {
  const host = read('edit-host.js');
  assert.match(host, /allowedEditorOrigins: \[location\.origin\]/);
  assert.doesNotMatch(host, /allowedEditorOrigins:\s*\[\s*'\*'/);
  assert.match(host, /expectedRevision/);
  assert.match(host, /site-media/);
  assert.match(host, /device_upload/);
  assert.match(host, /is_approved: true/);
  assert.match(host, /editor_sections/);
  assert.match(host, /selection_mode/);
  assert.match(host, /timer_mode/);
  assert.match(host, /flushSections\(\);\n\s+var r = await api\('POST', \{ action: 'save'/);
  for (const t of ['brands', 'stores', 'occasions', 'aromatic_notes']) assert.match(host, new RegExp("table: '" + t + "'"));
  assert.match(host, /normName/);
  assert.match(host, /insertRecord\(pending\[pi\]\)/);
  assert.match(host, /published/);
  assert.doesNotMatch(host, /localStorage|innerHTML/);
});

test('every no-store header covers the editor files', () => {
  const cfg = JSON.parse(read('vercel.json'));
  const src = cfg.headers.map((h) => h.source).join(' ');
  for (const f of ['editor.html', 'editor-login.js', 'edit-boot.js', 'edit-host.js', 'edit-model.js', 'elan-host-bridge.js']) assert.ok(src.includes(f), f);
});

test('railway host serves /editor through the rewrite', async () => {
  const server = require('../railway/server.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/editor');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(await res.text(), /elan-gate/);
  } finally { server.close(); }
});
