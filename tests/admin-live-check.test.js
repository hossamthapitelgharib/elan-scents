const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* The live check of the published admin panel (scripts/admin-live-check.js and its workflow) cannot run here: it needs the real site. These tests keep it
   honest: it is valid code, it checks the panel files and endpoints that exist, it uses no secret, and the made-up data it shares with the browser test
   has the shape the panel's own endpoints return. */
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const script = read('scripts/admin-live-check.js');
const workflow = read('.github/workflows/admin-live-check.yml');

test('the script and the shared made-up data are valid JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(script.replace(/^#!.*\n/, ''), { filename: 'admin-live-check.js' }));
  const M = require('./browser/admin-mock.js');
  assert.deepEqual(M.PAGES, ['overview', 'first-notices', 'messages', 'customers', 'stores', 'settlements', 'rankings', 'audit']);
  assert.ok(M.freshAlerts().length >= 3 && M.notice(1).trackingNumber && M.noticeDetail(1).items.length);
});

test('every file and endpoint it looks for exists in the repository', () => {
  const html = read('platform-dashboard.html');
  for (const file of script.match(/'\/(?:admin[a-z-]*\.(?:js|css))'/g).map(value => value.slice(2, -1))) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
    assert.ok(html.includes(`/${file}?v=`), `${file} is in platform-dashboard.html`);
  }
  const registry = read('cloudflare/api-registry.js');
  for (const endpoint of new Set(script.match(/\/api\/platform-[a-z-]+/g))) {
    const name = endpoint.replace('/api/', '');
    assert.ok(fs.existsSync(path.join(root, 'api', `${name}.js`)), `api/${name}.js exists`);
    assert.ok(registry.includes(name), `${name} is registered for the Worker`);
  }
});

test('the check only reads: no secret, no write to the real site except a refused PATCH, no real credentials', () => {
  assert.doesNotMatch(workflow, /secrets\./, 'the workflow uses no secret');
  assert.doesNotMatch(script, /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/);
  assert.deepEqual(script.match(/method: '(?!PATCH)[A-Z]+'/g) || [], [], 'the only non-GET request is the PATCH that must be refused');
  assert.match(script, /not-a-real-token/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /name: admin-live-shots/);
});

test('the workflow waits for the new panel to be published and keeps the exit code of the check', () => {
  assert.match(workflow, /grep -q 'admin-shell\.js'/);
  assert.match(workflow, /PIPESTATUS\[0\]/);
  assert.match(workflow, /shell: bash/, 'without shell: bash the pipe to tee would hide a failure');
});

test('its made-up admin session is not a real token and nothing in it names a real person', () => {
  const M = require('./browser/admin-mock.js');
  const payload = JSON.parse(Buffer.from(M.token.split('.')[1], 'base64url').toString());
  assert.match(payload.sub, /^00000000-0000-4000-8000-/);
  const everything = JSON.stringify([M.freshAlerts(), M.noticeDetail(1)]);
  assert.doesNotMatch(everything, /@(?!example\.invalid)[a-z0-9-]+\.[a-z]{2,}/i);
});
