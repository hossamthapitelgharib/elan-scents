const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('editor login no longer reports a failed role check as a wrong password', () => {
  const s = fs.readFileSync(path.join(root, 'railway/editor-session.js'), 'utf8');
  assert.match(s, /role_check_failed/);
  assert.doesNotMatch(s, /ctx\.status === 403 \? 'forbidden' : 'invalid_credentials'/);
  assert.match(fs.readFileSync(path.join(root, 'editor/editor-login.js'), 'utf8'), /role_check_failed/);
});
