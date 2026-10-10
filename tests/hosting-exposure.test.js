const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const server = require('../railway/server.js');

const root = path.resolve(__dirname, '..');
const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('railway host does not serve server-side code or internal reports, but still serves the design file', async () => {
  const port = await listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const blocked = ['/lib/secure.js', '/lib/rate-limit.js', '/scripts/bump-asset-version.js', '/lib/order-status.js', '/lib/create-store-order.js', '/reports/2026-10-10-repository-maintenance.md', '/api/_auth.js', '/supabase/README.md', '/tests/regression.test.js', '/CLAUDE.md', '/README.md', '/package.json', '/vercel.json'];
    for (const p of blocked) assert.equal((await fetch(base + p)).status, 404, p);
    assert.equal((await fetch(base + '/design/home.json')).status, 200, 'the storefront reads /design/home.json');
  } finally { server.close(); }
});

test('.vercelignore keeps internal files out of the deployment but never excludes what the site needs', () => {
  const lines = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const needed of ['tests', 'supabase', 'reports', 'railway', 'CLAUDE.md']) assert.ok(lines.includes(needed), `${needed} must be ignored`);
  for (const mustDeploy of ['lib', 'api', 'design', 'assets', 'index.html', 'app-core.js', 'vercel.json', 'package.json']) assert.ok(!lines.includes(mustDeploy), `${mustDeploy} must stay deployed`);
  for (const dir of ['lib', 'api', 'design']) assert.ok(fs.existsSync(path.join(root, dir)), `${dir}/ exists`);
});
