/* The hero picture starts loading from the page head and shows whole (not cropped left and right), the header counters have no circle,
   the tagline is a heavier sans and its shimmer line is longer, and the editor slims big pictures before they go up. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const early = read('hero-early.js');
const index = read('index.html');
const layer = read('design-layer.js');
const schema = read('design-schema.js');
const base = read('style-3.css');
const top = read('style.css');
const vercel = JSON.parse(read('vercel.json'));

const SUPA = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/uploads/2026/hero.png';

function run(json, { width = 393, size = { w: 800, h: 800 } } = {}) {
  const classes = new Set(), props = {}, images = [];
  const rootEl = {
    classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
    style: { setProperty: (k, v) => { props[k] = String(v); }, removeProperty: (k) => { delete props[k]; }, getPropertyValue: (k) => props[k] || '' },
  };
  function Image() { images.push(this); }
  const listeners = {};
  const window = { innerWidth: width, addEventListener: (t, f) => { listeners[t] = f; } };
  const requests = [];
  const fetch = async (url, opts) => { requests.push([url, opts]); return { ok: true, json: async () => json }; };
  vm.runInNewContext(early, { document: { documentElement: rootEl }, window, fetch, Image });
  const loaded = async () => { await window.__elanDesignJson; const img = images[images.length - 1]; if (img) { img.naturalWidth = size.w; img.naturalHeight = size.h; img.onload(); } return img; };
  return { classes, props, images, window, listeners, requests, loaded, setWidth: (w) => { window.innerWidth = w; } };
}
const design = (edits) => ({ version: 1, edits });

test('the page head loads hero-early.js (a plain external file, cached like the other scripts) before the body', () => {
  const head = index.slice(0, index.indexOf('</head>'));
  assert.match(head, /<script src="\/hero-early\.js\?v=[0-9A-Za-z-]+"><\/script>/);
  assert.ok(vercel.headers.some((r) => /hero-early\.js/.test(r.source) && r.headers.some((h) => h.key === 'Cache-Control')));
  assert.doesNotMatch(early, /(^|[^.\w])eval\s*\(|new\s+Function\s*\(|document\.write/);
});

test('it accepts exactly the media links design-schema.js accepts', () => {
  const prefixes = schema.match(/MEDIA_PREFIXES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const own = early.match(/PREFIXES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(own, prefixes);
  assert.equal(early.match(/IMAGE_EXT = (\/.*\/i);/)[1], schema.match(/IMAGE_EXT = (\/.*?\/i),/)[1]);
});

test('the design file is read at once, the picture download starts, and design-layer.js takes the same answer', async () => {
  const t = run(design({ all: { hero: { style: { media: SUPA } } } }));
  assert.equal(t.requests.length, 1);
  assert.equal(t.requests[0][0], '/design/home.json');
  assert.equal(t.requests[0][1].cache, 'no-store');
  await t.window.__elanDesignJson;
  assert.equal(t.images.length, 1);
  assert.equal(t.images[0].src, SUPA);
  assert.equal(t.images[0].fetchPriority, 'high');
  assert.match(layer, /window\.__elanDesignJson \|\| fetch\('\/design\/home\.json'/);
});

test('when the picture is in, the hero takes its proportions; a very wide one is shown whole over a blurred copy', async () => {
  let t = run(design({ all: { hero: { style: { media: SUPA } } } }), { size: { w: 800, h: 1000 } });
  await t.loaded();
  assert.equal(t.props['--hero-ar'], '0.8000');
  assert.equal(t.props['--hero-img'], 'url("' + SUPA + '")');
  assert.deepEqual([...t.classes].sort(), ['hero-fit']);

  t = run(design({ all: { hero: { style: { media: SUPA } } } }), { size: { w: 900, h: 600 }, width: 393 });
  await t.loaded();
  assert.deepEqual([...t.classes].sort(), ['hero-contain', 'hero-fit'], '393 / 1.5 = 262px is under the 360px minimum hero');
  t.setWidth(900); t.listeners.resize();
  assert.deepEqual([...t.classes].sort(), ['hero-fit'], 'on a wide screen the same picture is tall enough');
  t.setWidth(393); t.listeners.resize();
  assert.ok(t.classes.has('hero-contain'));
});

test('the size-specific hero picture wins over "all", a video or an unsafe link changes nothing, and an odd strip is ignored', async () => {
  const other = SUPA.replace('hero.png', 'mobile.webp');
  let t = run(design({ all: { hero: { style: { media: SUPA } } }, mobile: { hero: { style: { media: other } } } }), { width: 400 });
  await t.window.__elanDesignJson;
  assert.equal(t.images[0].src, other);
  t = run(design({ all: { hero: { style: { media: SUPA } } }, mobile: { hero: { style: { media: other } } } }), { width: 1200 });
  await t.window.__elanDesignJson;
  assert.equal(t.images[0].src, SUPA);
  for (const media of [SUPA.replace('.png', '.mp4'), 'https://evil.example/x.png', '/assets/../secret.png', SUPA + '"onerror="x', 42, '']) {
    t = run(design({ all: { hero: { style: { media } } } }));
    await t.window.__elanDesignJson;
    assert.equal(t.images.length, 0, String(media));
    assert.equal(t.classes.size, 0);
  }
  t = run(design({ all: { hero: { style: { media: SUPA } } } }), { size: { w: 3000, h: 100 } });
  await t.loaded();
  assert.equal(t.classes.size, 0, 'a strip 30 times wider than tall leaves the hero as it was');
});

test('design-layer.js tells hero-early.js about the hero picture (and clears it for a video or when the picture is removed)', () => {
  assert.match(layer, /window\.ElanHeroFit\(m\.kind === 'video' \? '' : m\.src\)/);
  assert.match(layer, /undo\.push\(function \(\) \{\s*if \(typeof window\.ElanHeroFit === 'function'\) window\.ElanHeroFit\(''\);/);
  const t = run(design({ all: { hero: { style: { media: SUPA } } } }));
  return t.loaded().then(() => {
    assert.ok(t.classes.has('hero-fit'));
    t.window.ElanHeroFit('');
    assert.equal(t.classes.size, 0);
    assert.equal(t.props['--hero-ar'], undefined);
    assert.equal(t.props['--hero-img'], undefined);
  });
});

test('hero CSS: the hero is as tall as the picture, within [360px, the screen and 9:16], and a wide picture sits whole over a blurred copy', () => {
  const rule = top.match(/html\.hero-fit #hero\{[^}]*\}/)[0];
  assert.match(rule, /height:auto !important/);
  assert.match(rule, /aspect-ratio:var\(--hero-ar\) !important/);
  assert.match(rule, /min-height:360px !important/);
  assert.match(rule, /max-height:min\(calc\(var\(--app-vh, 1vh\) \* 100\), calc\(100vw \* 16 \/ 9\)\) !important/, 'still never taller than 9:16');
  assert.match(top, /html\.hero-contain #hero::before\{[^}]*background-size:cover;filter:blur\(26px\)/);
  assert.match(top, /html\.hero-contain #hero::after\{[^}]*background-size:contain/);
});

test('header counters are only a number: no circle, no fill, gold on the page and white over the hero', () => {
  const rule = base.match(/header button\[data-n\]:not\(\[data-n="0"\]\):after\{[^}]*\}/)[0];
  assert.match(rule, /background:none/);
  assert.match(rule, /border-radius:0/);
  assert.match(rule, /color:#a37e2c/);
  assert.doesNotMatch(rule, /#c8962a|box-shadow/);
  assert.match(base, /body\.hd-over:not\(\.inner\):has\(#hero\[data-media\]\) header button\[data-n\]:not\(\[data-n="0"\]\):after\{color:#fff/);
  assert.match(base, /content:attr\(data-n\)/, 'the number still comes from data-n');
});

test('the tagline is a heavier, clearer sans and the gold shimmer under the logo is longer everywhere', () => {
  const rule = base.match(/header \.logo small,#menu \.logo small,\.alogo \.logo small\{[^}]*\}/)[0];
  assert.match(rule, /font-family:'IBM Plex Sans Arabic'/);
  assert.match(rule, /font-weight:700!important/);
  assert.doesNotMatch(rule, /Playfair/);
  assert.equal(Number(base.match(/\.logo i\{display:block;height:2px;width:(\d+)%/)[1]), 88);
  assert.equal(Number(top.match(/header \.logo i \{ width: (\d+)% !important; \}/)[1]), 80);
});

test('the editor slims a big PNG or JPEG into WebP before it goes up, and uploads the original when that does not help or fails', async () => {
  const src = read('editor/editor-media.js');
  const code = src.match(/var SLIM_OVER[\s\S]*?\n  async function slim\(file\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(src, /async function uploadPicture\(file\) \{\s*file = await slim\(file\);/);
  function File(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts.type; this.size = parts[0].size; }
  const canvas = { getContext: () => ({ drawImage: (b, x, y, w, h) => { canvas.drawn = [w, h]; } }), toBlob: (done) => done(canvas.blob) };
  const make = (extra) => vm.runInNewContext(code + ';slim', Object.assign({ File, document: { createElement: () => canvas }, createImageBitmap: async () => ({ width: 3000, height: 1500, close() {} }) }, extra));
  const original = (type, size, name) => ({ type, size, name: name || 'hero.png' });

  canvas.blob = { type: 'image/webp', size: 200000 };
  let slim = make();
  const out = await slim(original('image/png', 2194272));
  assert.equal(out.type, 'image/webp');
  assert.equal(out.name, 'hero.webp');
  assert.deepEqual(canvas.drawn, [2000, 1000], 'long side capped at 2000, proportions kept');

  const small = original('image/png', 300000);
  assert.equal(await slim(small), small, 'under 500 KB: untouched');
  const gif = original('image/gif', 5000000);
  assert.equal(await slim(gif), gif, 'GIFs may be animated');
  const webp = original('image/webp', 5000000);
  assert.equal(await slim(webp), webp);

  canvas.blob = { type: 'image/webp', size: 2000000 };
  const big = original('image/jpeg', 2100000, 'a.jpg');
  assert.equal(await slim(big), big, 'not at least 10% smaller: the original goes up');
  canvas.blob = null;
  assert.equal(await slim(big), big, 'no blob: the original goes up');
  canvas.blob = { type: 'image/png', size: 100 };
  assert.equal(await slim(big), big, 'the browser could not write WebP: the original goes up');

  slim = make({ createImageBitmap: undefined });
  assert.equal(await slim(big), big, 'no createImageBitmap: the original goes up');
  slim = make({ createImageBitmap: async () => { throw new Error('bad image'); } });
  assert.equal(await slim(big), big, 'any failure: the original goes up');
});
