'use strict';
/* The cache-busting version (?v=...) of the shared scripts and stylesheets.

   It used to be a number typed into every page by hand (scripts/bump-asset-version.js), so two sessions editing the storefront conflicted on
   every rebase, and a forgotten bump left returning visitors on a year-old copy. Now the source files carry one constant placeholder and the
   real version is the fingerprint of the immutable files, put in when a page is served or built (lib/asset-version.js). These tests hold the
   three halves of that together: the sources never carry a number, the stamp is correct and only moves with the files, and every place that
   serves a page (the local server, the Cloudflare build, the editor login page) stamps it, so a page with the placeholder left in it can
   never reach a visitor. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assetVersion = require('../lib/asset-version.js');
const { targets, REF, PLACEHOLDER, normalize } = require('../scripts/bump-asset-version');
const build = require('../scripts/build-cloudflare.js');
const server = require('../railway/server.js');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function fixture(files, immutable = 'a.js|b.css') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elan-asset-'));
  fs.writeFileSync(path.join(dir, 'vercel.json'), JSON.stringify({ headers: [{ source: `/(${immutable})`, headers: [{ key: 'Cache-Control', value: assetVersion.IMMUTABLE }] }] }));
  for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
  return dir;
}

test('the source files carry only the placeholder, never a number: a number written there is exactly what used to conflict', () => {
  const seen = [];
  for (const file of targets()) for (const m of read(file).matchAll(REF)) seen.push(`${file}: ${m[1]}?v=${m[2]}`);
  assert.ok(seen.length > 50, 'the pages do reference the shared scripts and styles');
  const real = seen.filter((s) => !s.endsWith('?v=' + PLACEHOLDER));
  assert.deepEqual(real, [], 'a real version in a source file; the version is generated, put the placeholder back: node scripts/bump-asset-version.js');
  assert.deepEqual(normalize(), [], 'the committed pages are already normal');
  assert.equal(fs.existsSync(path.join(root, 'asset-manifest.json')), false, 'asset-manifest.json is retired: nothing records a fingerprint by hand any more');
});

test('every local css/js asset linked from an HTML page carries ?v= (the placeholder in the source) and exists', () => {
  for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
    const html = read(file);
    for (const m of html.matchAll(/(?:href|src)="(\/[^"?#]+\.(?:css|js))(\?[^"]*)?"/g)) {
      assert.equal(m[2] || '', '?v=' + PLACEHOLDER, `${file} links ${m[1]} without ?v=${PLACEHOLDER}`);
      assert.ok(fs.existsSync(path.join(root, m[1])), `${file} links a missing file ${m[1]}`);
    }
  }
});

test('stamp puts the version into the shared files\' addresses only, leaves every other address and text alone, and is repeatable', () => {
  const dir = fixture({ 'a.js': '1', 'b.css': '2' });
  try {
    const page = '<link rel="stylesheet" href="/b.css?v=dev"><script src="/a.js?v=20250101-01"></script><script src="/editor/own.js?v=20261016-01"></script><script src="/other.js?v=dev"></script><p>no reference here</p>';
    const out = assetVersion.stamp(page, 'abc123', dir);
    assert.equal(out, '<link rel="stylesheet" href="/b.css?v=abc123"><script src="/a.js?v=abc123"></script><script src="/editor/own.js?v=20261016-01"></script><script src="/other.js?v=abc123"></script><p>no reference here</p>');
    assert.equal(assetVersion.stamp(out, 'abc123', dir), out, 'stamping again changes nothing');
    assert.equal(assetVersion.stamp(out, 'zzz999', dir).includes('/editor/own.js?v=20261016-01'), true, 'a file with its own version scheme keeps it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the version is the fingerprint of the immutable files: it moves when one of them changes and not when anything else does', () => {
  const dir = fixture({ 'a.js': 'one', 'b.css': 'two', 'page.html': 'x', 'notes.json': '{}', 'c.js': 'not in the rule' });
  try {
    const v0 = assetVersion.computeVersion(dir);
    assert.match(v0, /^[0-9a-f]{12}$/);
    assert.equal(assetVersion.computeVersion(dir), v0, 'the same files give the same version');
    for (const quiet of ['page.html', 'notes.json', 'c.js']) { fs.writeFileSync(path.join(dir, quiet), 'changed ' + quiet); assert.equal(assetVersion.computeVersion(dir), v0, quiet + ' is not immutable, so it does not move the version'); }
    fs.writeFileSync(path.join(dir, 'a.js'), 'one!');
    const v1 = assetVersion.computeVersion(dir);
    assert.notEqual(v1, v0, 'a changed script gets a new version by itself: a forgotten bump is impossible');
    fs.writeFileSync(path.join(dir, 'b.css'), 'two!');
    const v2 = assetVersion.computeVersion(dir);
    assert.ok(v2 !== v1 && v2 !== v0);
    fs.writeFileSync(path.join(dir, 'a.js'), 'one'); fs.writeFileSync(path.join(dir, 'b.css'), 'two');
    assert.equal(assetVersion.computeVersion(dir), v0, 'the version depends on the content alone, so a revert returns to the cached copy');
    // the in-memory copy the local server keeps notices a changed file at once
    assert.equal(assetVersion.currentVersion(dir), v0);
    fs.writeFileSync(path.join(dir, 'a.js'), 'a longer script');
    assert.notEqual(assetVersion.currentVersion(dir), v0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the real immutable list is what vercel.json says, and the version is stable between two reads', () => {
  const files = assetVersion.immutableFiles(root);
  assert.ok(files.length >= 25 && files.includes('app.js') && files.includes('app-core.js') && files.includes('style.css'));
  assert.equal(assetVersion.computeVersion(root), assetVersion.computeVersion(root));
  assert.equal(assetVersion.currentVersion(root), assetVersion.computeVersion(root));
});

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('the local server serves every page stamped with the real version, with a validator that follows it, and never the placeholder', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, version = assetVersion.computeVersion(root);
  try {
    for (const page of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
      const res = await get(port, '/' + page);
      assert.equal(res.status, 200, page);
      const text = res.body.toString('utf8');
      const versions = new Set([...text.matchAll(REF)].map((m) => m[2]));
      assert.ok(versions.size <= 1 && (versions.size === 0 || versions.has(version)), `${page} must carry the one real version ${version}, got ${[...versions]}`);
      assert.doesNotMatch(text, new RegExp(`\\.(?:css|js)\\?v=${PLACEHOLDER}\\b`), page + ' was served with the placeholder left in');
      assert.match(res.headers['content-type'], /text\/html/);
      assert.ok(res.headers.etag, page + ' has a validator');
      const again = await get(port, '/' + page, { 'if-none-match': res.headers.etag });
      assert.equal(again.status, 304, page + ' revalidates');
      const head = await new Promise((resolve) => http.request({ host: '127.0.0.1', port, path: '/' + page, method: 'HEAD' }, (r) => { r.resume(); r.on('end', () => resolve(r)); }).end());
      assert.equal(head.statusCode, 200);
    }
    const home = await get(port, '/', { 'accept-encoding': 'gzip' });
    assert.equal(home.headers['content-encoding'], 'gzip', 'a page is still compressed');
    assert.match(require('node:zlib').gunzipSync(home.body).toString('utf8'), new RegExp('/app-core\\.js\\?v=' + version));
    // an asset itself is untouched: the script on disk is the script served, and the loader reads its version from its own address
    const app = await get(port, '/app.js?v=' + version);
    assert.equal(app.body.toString('utf8'), read('app.js'));
    assert.equal(app.headers['cache-control'], assetVersion.IMMUTABLE);
  } finally { server.close(); }
});

test('the Cloudflare build stamps every page and the editor login page with the same real version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elan-cf-'));
  try {
    const result = build.build({ outDir: path.join(dir, 'dist'), generatedDir: path.join(dir, 'gen') });
    const version = assetVersion.computeVersion(root);
    const pages = result.files.filter((f) => f.endsWith('.html'));
    assert.ok(pages.length >= 8);
    for (const rel of pages) {
      const text = fs.readFileSync(path.join(dir, 'dist', ...rel.split('/')), 'utf8');
      for (const m of text.matchAll(REF)) assert.equal(m[2], version, `${rel}: ${m[1]}`);
      assert.doesNotMatch(text, new RegExp(`\\.(?:css|js)\\?v=${PLACEHOLDER}\\b`), rel + ' was built with the placeholder left in');
    }
    const editor = require(path.join(dir, 'gen', 'editor-files.js'));
    assert.match(editor['login.html'], new RegExp('/turnstile\\.js\\?v=' + version), 'the login page of the editor is stamped in the Worker bundle');
    assert.doesNotMatch(editor['login.html'], new RegExp(`\\?v=${PLACEHOLDER}\\b`));
    // the build is the same bytes twice: nothing in it depends on the clock
    const second = path.join(dir, 'again');
    build.build({ outDir: path.join(second, 'dist'), generatedDir: path.join(second, 'gen') });
    assert.equal(fs.readFileSync(path.join(second, 'dist', 'index.html'), 'utf8'), fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the editor login page read from disk (the local server) is stamped too', () => {
  const editorHost = require('../railway/editor-host.js');
  assert.ok(editorHost, 'the editor host loads');
  assert.match(fs.readFileSync(path.join(root, 'railway', 'editor-host.js'), 'utf8'), /stampPage\(text, ROOT\)/, 'editorFile stamps html read from disk');
  assert.match(assetVersion.stampPage(read('editor/login.html'), root), new RegExp('/turnstile\\.js\\?v=' + assetVersion.computeVersion(root)));
});

test('the bump script is a harmless normaliser: it prints that nothing is left to bump and changes nothing on a clean tree', () => {
  const out = require('node:child_process').execFileSync(process.execPath, [path.join(root, 'scripts', 'bump-asset-version.js')], { encoding: 'utf8' });
  assert.match(out, /nothing to bump/);
  assert.equal(fs.existsSync(path.join(root, 'asset-manifest.json')), false);
  assert.deepEqual(normalize(), []);
});

test('the sources never gain a hand-typed version again: the loader and the editing tools take theirs from their own address', () => {
  assert.doesNotMatch(read('app.js'), /\?v=\d/, 'app.js carries no number');
  assert.match(read('edit-boot.js'), /s\.src = src \+ '\?v=' \+ v/, 'the editing tools are loaded under the page\'s version');
});
