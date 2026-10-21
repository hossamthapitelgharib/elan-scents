const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const server = require('../railway/server.js');

async function withServer(run) {
  const s = http.createServer(server.listeners('request')[0]);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + s.address().port); } finally { s.close(); }
}

test('pages, scripts, API answers, errors and health all carry the baseline security headers', async () => {
  await withServer(async base => {
    for (const p of ['/', '/app.js', '/api/config', '/api/no-such-function', '/health', '/package.json']) {
      const response = await fetch(base + p);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', p);
      assert.match(response.headers.get('permissions-policy'), /camera=\(\)/, p);
      assert.match(response.headers.get('permissions-policy'), /geolocation=\(\)/, p);
    }
  });
});

test('HSTS is sent only when the proxy says the request came over HTTPS', async () => {
  await withServer(async base => {
    assert.equal((await fetch(base + '/health')).headers.get('strict-transport-security'), null);
    const secure = await fetch(base + '/health', { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(secure.headers.get('strict-transport-security'), 'max-age=15552000');
    assert.equal(/includeSubDomains|preload/i.test(secure.headers.get('strict-transport-security')), false);
  });
});

test('the baseline headers never block framing or inline scripts, because the editor opens the site inside itself', async () => {
  await withServer(async base => {
    const page = await fetch(base + '/');
    assert.equal(page.headers.get('x-frame-options'), null);
    assert.equal(page.headers.get('content-security-policy'), null);
  });
});

test('every file extension the site serves has a content type, so nosniff cannot block a script or style', () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const hidden = /^(api|tests|supabase|railway|node_modules|src|lib|scripts|reports|docs|\.github|\.git|\.archive)\//;
  const extensions = new Set(files.filter(f => !hidden.test(f)).map(f => path.extname(f).toLowerCase()).filter(Boolean));
  // .sql files are never served (the host blocks them) and .gitkeep/.gitignore are dot files, which are never served either.
  const unmapped = [...extensions].filter(e => !server.MIME[e] && !['.sql', '.gitkeep', '.gitignore'].includes(e));
  assert.deepEqual(unmapped, [], 'add a MIME type in railway/server.js for: ' + unmapped.join(', '));
});
