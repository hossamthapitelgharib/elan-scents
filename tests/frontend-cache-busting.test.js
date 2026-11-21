const { loadCoreSource } = require('./load-core');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('storefront html links versioned css/js bundles', () => {
  const html = read('index.html');
  assert.match(html, /href="\/fonts\.css\?v=[0-9A-Za-z-]+"/);
  assert.match(html, /href="\/style\.css\?v=[0-9A-Za-z-]+"/);
  assert.match(html, /src="\/guest-identity\.js\?v=[0-9A-Za-z-]+"/);
  assert.match(html, /src="\/texts\.js\?v=[0-9A-Za-z-]+"/);
  assert.match(html, /src="\/app\.js\?v=[0-9A-Za-z-]+"/);
});

test('app.js loads app-core under the version of its own address, and carries no version number itself', () => {
  const app = read('app.js');
  assert.match(app, /var CORE='\/app-core\.js\?v='\+ASSET_V;/);
  assert.match(app, /var ASSET_V=\(\(document\.currentScript&&document\.currentScript\.src\|\|''\)\.match\(\/\[\?&\]v=\(\[0-9A-Za-z-\]\+\)\/\)\|\|\[\]\)\[1\]\|\|'';/);
  assert.doesNotMatch(app, /\?v=\d/, 'a number written into app.js would change the file (and conflict) whenever the version moved');
});

test('the storefront loads its theme sheets in parallel, versioned, in cascade order (no @import chain)', () => {
  const style = read('style.css');
  assert.doesNotMatch(style, /^\s*@import/m, 'an @import makes the browser fetch the sheet one round-trip after style.css');
  const html = read('index.html');
  const order = ['/fonts.css', '/style-3.css', '/footer-9x16.css', '/style.css', '/consent.css'].map((f) => html.indexOf('<link rel="stylesheet" href="' + f + '?v='));
  assert.ok(order.every((i) => i > -1), 'every sheet has its own versioned link');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'base theme, footer, then the overrides: the same order the @imports had');
});

test('critical frontend files exist', () => {
  assert.ok(fs.existsSync(path.join(root, 'app-core.js')));
  assert.ok(fs.existsSync(path.join(root, 'style-3.css')));
  assert.ok(fs.existsSync(path.join(root, 'footer-9x16.css')));
});

test('app-core source resolves (local or pinned)', () => {
  const core = loadCoreSource();
  assert.match(core, /function footer18/);
});
