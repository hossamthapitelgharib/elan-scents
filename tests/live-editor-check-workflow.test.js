const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./browser-fixture');

/* The workflow that opens the real editor with the owner's login: the repository is public, so the login must only ever be a secret. */
test('the live editor check takes its login from repository secrets only and cannot be started by outsiders', () => {
  const wf = read('.github/workflows/live-editor-check.yml'), script = read('scripts/live-editor-check.js');
  assert.match(wf, /EDITOR_LIVE_EMAIL: \$\{\{ secrets\.EDITOR_LIVE_EMAIL \}\}/);
  assert.match(wf, /EDITOR_LIVE_PASSWORD: \$\{\{ secrets\.EDITOR_LIVE_PASSWORD \}\}/);
  assert.match(wf, /EDITOR_LIVE_ACCESS_KEY: \$\{\{ secrets\.EDITOR_LIVE_ACCESS_KEY \}\}/);
  assert.doesNotMatch(wf, /pull_request|issue_comment|workflow_run/, 'only a manual run or a change to its own script starts it');
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /retention-days: 1/, 'screenshots are short-lived');
  assert.match(wf, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(wf + script, /@gmail\.com|password\s*[:=]\s*['"][^'"$]/i, 'no login written in the files');
  assert.doesNotMatch(script, /console\.(log|error)\([^)]*(\$\{\s*(email|password)|[(,+]\s*(email|password)\s*[,)+])/, 'the login values are never printed');
  assert.match(script, /editorUrl\.searchParams\.set\('key', accessKey\)/);
  assert.match(script, /process\.env\.EDITOR_LIVE_ACCESS_KEY/);
});

test('the live editor check never saves, never changes anything and does not photograph the login page', () => {
  const script = read('scripts/live-editor-check.js');
  assert.doesNotMatch(script, /click\('#save'\)|page\.save|saveLive|api\/editor['"`]\s*,\s*\{\s*method:\s*'POST'/);
  const afterLogin = script.slice(script.indexOf("say('editor open"));
  assert.match(afterLogin, /shot\(page, 'editor'\)/);
  assert.ok(script.indexOf("shot(page, 'editor')") > script.indexOf('await login(page)'), 'the first screenshot is taken after signing in');
});
