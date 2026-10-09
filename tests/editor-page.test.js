const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('editor page is private, never remembers the login, and is served without caching', () => {
  const html = read('editor.html');
  const js = read('editor.js');
  assert.match(html, /noindex/);
  assert.match(html, /src="\/editor\.js\?v=/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(js, /innerHTML/);
  const cfg = JSON.parse(read('vercel.json'));
  assert.ok(cfg.rewrites.some((r) => r.source === '/editor' && r.destination === '/editor.html'));
  assert.ok(cfg.headers.some((h) => /editor\.html/.test(h.source) && /editor\.js/.test(h.source)));
});

test('editor page only edits what the design schema allows', () => {
  const ED = require('../design-schema.js');
  const js = read('editor.js');
  for (const id of ED.BUILTIN) assert.match(js, new RegExp('\\b' + id + '\\b'));
  for (const k of ED.TEXT_KEYS) assert.match(js, new RegExp(k));
  assert.match(js, /expectedRevision/);
  assert.match(js, /requestId/);
});

test('railway host serves /editor through the rewrite', async () => {
  const server = require('../railway/server.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/editor');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(await res.text(), /إيلان إديتور/);
  } finally { server.close(); }
});
