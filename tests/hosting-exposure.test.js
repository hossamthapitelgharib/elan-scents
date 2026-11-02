const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../railway/server.js');
const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('railway host does not serve server-side code or internal reports, but still serves the design file', async () => {
  const port = await listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const blocked = ['/lib/secure.js', '/lib/rate-limit.js', '/scripts/bump-asset-version.js', '/lib/order-status.js', '/lib/create-store-order.js', '/docs/handoff.ar.md', '/reports/test-runs/latest.json', '/api/_auth.js', '/supabase/README.md', '/tests/regression.test.js', '/CLAUDE.md', '/README.md', '/package.json', '/elan-editor-look-v3/editor/elan-editor.html', '/elan-editor-look-v3/edit-mode.js', '/editor/elan-editor.html', '/elan-editor-master-spec.md', '/.archive/legacy-editor-snapshots/README.md', '/docs/customer-platform/requirements.ar.md', '/docs/customer-platform/visitor-identity-review.ar.md', '/1-apply-migrations.sql', '/2-run-tests-after.sql'];
    for (const p of blocked) assert.equal((await fetch(base + p)).status, 404, p);
    assert.equal((await fetch(base + '/design/home.json')).status, 200, 'the storefront reads /design/home.json');
  } finally { server.close(); }
});
