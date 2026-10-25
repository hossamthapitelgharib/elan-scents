const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');

test('app-core.js is self-contained (no external script loading)', () => {
  assert.doesNotMatch(core, /jsdelivr|raw\.githubusercontent|createElement\('script'\)/);
  assert.ok(core.length > 30000);
});

test('login and signup menu entries open their sheets', () => {
  assert.match(core, /<a data-sheet="signup">'\+t\.menu\[14\]\+'<\/a><a data-sheet="login">'\+t\.menu\[13\]\+'<\/a>/);
  assert.match(core, /function sheet\(k\)/);
  assert.match(core, /closest\('\[data-sheet\]'\)/);
  assert.match(core, /data-auth-form/);
});
