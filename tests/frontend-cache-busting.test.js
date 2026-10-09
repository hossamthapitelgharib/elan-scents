const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const assetVersion = '20261009-5';

test('main storefront pins a cache-busting version on UI assets', () => {
  assert.match(index, new RegExp(`/style\\.css\\?v=${assetVersion}`));
  assert.match(index, new RegExp(`/texts\\.js\\?v=${assetVersion}`));
  assert.match(index, new RegExp(`/app\\.js\\?v=${assetVersion}`));
  assert.match(style, new RegExp(`/style-3\\.css\\?v=${assetVersion}`));
});

test('hero video uses a versioned source and autoplay-safe attributes', () => {
  assert.match(index, new RegExp(`/assets/hero\\.mp4\\?v=${assetVersion}`));
  assert.match(index, /autoplay muted loop playsinline/);
  assert.match(index, /v\.playsInline=true/);
  assert.match(index, /loadedmetadata/);
  assert.match(index, /canplaythrough/);
});

test('main storefront loads its application core from the deployment itself', () => {
  assert.match(app, /var CORE=['"]\/app-core\.js\?v=20261009-5['"]/);
  assert.doesNotMatch(app, /jsdelivr|unpkg|cdnjs/);
  assert.ok(fs.existsSync(path.join(root, 'app-core.js')));
});


test('browser theme and viewport rules do not depend on OS dark mode or svh support', () => {
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const headers = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')).headers;
  assert.match(css, /color-scheme\s*:\s*light/);
  assert.match(css, /#hero\s*\{\s*height:\s*calc\(var\(--app-vh/);
  assert.doesNotMatch(css, /@supports\s*\(height:\s*100svh\)/);
  assert.match(html, /poster=\"\/assets\/hero-poster\.jpg\?v=20261009-5\"/);
  assert.ok(headers.some(rule => rule.source === '/assets/(.*)' && rule.headers.some(h => h.key === 'Cache-Control' && /no-store/.test(h.value))));
});


test('fonts are bundled locally and no storefront page depends on Google Fonts', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const fonts = fs.readFileSync(path.join(root, 'fonts.css'), 'utf8');
  assert.match(html, new RegExp(`/fonts\\.css\\?v=${assetVersion}`));
  assert.doesNotMatch(html + fs.readFileSync(path.join(root, 'portal.css'), 'utf8'), /fonts\.googleapis\.com/);
  assert.match(fonts, /src:url\('\/assets\/fonts\//);
});

test('signed-in cart mapping includes the store identifier and polls for cross-browser updates', () => {
  const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
  assert.match(core, /cheapest_offers\?select=product_size_id,product_id,store_id,store_name/);
  assert.match(core, /syncCartFromCloud\(!CART_FIRST_SYNC_DONE\)/);
  assert.match(core, /setInterval\(function\(\)\{if\(AUTH&&!document\.hidden\)/);
});

test('hero video pauses outside its visible area', () => {
  assert.match(index, /new IntersectionObserver/);
  assert.match(index, /v\.__elanHeroVisible===false/);
  assert.match(index, /v\.pause\(\)/);
});
