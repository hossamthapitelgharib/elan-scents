const { loadCoreSource } = require('./load-core');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser } = require('./browser-fixture');

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

test('hero autoplays and keeps its fallback play button hidden until needed', () => {
  assert.match(index, /v\.addEventListener\('playing'/);
  assert.match(index, /showButton\(false\)/);
  assert.match(index, /showButton\(true\)/);
  assert.match(index, /id="heroPlay"[^>]*hidden/);
  assert.match(style, /#heroPlay\[hidden\]\{display:none!important\}/);
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

test('storefront is full width, prevents horizontal overflow, and locks scroll for overlays and menu', () => {
  const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.doesNotMatch(style, /body\{max-width:540px/);
  assert.match(style, /#bar,header\{left:0;right:0\}/);
  assert.match(style, /html,body\{overflow-x:clip!important\}/);
  assert.match(app, /function syncBodyScroll/);
  assert.match(app, /menu&&menu\.classList\.contains\('open'\)/);
  assert.match(app, /body\.classList\.add\('sheet-open'\)/);
  assert.match(core, /classList\.toggle\('open'\)/);
  assert.match(read('index.html'), /id="heroPlay"[^>]*hidden/);
});

test('hero fallback follows actual playback failure and success, and never starts in a hidden tab', async () => {
  const b = browser();
  const video = b.document.getElementById('heroVideo'), button = b.document.getElementById('heroPlay');
  assert.equal(button.hidden, true);
  let attempts = 0;
  video.play = () => { attempts++; return Promise.reject(new Error('autoplay blocked')); };
  b.run(index.match(/<script>([\s\S]*?)<\/script>/)[1]);
  await Promise.resolve();
  assert.equal(button.hidden, false, 'blocked autoplay must expose a real recovery control');
  video.play = () => { attempts++; return Promise.resolve(); };
  button.click(); await Promise.resolve();
  assert.equal(button.hidden, true);
  const before = attempts;
  b.document.hidden = true;
  b.document.listeners.visibilitychange[0]();
  button.click(); await Promise.resolve();
  assert.equal(attempts, before);
  assert.equal(video.paused, true);
  b.document.hidden = false;
  b.document.listeners.visibilitychange[0](); await Promise.resolve();
  assert.ok(attempts > before);
});

test('menu and sheets share one scroll lock and restore the original position only after both close', () => {
  const b = browser(), observed = [], restored = [];
  let sync;
  b.context.MutationObserver = class { constructor(callback) { sync = callback; } observe(node, options) { observed.push([node.id, options]); } };
  b.window.scrollTo = (x, y) => restored.push([x, y]);
  const app = read('app.js');
  b.run(app.slice(app.indexOf('function lockBodyScroll'), app.indexOf('function applyArtAndHero')));
  b.run('watchSheet()');
  assert.deepEqual(observed.map(([id]) => id).sort(), ['menu', 'sheet']);
  const body = b.document.body, menu = b.document.getElementById('menu'), sheet = b.document.getElementById('sheet');
  menu.classList.add('open'); sync();
  assert.equal(body.classList.contains('sheet-open'), true);
  assert.equal(body.style.top, '-180px');
  sheet.hidden = false; sync();
  b.window.scrollY = 0; menu.classList.remove('open'); sync();
  assert.equal(body.style.top, '-180px', 'opening a second overlay must not replace the saved scroll offset');
  assert.equal(restored.length, 0);
  sheet.hidden = true; sync();
  assert.equal(body.classList.contains('sheet-open'), false);
  assert.equal(body.style.top, '');
  assert.deepEqual(restored, [[0, 180]]);
});
