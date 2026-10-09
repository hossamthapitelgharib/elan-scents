const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const assetVersion = '20261009-3';

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
  assert.match(app, /var CORE=['"]\/app-core\.js\?v=20261009-3['"]/);
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
  assert.match(html, /poster=\"\/assets\/hero-poster\.jpg\?v=20261009-3\"/);
  assert.ok(headers.some(rule => rule.source === '/assets/(.*)' && rule.headers.some(h => h.key === 'Cache-Control' && /no-store/.test(h.value))));
});
