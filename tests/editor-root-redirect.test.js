const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../railway/server.js');
const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('EDITOR_ROOT_REDIRECT=1 sends the root of the editor service to /editor; the storefront is unchanged otherwise', async () => {
  const port = await listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    delete process.env.EDITOR_ROOT_REDIRECT;
    assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 200);
    process.env.EDITOR_ROOT_REDIRECT = '1';
    const r = await fetch(base + '/', { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/editor');
    assert.equal((await fetch(base + '/health')).status, 200);
  } finally { delete process.env.EDITOR_ROOT_REDIRECT; server.close(); }
});
