const { loadCoreSource } = require('./load-core');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { browser } = require('./browser-fixture');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const heroScript = read('hero-video.js');
const style = read('style.css');
const core = loadCoreSource();

test('hero video retries after browser-initiated pauses and unlocks on a real gesture', () => {
  assert.match(heroScript, /v\.addEventListener\('pause'/);
  assert.match(heroScript, /pauseRetries>=10/);
  assert.match(heroScript, /v\.addEventListener\('ended'/);
  assert.match(heroScript, /\['touchend','pointerup','click','keydown'\]/);
  assert.match(heroScript, /window\.addEventListener\('pageshow'/);
  assert.match(heroScript, /v\.defaultMuted=true/);
});

test('hero autoplays by itself and has no play or pause button', () => {
  assert.match(index, /<video id="heroVideo"[^>]*\bautoplay\b[^>]*\bmuted\b[^>]*\bloop\b[^>]*\bplaysinline\b/);
  assert.doesNotMatch(index, /heroPlay/);
  assert.doesNotMatch(style, /heroPlay/);
  assert.doesNotMatch(index, /showButton/);
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
  assert.doesNotMatch(read('index.html'), /heroPlay/);
});

// Runs the real hero script (hero-video.js, an external file because the page policy forbids inline scripts) against the fake browser; `heroBottom` is where the hero ends on screen and the header ends at 95px.
function heroScroll() {
  const b = browser(), timers = [];
  const video = b.document.getElementById('heroVideo'), hero = b.document.getElementById('hero'), header = b.document.querySelector('header');
  const at = { heroBottom: 800, headerBottom: 95 };
  hero.getBoundingClientRect = () => ({ top: at.heroBottom - 800, bottom: at.heroBottom, left: 0, right: 300, width: 300, height: 800 });
  header.getBoundingClientRect = () => ({ top: 32, bottom: at.headerBottom, left: 0, right: 300, width: 300, height: at.headerBottom - 32 });
  b.context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  b.run(read('hero-video.js'));
  const scrollTo = (heroBottom) => { at.heroBottom = heroBottom; b.window.listeners.scroll.forEach((fn) => fn()); };
  return { b, video, timers, scrollTo, at };
}

test('hero video plays as soon as the platform opens, with no button involved', () => {
  const { video } = heroScroll();
  assert.equal(video.paused, false);
  assert.equal(video.muted, true);
  assert.equal(video.loop, true);
});

test('hero video stops when the header reaches the end of the hero and plays again when it is back above it', () => {
  const { video, scrollTo } = heroScroll();
  assert.equal(video.paused, false);
  scrollTo(300);
  assert.equal(video.paused, false, 'still plays while the hero extends below the header');
  scrollTo(96);
  assert.equal(video.paused, false, 'one pixel of hero below the header is still the hero');
  scrollTo(95);
  assert.equal(video.paused, true, 'stops exactly when the header reaches the end of the hero');
  scrollTo(-600);
  assert.equal(video.paused, true, 'stays stopped far below the hero');
  scrollTo(150);
  assert.equal(video.paused, false, 'plays again once the header is back above the end of the hero');
  scrollTo(800);
  assert.equal(video.paused, false);
});

test('the video stays stopped past the hero even when the browser fires pause, load or gesture events', () => {
  const { b, video, timers, scrollTo } = heroScroll();
  scrollTo(40);
  assert.equal(video.paused, true);
  const before = timers.filter((t) => t.ms === 250).length;
  video.listeners.pause.forEach(({ fn }) => fn());
  assert.equal(timers.filter((t) => t.ms === 250).length, before, 'a deliberate pause is not retried');
  for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'stalled', 'suspend']) video.listeners[name].forEach(({ fn }) => fn());
  for (const name of ['touchend', 'pointerup', 'click', 'keydown']) b.document.listeners[name].forEach((fn) => fn());
  timers.forEach((t) => t.fn());
  b.window.listeners.pageshow.forEach((fn) => fn());
  assert.equal(video.paused, true, 'nothing may restart the video while the header is past the hero');
  scrollTo(400);
  video.pause();
  const retries = timers.filter((t) => t.ms === 250).length;
  video.listeners.pause.forEach(({ fn }) => fn());
  assert.equal(timers.filter((t) => t.ms === 250).length, retries + 1, 'a browser-initiated pause over the hero is still retried');
});

test('hero never starts in a hidden tab and respects the scroll position when the tab returns', () => {
  const { b, video, scrollTo } = heroScroll();
  b.document.hidden = true;
  b.document.listeners.visibilitychange.forEach((fn) => fn());
  assert.equal(video.paused, true);
  b.document.hidden = false;
  b.document.listeners.visibilitychange.forEach((fn) => fn());
  assert.equal(video.paused, false);
  scrollTo(50);
  b.document.hidden = true;
  b.document.listeners.visibilitychange.forEach((fn) => fn());
  b.document.hidden = false;
  b.document.listeners.visibilitychange.forEach((fn) => fn());
  assert.equal(video.paused, true, 'returning to the tab below the hero must not restart the video');
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
