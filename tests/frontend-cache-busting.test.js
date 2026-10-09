const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

const assetVersion = '20261009-2';

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
  assert.match(app, /var CORE=['"]\/app-core\.js\?v=20261009-2['"]/);
  assert.doesNotMatch(app, /jsdelivr|unpkg|cdnjs/);
  assert.ok(fs.existsSync(path.join(root, 'app-core.js')));
});
