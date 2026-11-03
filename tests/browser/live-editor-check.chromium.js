'use strict';
/* scripts/live-editor-check.js (what the "Live editor check" workflow runs against the real site with the owner's login) run here against the
   local test server: it must open the editor, find every panel's looks as the original draws them, and report no problem. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const F = require('./panel-fidelity.js');
const { check } = require('../../scripts/live-editor-check.js');

const pw = H.loadPlaywright();

test('the live editor check passes on the local editor', async () => {
  const server = await H.startServer(), browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const { context } = await H.openContext(browser, server, { width: 1366, height: 860 });
    await context.route('**/api/editor-data*', (route) => {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { /* get */ }
      const action = body.action || new URL(route.request().url()).searchParams.get('action');
      const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (action === 'options') return json({ ok: true, options: F.OPTIONS });
      if (action === 'perfumes') return json({ ok: true, rows: F.PERFUMES });
      return json({ ok: true, library: { media: [], archive: [], savedElements: [], revision: 'a'.repeat(64) } });
    });
    await context.route('**/api/editor-media*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }));
    await H.loginAsOwner(context, server);                  // the test server signs in with its key; the real run signs in with the form
    const out = await check({ context, base: H.SITE, login: async () => { throw new Error('the local server is already signed in'); } });
    assert.deepEqual(out.problems, [], out.lines.join('\n'));
    assert.ok(out.lines.filter((l) => l.startsWith('ok')).length >= 11, out.lines.join('\n'));
  } finally { await browser.close(); await server.stop(); }
});

test('without the secrets the check says what to add and does nothing else', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['scripts/live-editor-check.js', 'https://elan.invalid'], { cwd: require('node:path').resolve(__dirname, '..', '..'), env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /EDITOR_LIVE_EMAIL and EDITOR_LIVE_PASSWORD are not set/);
  assert.match(r.stdout, /Nothing was checked/);
});
