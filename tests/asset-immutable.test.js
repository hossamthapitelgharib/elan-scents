'use strict';
/* Scripts and stylesheets are served "public, max-age=31536000, immutable" (vercel.json, which the Worker's _headers and the local
   server both read), because every page asks for them under a ?v= URL. That is only safe while a changed file always gets a new
   version, so asset-manifest.json (written by scripts/bump-asset-version.js) records the version and a content hash of each of them
   and these tests fail the moment a file changes without a bump. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bump = require('../scripts/bump-asset-version');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const manifest = JSON.parse(read('asset-manifest.json'));
const files = bump.immutableFiles();

test('the immutable rule lists the shared scripts and styles, and nothing else is also told to revalidate', () => {
  assert.ok(files.length >= 25, 'the rule names the storefront and portal scripts and styles');
  for (const f of ['app-core.js', 'style.css', 'style-3.css', 'footer-9x16.css', 'fonts.css', 'hero-early.js', 'design-layer.js', 'edit-mode.js']) assert.ok(files.includes(f), f);
  const rules = JSON.parse(read('vercel.json')).headers;
  const revalidating = rules.filter((r) => r.headers.some((h) => h.key === 'Cache-Control' && h.value === 'no-cache')).map((r) => r.source).join('|');
  for (const f of files) assert.ok(!revalidating.includes(f), f + ' is both immutable and no-cache');
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f + ' is named by the rule but missing');
});

test('every file under the immutable rule is requested only under a ?v= URL', () => {
  const html = fs.readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => [f, read(f)]);
  for (const [name, text] of html) {
    for (const m of text.matchAll(/(?:href|src)="\/([^"?#]+\.(?:css|js))(\?[^"]*)?"/g)) {
      if (files.includes(m[1])) assert.match(m[2] || '', /^\?v=[0-9A-Za-z-]+$/, `${name} links ${m[1]} without ?v=`);
    }
  }
  assert.match(read('app.js'), /var CORE='\/app-core\.js\?v=[0-9A-Za-z-]+'/, 'app.js loads app-core.js under the version');
  assert.match(read('edit-boot.js'), /s\.src = src \+ '\?v=' \+ v/, 'the editing tools are loaded under the page\'s version');
  assert.match(read('index.html'), /<link rel="preload" as="script" href="\/app-core\.js\?v=/, 'the page announces app-core.js early, under the same URL app.js will ask for');
});

test('asset-manifest.json matches the pages: same version, same files, and every file still has the hash recorded at the last bump', () => {
  const versions = new Set();
  for (const file of bump.targets()) for (const m of read(file).matchAll(bump.REF)) versions.add(m[2]);
  assert.deepEqual([...versions], [manifest.version], 'the version in the pages is the one in asset-manifest.json (run: node scripts/bump-asset-version.js)');
  assert.deepEqual(Object.keys(manifest.files).sort(), [...files].sort(), 'the manifest lists exactly the immutable files');
  const stale = files.filter((f) => bump.hashOf(f) !== manifest.files[f]);
  assert.deepEqual(stale, [], 'these files changed without a new asset version, so returning visitors would keep the old copy for a year; run: node scripts/bump-asset-version.js');
});

test('the Cloudflare headers file gives those files the immutable rule and the pages stay uncached', () => {
  const build = fs.readFileSync(path.join(root, 'scripts', 'build-cloudflare.js'), 'utf8');
  assert.match(build, /vercel\.json/, 'the Worker rules come from vercel.json');
  const rules = JSON.parse(read('vercel.json')).headers;
  const page = rules.find((r) => r.source === '/');
  assert.ok(page.headers.some((h) => h.key === 'Cache-Control' && /no-store/.test(h.value)), 'the home page is never cached, so a new version is picked up at once');
});

test('CI does not rewrite the asset version before testing (that would hide a forgotten bump)', () => {
  const workflow = read('.github/workflows/tests.yml');
  assert.doesNotMatch(workflow, /bump-asset-version/, 'the suite must see the committed versions and hashes, not freshly generated ones');
});
