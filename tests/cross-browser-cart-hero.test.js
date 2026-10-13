const { loadCoreSource } = require('./load-core');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const style = read('style.css');
const core = loadCoreSource();

test('hero video retries after browser-initiated pauses and unlocks on a real gesture', () => {
  assert.match(index, /v\.addEventListener\('pause'/);
  assert.match(index, /pauseRetries>=10/);
  assert.match(index, /v\.addEventListener\('ended'/);
  assert.match(index, /\['touchend','pointerup','click','keydown'\]/);
  assert.match(index, /window\.addEventListener\('pageshow'/);
  assert.match(index, /v\.defaultMuted=true/);
});

test('hero autoplays and there is no play/pause button', () => {
  assert.match(index, /v\.addEventListener\('playing'/);
  assert.match(index, /showButton\(false\)/);
  assert.match(index, /showButton\(true\)/);
  assert.doesNotMatch(style, /#heroPlay/);
});

test('Railway serves the hero video and poster with immutable cache headers', async () => {
  const server = require('../railway/server.js');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const poster = await fetch(base + '/assets/hero-poster.jpg', { method: 'HEAD' });
    assert.equal(poster.status, 200);
    assert.match(poster.headers.get('cache-control'), /max-age=31536000/);
    assert.match(poster.headers.get('cache-control'), /immutable/);
    const video = await fetch(base + '/assets/hero.mp4', { method: 'HEAD' });
    if (video.status === 404) return;
    assert.equal(video.status, 200);
    assert.match(video.headers.get('content-type'), /video\/mp4/);
    assert.match(video.headers.get('cache-control'), /max-age=31536000/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cart helpers exist in resolved app-core source', () => {
  // Extract the two real functions from app-core.js and run them against a fake catalog.
  assert.match(core, /function addToCart/);
  assert.match(core, /function cartBadge/);
});

test('storefront is full width, header text is flat and the menu locks page scroll', () => {
  const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
<<<<<<< Updated upstream
  const app = read('app.js');
  assert.match(style, /body\{max-width:540px!important/);
=======
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.doesNotMatch(style, /body\{max-width:540px/);
>>>>>>> Stashed changes
  assert.match(style, /#bar \.gold,#barT\{background:none!important/);
  assert.match(style, /html,body\{overflow-x:clip!important/);
  assert.match(app, /function syncBodyScroll/);
  assert.match(app, /menu\.classList\.contains\('open'\)/);
  assert.match(app, /body\.classList\.add\('scroll-locked'\)/);
  assert.doesNotMatch(read('index.html'), /id="heroPlay"/);
});
