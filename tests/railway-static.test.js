const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function start(port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'railway', 'server.js')], {
      env: { PATH: process.env.PATH, PORT: String(port) }
    });
    p.stdout.on('data', (data) => {
      if (String(data).includes('listening')) resolve(p);
    });
    p.on('error', reject);
  });
}

test('Railway serves only the allow-listed editor geometry asset, not the private editor page', async () => {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const server = await start(port);
  try {
    const base = 'http://127.0.0.1:' + port;
    const asset = await fetch(base + '/editor/editor-geometry.js?v=20261016-04');
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /ElanEditorGeometry/);
    assert.equal((await fetch(base + '/editor/elan-editor.html')).status, 404);
  } finally {
    server.kill();
  }
});
