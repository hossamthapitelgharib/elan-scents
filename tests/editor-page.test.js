const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('production editor page lives under editor/ and is never a public static file', () => {
  const html = read('editor/elan-editor.html');
  const login = read('editor/editor-login.js');
  const guard = read('editor/editor-guard.js');
  assert.match(html, /iframe|liveFrame/i);
  assert.match(html, /location\.origin/);
  assert.doesNotMatch(login, /localStorage|sessionStorage|document\.cookie/);
  assert.match(guard, /editor-logout|editor-session/);
});

test('edit mode loads only for the editor and never for customers', () => {
  const boot = read('edit-boot.js');
  const index = read('index.html');
  assert.match(boot, /elan_editor/);
  assert.match(boot, /window\.parent === window/);
  assert.match(boot, /edit-mode\.js/);
  assert.match(index, /edit-boot\.js\?v=/);
  assert.doesNotMatch(index, /edit-host\.js|edit-model\.js|elan-host-bridge\.js/);
});

test('edit-mode uses same-origin bridge and does not touch localStorage', () => {
  const mode = read('edit-mode.js');
  assert.match(mode, /allowedEditorOrigins:\s*\[location\.origin\]/);
  assert.doesNotMatch(mode, /allowedEditorOrigins:\s*\[\s*'\*'/);
  assert.match(mode, /site-media/);
  assert.doesNotMatch(mode, /localStorage/);
});

test('editor routes and scripts are served with no-store headers by Railway', async () => {
  const server = require('../railway/server.js');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['/editor', '/editor-login.js', '/editor-login.css', '/edit-boot.js', '/edit-mode.js', '/elan-host-bridge.js']) {
      const response = await fetch(base + route, { method: 'HEAD' });
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get('cache-control') || '', /no-store/, route);
    }
    // Prototype / public editor.html must not exist
    assert.equal((await fetch(base + '/editor.html', { method: 'HEAD' })).status, 404);
  } finally { server.close(); }
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
  } finally { server.close(); }
});
