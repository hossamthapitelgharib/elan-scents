const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const style = read('style.css');
const core = read('app-core.js');
const vercel = JSON.parse(read('vercel.json'));

test('hero video retries after browser-initiated pauses and unlocks on a real gesture', () => {
  assert.match(index, /v\.addEventListener\('pause'/);
  assert.match(index, /pauseRetries>=10/);
  assert.match(index, /v\.addEventListener\('ended'/);
  assert.match(index, /\['touchend','pointerup','click','keydown'\]/);
  assert.match(index, /window\.addEventListener\('pageshow'/);
  assert.match(index, /v\.defaultMuted=true/);
});

test('hero play button is hidden once playback starts and shown when autoplay is blocked', () => {
  assert.match(index, /v\.addEventListener\('playing'/);
  assert.match(index, /showButton\(false\)/);
  assert.match(index, /showButton\(true\)/);
  assert.match(style, /#heroPlay\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('hero video and poster are cacheable so browsers can loop and seek without re-downloading', () => {
  const rule = (source) => vercel.headers.find((h) => h.source === source);
  for (const source of ['/assets/hero.mp4', '/assets/hero-poster.jpg']) {
    const cache = rule(source).headers.find((h) => h.key === 'Cache-Control');
    assert.match(cache.value, /max-age=31536000/);
    assert.match(cache.value, /immutable/);
  }
  assert.ok(rule('/assets/hero.mp4').headers.some((h) => h.key === 'Accept-Ranges' && h.value === 'bytes'));
  assert.match(index, /hero\.mp4\?v=/);
  assert.match(index, /hero-poster\.jpg\?v=/);
});

test('text autosizing and positioning are normalised across browser engines', () => {
  assert.match(style, /html\s*\{[^}]*-webkit-text-size-adjust:\s*100%/);
  assert.match(style, /html\s*\{[^}]*text-size-adjust:\s*100%/);
  assert.match(style, /\[dir=rtl\] #menu\s*\{\s*right:\s*0;\s*left:\s*auto/);
  assert.match(style, /\[dir=ltr\] #menu\s*\{\s*left:\s*0;\s*right:\s*auto/);
  assert.match(style, /#bar,header\s*\{\s*left:\s*0;\s*right:\s*0/);
});

test('signed-in cart resolves any store offer and no longer stalls on offers that are not the cheapest', () => {
  assert.match(core, /var SP_BY_ID=\{\}/);
  assert.match(core, /SP_BY_ID\[String\(x\.id\)\]=x\.product_size_id/);
  assert.match(core, /var sid=SP_BY_ID\[String\(id\)\];if\(sid&&byId\(sid\)\)found=sid/);
  assert.match(core, /if\(\(unmapped&&!PERFUMES\.length\)\|\|revision!==CART_REV\)return;/);
  assert.doesNotMatch(core, /if\(unmapped\|\|revision!==CART_REV\)return;/);
});

test('cart mapping fallback behaves correctly against a simulated catalog', () => {
  // Extract the two real functions from app-core.js and run them against a fake catalog.
  const grab = (name) => {
    const start = core.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    let depth = 0;
    for (let i = core.indexOf('{', start); i < core.length; i++) {
      if (core[i] === '{') depth++;
      if (core[i] === '}' && --depth === 0) return core.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
  };
  const src = `${grab('sidForStoreProduct')}\nreturn sidForStoreProduct;`;
  const build = (PERFUMES, SP_BY_ID) => new Function('PERFUMES', 'SP_BY_ID', 'byId', src)(
    PERFUMES, SP_BY_ID, (id) => PERFUMES.find((p) => p.id === id));
  const catalog = [{ id: 'size-1', offers: [{ storeProductId: 'sp-cheap' }] }];
  const resolve = build(catalog, { 'sp-cheap': 'size-1', 'sp-other-store': 'size-1', 'sp-delisted': 'size-gone' });
  assert.equal(resolve('sp-cheap'), 'size-1');
  assert.equal(resolve('sp-other-store'), 'size-1');
  assert.equal(resolve('sp-delisted'), '');
  assert.equal(resolve('sp-unknown'), '');
});
