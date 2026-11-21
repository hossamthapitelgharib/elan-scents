'use strict';
/* Scripts and stylesheets are served "public, max-age=31536000, immutable" (vercel.json, which the Worker's _headers and the local
   server both read), because every page asks for them under a ?v= URL. That is only safe while a changed file always gets a new
   version. That version is the fingerprint of the files themselves (lib/asset-version.js), put into every page when it is served or built,
   so a changed file always gets a new URL by itself; tests/asset-version-consistency.test.js holds that part together. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bump = require('../scripts/bump-asset-version');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
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
  assert.match(read('app.js'), /var CORE='\/app-core\.js\?v='\+ASSET_V;/, 'app.js loads app-core.js under the version of its own address');
  assert.match(read('edit-boot.js'), /s\.src = src \+ '\?v=' \+ v/, 'the editing tools are loaded under the page\'s version');
  assert.match(read('index.html'), /<link rel="preload" as="script" href="\/app-core\.js\?v=/, 'the page announces app-core.js early, under the same URL app.js will ask for');
});

test('no file records a fingerprint by hand any more: the version follows the content', () => {
  assert.equal(fs.existsSync(path.join(root, 'asset-manifest.json')), false);
  const assetVersion = require('../lib/asset-version');
  assert.deepEqual(assetVersion.immutableFiles(root), [...files], 'one list of immutable files, read from vercel.json');
  assert.match(assetVersion.computeVersion(root), /^[0-9a-f]{12}$/);
});

test('the Cloudflare headers file gives those files the immutable rule and the pages stay uncached', () => {
  const build = fs.readFileSync(path.join(root, 'scripts', 'build-cloudflare.js'), 'utf8');
  assert.match(build, /vercel\.json/, 'the Worker rules come from vercel.json');
  const rules = JSON.parse(read('vercel.json')).headers;
  const page = rules.find((r) => r.source === '/');
  assert.ok(page.headers.some((h) => h.key === 'Cache-Control' && /no-store/.test(h.value)), 'the home page is never cached, so a new version is picked up at once');
});

test('CI does not rewrite the pages before testing (the suite must see what was committed)', () => {
  const workflow = read('.github/workflows/tests.yml');
  assert.doesNotMatch(workflow, /bump-asset-version/, 'the suite must see the committed sources, not freshly generated ones');
});
