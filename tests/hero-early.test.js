/* The hero picture starts loading before the page scripts (Link header from the build + hero-early.js in the head), is drawn whole on no
   background of its own, and nothing of the hero shows half-built; plus the header counters, the tagline and the editor's picture
   slimming. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
const build = require('../scripts/build-cloudflare.js');
const { designBrowser } = require('./browser-fixture');

const SUPA = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/uploads/2026/hero.jpg';

function run(json, { width = 393, named = '', map = '', classes: served = [], cached = false } = {}) {
  const classes = new Set(served), props = {}, images = [], timers = [];
  const rootEl = {
    classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) },
    style: { setProperty: (k, v) => { props[k] = String(v); }, removeProperty: (k) => { delete props[k]; } },
  };
  function Image() {
    images.push(this);
    let src;
    // A picture the Link preload already put in the memory cache is complete the moment src is set (checked in a real browser).
    Object.defineProperty(this, 'src', { get: () => src, set: (v) => { src = v; if (cached) { this.complete = true; this.naturalWidth = 540; this.naturalHeight = 960; } }, enumerable: true });
  }
  // `named` is what the stylesheet's --hero-img holds when the page itself already names its picture (the Cloudflare build does).
  const window = { innerWidth: width, getComputedStyle: () => ({ getPropertyValue: (name) => (name === '--hero-img' ? named : name === '--hero-map' ? map : '') }) };
  const requests = [];
  const fetch = async (url, opts) => { requests.push([url, opts]); if (json === 'fail') throw new Error('offline'); return { ok: true, json: async () => json }; };
  const sandbox = { document: { documentElement: rootEl }, window, fetch, Image, setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1] = null; } };
  vm.runInNewContext(early, sandbox);
  return { classes, props, images, window, requests, timers, ready: () => window.__elanDesignJson };
}
const design = (edits) => ({ version: 1, edits });
const heroOf = (media) => design({ all: { hero: { style: { media } } } });

test('the page head loads hero-early.js (a plain external file, cached like the other scripts) before the body', () => {
  const head = index.slice(0, index.indexOf('</head>'));
  assert.match(head, /<script src="\/hero-early\.js\?v=[0-9A-Za-z-]+"><\/script>/);
  assert.ok(vercel.headers.some((r) => /hero-early\.js/.test(r.source) && r.headers.some((h) => h.key === 'Cache-Control')));
  assert.doesNotMatch(early, /(^|[^.\w])eval\s*\(|new\s+Function\s*\(|document\.write/);
});

test('it accepts exactly the media links design-schema.js accepts, and so does the build', () => {
  const prefixes = schema.match(/MEDIA_PREFIXES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const own = early.match(/PREFIXES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(own, prefixes);
  const buildSource = read('scripts/build-cloudflare.js');
  assert.deepEqual(buildSource.match(/HERO_PREFIXES = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1)), prefixes);
  const ext = schema.match(/IMAGE_EXT = (\/.*?\/i),/)[1];
  assert.equal(early.match(/IMAGE_EXT = (\/.*\/i);/)[1], ext);
  assert.equal(buildSource.match(/HERO_IMAGE_EXT = (\/.*\/i);/)[1], ext);
});

test('the design file is read at once, the picture download starts, and design-layer.js takes the same answer', async () => {
  const t = run(heroOf(SUPA));
  assert.equal(t.requests.length, 1);
  assert.equal(t.requests[0][0], '/design/home.json');
  assert.equal(t.requests[0][1].cache, 'no-store');
  assert.ok(t.classes.has('hero-pending'), 'pending from the first moment: no bare hero while the design file is on its way');
  await t.ready();
  assert.equal(t.images.length, 1);
  assert.equal(t.images[0].src, SUPA);
  assert.equal(t.images[0].fetchPriority, 'high');
  assert.equal(t.props['--hero-img'], 'url("' + SUPA + '")');
  assert.deepEqual([...t.classes].sort(), ['hero-img', 'hero-pending']);
  assert.match(layer, /window\.__elanDesignJson \|\| fetch\('\/design\/home\.json'/);
});

test('the hero waits for its picture (veil, title, counters, header colours) and is released when it loads, fails or takes too long', async () => {
  let t = run(heroOf(SUPA));
  await t.ready();
  t.images[0].onload();
  assert.deepEqual([...t.classes], ['hero-img']);

  t = run(heroOf(SUPA));
  await t.ready();
  t.images[0].onerror();
  assert.deepEqual([...t.classes], [], 'a picture that will not load leaves the hero as it was, not empty');
  assert.equal(t.props['--hero-img'], undefined);

  t = run(heroOf(SUPA));
  await t.ready();
  const timeout = t.timers.filter(Boolean).find(([, ms]) => ms === 15000);
  assert.ok(timeout, 'a 15 s safety release');
  timeout[0]();
  assert.deepEqual([...t.classes].sort(), ['hero-img'], 'released after 15 s even if the picture is still coming');
});

test('a design without a hero picture, a video, an unsafe link or a failed fetch releases the hero at once', async () => {
  const cases = [design({}), design({ all: { hero: { style: {} } } }), heroOf(SUPA.replace('.jpg', '.mp4')), heroOf('https://evil.example/x.png'), heroOf('/assets/../secret.png'), heroOf(SUPA + '"onerror="x'), heroOf(42), heroOf(''), null, 'fail'];
  for (const json of cases) {
    const t = run(json);
    await t.ready();
    assert.equal(t.images.length, 0, JSON.stringify(json));
    assert.equal(t.classes.size, 0, JSON.stringify(json));
  }
});

test('the size-specific hero picture wins over "all"', async () => {
  const other = SUPA.replace('hero.jpg', 'mobile.webp');
  const json = design({ all: { hero: { style: { media: SUPA } } }, mobile: { hero: { style: { media: other } } } });
  let t = run(json, { width: 400 });
  await t.ready();
  assert.equal(t.images[0].src, other);
  t = run(json, { width: 1200 });
  await t.ready();
  assert.equal(t.images[0].src, SUPA);
});

test('design-layer.js tells hero-early.js about the hero picture (and clears it for a video or when the picture is removed)', async () => {
  assert.match(layer, /window\.ElanHeroFit\(m\.kind === 'video' \? '' : m\.src\)/);
  assert.match(layer, /undo\.push\(function \(\) \{\s*if \(typeof window\.ElanHeroFit === 'function'\) window\.ElanHeroFit\(''\);/);
  const t = run(heroOf(SUPA));
  await t.ready();
  t.images[0].onload();
  t.window.ElanHeroFit('');
  assert.equal(t.classes.size, 0);
  assert.equal(t.props['--hero-img'], undefined);
  t.window.ElanHeroFit(SUPA.replace('hero.jpg', 'new.jpg'));
  assert.equal(t.images.length, 2, 'a picture chosen in the editor starts loading at once');
  assert.ok(t.classes.has('hero-pending'));
});

test('a page that names its picture (the Cloudflare build) starts tracking it before the design file answers, and the design file still wins', async () => {
  const named = ' url("' + SUPA + '") ';
  let t = run(heroOf(SUPA), { named, classes: ['hero-img'] });
  assert.equal(t.images.length, 1, 'the named picture is tracked at once, before the design file has answered');
  assert.equal(t.images[0].src, SUPA);
  assert.ok(t.classes.has('hero-pending'));
  await t.ready();
  assert.equal(t.images.length, 1, 'the design names the same picture: nothing restarts');
  t.images[0].onload();
  assert.deepEqual([...t.classes].sort(), ['hero-img'], 'the header and the veil come as soon as the picture is in');

  const other = SUPA.replace('hero.jpg', 'new.jpg');
  t = run(heroOf(other), { named, classes: ['hero-img'] });
  await t.ready();
  assert.deepEqual(t.images.map((i) => i.src), [SUPA, other], 'a newer design replaces what the page was built with');
  assert.equal(t.props['--hero-img'], 'url("' + other + '")');

  t = run('fail', { named, classes: ['hero-img'] });
  await t.ready();
  assert.ok(t.classes.has('hero-img'), 'a failed design fetch keeps the picture the page was built with');
  assert.ok(t.classes.has('hero-pending'), 'and keeps waiting for it');
  t = run(design({}), { named, classes: ['hero-img'] });
  await t.ready();
  assert.equal(t.classes.size, 0, 'no picture in the design: nothing of the served hero is left');

  // Things the page could name that are not a hero picture are ignored.
  for (const bad of ['', 'none', 'url("https://evil.example/x.png")', 'url("/assets/../x.png")', 'url("/assets/x.mp4")']) {
    t = run(design({}), { named: bad });
    assert.equal(t.images.length, 0, bad);
  }
});

test('where the build copied the picture to this site, the design\'s Supabase address is swapped for the copy, and a broken copy falls back to the design\'s own address', async () => {
  const COPY = '/assets/hero/0123456789abcdef0123.jpg';
  const named = ' url("' + COPY + '") ';
  const map = '"' + SUPA + ' ' + COPY + '"';

  // The page names the copy; the design names the Supabase address: one picture, one download, nothing restarts.
  let t = run(heroOf(SUPA), { named, map, classes: ['hero-img'], cached: true });
  await t.ready();
  assert.deepEqual(t.images.map((i) => i.src), [COPY], 'the Supabase address is never requested');
  assert.deepEqual([...t.classes], ['hero-img']);
  assert.equal(t.props['--hero-img'], 'url("' + COPY + '")');
  t.window.ElanHeroFit(SUPA);                                  // design-layer.js asks with the design\'s address
  assert.equal(t.images.length, 1, 'asking again with the design address changes nothing');

  // A picture the build knew nothing about (chosen in the editor, or a newer design) is used as it is.
  const other = SUPA.replace('hero.jpg', 'new.jpg');
  t = run(heroOf(other), { named, map, classes: ['hero-img'] });
  await t.ready();
  assert.deepEqual(t.images.map((i) => i.src), [COPY, other]);

  // Single quotes, several pairs and junk in the map: only well-formed safe pairs count.
  const OTHER_COPY = '/assets/hero/aaaaaaaaaaaaaaaaaaaa.webp';
  t = run(heroOf(other), { map: "'" + SUPA + ' ' + COPY + ' ' + other + ' ' + OTHER_COPY + " https://evil.example/x.png /assets/x.png /assets/../y.png /assets/z.mp4'" });
  await t.ready();
  assert.deepEqual(t.images.map((i) => i.src), [OTHER_COPY]);
  t = run(heroOf(SUPA), { map: 'not a string' });
  await t.ready();
  assert.deepEqual(t.images.map((i) => i.src), [SUPA], 'a map the page does not have, or a broken one, changes nothing');

  // The copy is missing or broken: fall back to the design's address (one more try, then the usual "no picture" rules).
  t = run(heroOf(SUPA), { named, map, classes: ['hero-img'] });
  await t.ready();
  assert.equal(t.images.length, 1);
  t.images[0].onerror();
  assert.deepEqual(t.images.map((i) => i.src), [COPY, SUPA]);
  assert.equal(t.props['--hero-img'], 'url("' + SUPA + '")');
  assert.ok(t.classes.has('hero-img') && t.classes.has('hero-pending'), 'still waiting for the picture, which is now the design\'s own');
  t.images[1].onload();
  assert.deepEqual([...t.classes], ['hero-img']);
  t.window.ElanHeroFit(SUPA);
  assert.equal(t.images.length, 2, 'and design-layer.js asking with that address does not start a third download');
  t.images[1].onerror();                                       // a second failure is final
  assert.equal(t.classes.size, 0);
});

test('a picture that is already here (repeat visit) clears the waiting state before the first frame; a picture still coming clears it when it loads', async () => {
  const named = ' url("' + SUPA + '") ';
  let t = run(heroOf(SUPA), { named, classes: ['hero-img'], cached: true });
  assert.deepEqual([...t.classes], ['hero-img'], 'final from the first moment: no pending state, so the veil and the header colours are in the first frame too');
  await t.ready();
  assert.deepEqual([...t.classes], ['hero-img'], 'and the design file agreeing with it changes nothing');

  t = run(heroOf(SUPA), { named, classes: ['hero-img'] });
  assert.ok(t.classes.has('hero-pending'), 'a picture still on its way keeps the hero waiting');
  t.images[0].onload();
  assert.deepEqual([...t.classes], ['hero-img']);

  // A newer design picture is a new wait, even when the page was served with the old one.
  const other = SUPA.replace('hero.jpg', 'new.jpg');
  t = run(heroOf(other), { named, classes: ['hero-img'], cached: true });
  await t.ready();
  assert.equal(t.images.length, 2);
  assert.deepEqual([...t.classes], ['hero-img'], 'the new one was complete too');
});

test('hero CSS: the blurred copy reaches past the hero so its fade is clipped, nothing is drawn while pending, and --app-vh has a first-frame value', () => {
  assert.match(top, /html\.hero-img #hero::before \{ inset: -80px; background-size: cover; filter: blur\(26px\); \}/, 'bleed of about three blur radii: no lighter stripe at the page edges');
  assert.match(top, /html\.hero-pending #hero::before,\s*html\.hero-pending #hero::after \{\s*visibility: hidden;/);
  assert.match(top, /:root \{ --app-vh: 1vh; \}\s*@supports \(height: 1svh\) \{ :root \{ --app-vh: 1svh; \} \}/, 'the hero height is the final one before app-core.js runs');
  assert.doesNotMatch(top + early, /hero-fade|--hero-ratio|mask-image/, 'no edge softening of the picture');
  assert.match(index, /<body class="hd-over bar-over">/, 'the page opens in the header-over-hero state, so the header is in its white state in the first frame (app-core.js corrects it when scrolled)');
});

test('the hero looks the same in every browser: on a phone its height comes from the width alone, and the page asks the browser for no safe-area insets', () => {
  // A phone's hero is exactly 9:16 of its width, whatever bars the browser has: a height taken from the screen gave every browser its own
  // hero, and a screen shorter than 16/9 of its width left blurred stripes down both sides of a 9:16 picture.
  assert.match(top, /@media \(max-width: 639px\) \{ :root \{ --hero-h: calc\(100vw \* 16 \/ 9\); \} \}/);
  assert.equal(early.match(/width < 640 \? 'mobile'/).length, 1, 'the same 640px line hero-early.js calls mobile');
  // The page used to opt in to viewport-fit=cover and pad itself with env(safe-area-inset-*). Firefox for Android then reported about
  // 48px at the top and 17px at the bottom in an ordinary tab: a white strip above the hero, the header and the ticker pushed down, and
  // the WhatsApp button lifted. Without the opt-in the browser keeps the page inside its own bars, the same way in every browser.
  assert.doesNotMatch(index, /viewport-fit/);
  assert.match(index, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.doesNotMatch(base + top, /env\(\s*safe-area-inset/, 'nothing on the storefront reads a safe-area inset any more');
});

test('the hero picture is drawn by one mechanism: design-layer.js adds no second, cropped copy as a background of the hero', () => {
  const b = designBrowser();
  const calls = [];
  b.window.ElanHeroFit = (src) => calls.push(src);
  b.layer.set({ version: 1, edits: { all: { hero: { style: { media: SUPA } } } } });
  const hero = b.document.getElementById('hero');
  assert.deepEqual(calls, [SUPA]);
  assert.equal(hero.getAttribute('data-media'), 'image');
  assert.equal(hero.style.backgroundImage, '', 'nothing is painted on the hero itself');
  assert.equal(b.document.getElementById('heroVideo').style.display, 'none', 'the old video is still hidden');

  const plain = designBrowser();                      // a page without hero-early.js keeps the picture
  plain.layer.set({ version: 1, edits: { all: { hero: { style: { media: SUPA } } } } });
  assert.match(plain.document.getElementById('hero').style.backgroundImage, /hero\.jpg/);
});

test('hero CSS: no background of its own, the picture whole over a blurred copy, nothing half-built while it is pending', () => {
  assert.match(top, /#hero,\s*#hero video,\s*#heroVideo \{\s*background: transparent !important;\s*\}/);
    assert.match(top, /html\.hero-img #hero::after \{ background-size: contain; \}/);
  assert.match(top, /background-image: var\(--hero-img\);/);
  assert.match(top, /html\.hero-pending #hero \.hero-overlay \{\s*visibility: hidden !important;/);
  assert.doesNotMatch(top, /html\.hero-pending #hero \.(?:magic|counters)/, 'the title and counters are not on the hero any more, so there is nothing of theirs to hide');
  assert.doesNotMatch(top, /hero-fit|hero-contain|--hero-ar/, 'the height-follows-the-picture version is gone: nothing moves when the picture arrives');
  assert.doesNotMatch(top + base, /#hero\s*\{[^}]*background:\s*#(?!fff\b)[0-9a-f]{3,6}/i, 'no dark placeholder either');
});

test('header colours turn white only once the hero picture is in (never white on a bare page)', () => {
  for (const selector of ['header \\.ic svg\\{stroke:#fff\\}', 'header #lg\\{', '#bar \\.gold\\{', 'header button\\[data-n\\]']) {
    const found = base.match(new RegExp('html:not\\(\\.hero-pending\\) body\\.(?:hd|bar)-over:not\\(\\.inner\\):has\\(#hero\\[data-media\\]\\) ' + selector));
    assert.ok(found, selector);
  }
});

test('the veil and the white header colours go with the hero picture hero-early.js knows about, not with the later data-media mark', () => {
  assert.match(top, /html:not\(\.hero-img\) #hero:not\(\[data-media\]\) \.hero-overlay \{\s*display: none !important;/);
  assert.doesNotMatch(top, /(^|\n)#hero:not\(\[data-media\]\)/, 'every no-media look is switched off when a hero picture is on its way');
  for (const selector of ['header #lg\\{', '#bar \\.gold\\{', 'header button\\[data-n\\]']) {
    assert.ok(new RegExp('\\nhtml\\.hero-img:not\\(\\.hero-pending\\) body\\.(?:hd|bar)-over:not\\(\\.inner\\) ' + selector).test(base), selector);
  }
  // The icons need body:has(#gh): the gold icon rule carries that id in its specificity, and without it this white state lost to it
  // until design-layer.js wrote data-media (a beat after the logo's words turned white).
  assert.ok(base.includes('\nhtml.hero-img:not(.hero-pending) body:has(#gh).hd-over:not(.inner) header .ic svg{stroke:#fff}'));
  assert.ok(base.includes('\nbody:has(#gh) header .ic svg{stroke:url(#gh)}'), 'the premise: the gold rule it has to beat');
});

test('the Cloudflare build sends the hero picture as a Link preload header on the storefront page', () => {
  assert.deepEqual(build.heroPreloadLinks(root).map((l) => l.replace(/^<[^>]+>/, '<url>')), ['<url>; rel=preload; as=image; fetchpriority=high']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-link-'));
  try {
    fs.mkdirSync(path.join(dir, 'design'));
    const put = (edits) => fs.writeFileSync(path.join(dir, 'design', 'home.json'), JSON.stringify({ edits }));
    const mobile = SUPA.replace('hero.jpg', 'm.webp');
    put({ all: { hero: { style: { media: SUPA } } } });
    assert.deepEqual(build.heroPreloadLinks(dir), ['<' + SUPA + '>; rel=preload; as=image; fetchpriority=high']);
    put({ all: { hero: { style: { media: SUPA } } }, mobile: { hero: { style: { media: mobile } } } });
    const links = build.heroPreloadLinks(dir);
    assert.equal(links.length, 3);
    assert.match(links.find((l) => l.includes('m.webp')), /media="\(max-width: 639px\)"/);
    assert.match(links.find((l) => l.includes('hero.jpg') && /min-width: 1024px/.test(l)), /^<[^>]+>; rel=preload; as=image; fetchpriority=high; media="\(min-width: 1024px\)"$/);
    for (const bad of [SUPA.replace('.jpg', '.mp4'), 'https://evil.example/x.png', SUPA + ',<https://evil.example/x>', SUPA + ';rel=x', '/assets/../x.png', '', 7]) {
      put({ all: { hero: { style: { media: bad } } } });
      assert.deepEqual(build.heroPreloadLinks(dir), [], String(bad));
    }
    assert.deepEqual(build.heroPreloadLinks(path.join(dir, 'nowhere')), []);
    const file = build.buildHeadersFile(['index.html'], { headers: [{ source: '/index.html', headers: [{ key: 'Cache-Control', value: 'no-store' }] }] }, { heroLinks: ['<' + SUPA + '>; rel=preload; as=image'] });
    for (const pattern of ['/index.html', '/']) {
      const block = file.split('\n\n').find((b) => b.split('\n')[0] === pattern);
      assert.ok(block && /\n  Link: </.test(block), pattern + ' carries the Link header');
    }
    assert.match(file.split('\n\n').find((b) => b.split('\n')[0] === '/index.html'), /Cache-Control: no-store/, 'the page keeps its own rule');
    assert.equal(build.buildHeadersFile(['index.html'], { headers: [] }, { heroLinks: [] }).includes('Link:'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Cloudflare build writes the hero picture into the storefront page, so the first frame already shows it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-first-'));
  try {
    const mobile = SUPA.replace('hero.jpg', 'm.webp');
    const put = (edits) => { fs.mkdirSync(path.join(dir, 'design'), { recursive: true }); fs.writeFileSync(path.join(dir, 'design', 'home.json'), JSON.stringify({ edits })); };

    // The real design and the real page: one picture for every screen size.
    const real = build.withHeroFirstPaint(index, build.heroPicturesByScreen(root));
    assert.match(real, /^<!DOCTYPE html>\n<html lang="ar" dir="rtl" class="hero-img">\n/);
    const style = real.match(/<!--hero-first--><style>([^<]*)<\/style><!--\/hero-first-->\n/);
    assert.ok(style, 'one marked style block');
    assert.match(style[1], /^:root\{--hero-img:url\("(?:\/assets\/|https:\/\/sbgdtuqfrnfeggkwqtrw\.supabase\.co\/storage\/v1\/object\/public\/site-media\/)[^"]+\.(?:jpe?g|png|webp|gif|avif)"\)\}$/);
    assert.ok(real.indexOf('<!--hero-first-->') < real.indexOf('<link rel="stylesheet"'), 'before the first stylesheet, so it is parsed with the first style');
    assert.ok(real.indexOf('<!--/hero-first-->') < real.indexOf('<script src="/hero-early.js'), 'and before hero-early.js reads it');
    assert.equal(build.withoutHeroFirstPaint(real), index, 'taking the block out gives back the source page, byte for byte');
    assert.equal(build.withHeroFirstPaint(real, build.heroPicturesByScreen(root)), real, 'running it twice changes nothing');

    // Per-screen pictures keep their screen: a media query each, only for the sizes that have a picture.
    put({ all: { hero: { style: { media: SUPA } } }, mobile: { hero: { style: { media: mobile } } } });
    const mixed = build.withHeroFirstPaint(index, build.heroPicturesByScreen(dir));
    const css = mixed.match(/<!--hero-first--><style>([^<]*)<\/style>/)[1];
    assert.ok(css.includes('@media (max-width: 639px){:root{--hero-img:url("' + mobile + '")}}'));
    assert.ok(css.includes('@media (min-width: 640px) and (max-width: 1023px){:root{--hero-img:url("' + SUPA + '")}}'));
    assert.ok(css.includes('@media (min-width: 1024px){:root{--hero-img:url("' + SUPA + '")}}'));
    assert.equal(build.withoutHeroFirstPaint(mixed), index);

    // No picture (nothing, a video, an address the page would not accept): the page is left exactly as it is.
    for (const media of ['', SUPA.replace('.jpg', '.mp4'), 'https://evil.example/x.png', '/assets/../x.png', SUPA + '")}</style><script>x</script>', 7]) {
      put({ all: { hero: { style: { media } } } });
      assert.equal(build.withHeroFirstPaint(index, build.heroPicturesByScreen(dir)), index, String(media));
    }
    assert.equal(build.withHeroFirstPaint(index, build.heroPicturesByScreen(path.join(dir, 'nowhere'))), index);

    // A page that does not look like the storefront's (a class already on <html>, no stylesheet link) is not touched.
    put({ all: { hero: { style: { media: SUPA } } } });
    const by = build.heroPicturesByScreen(dir);
    const withClass = index.replace('<html lang="ar" dir="rtl">', '<html lang="ar" dir="rtl" class="x">');
    assert.equal(build.withHeroFirstPaint(withClass, by), withClass);
    const noLink = index.replace(/<link rel="stylesheet"[^>]*>\n/g, '');
    assert.equal(build.withHeroFirstPaint(noLink, by), noLink);
    assert.equal(build.withoutHeroFirstPaint('<html></html>'), '<html></html>');

    // The built folder: the storefront page carries it, nothing else does, and the page is still the source apart from the block.
    const out = path.join(dir, 'dist');
    const gen = path.join(dir, 'gen');
    build.build({ root, outDir: out, generatedDir: gen });
    const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(page.includes('<!--hero-first-->') && page.startsWith('<!DOCTYPE html>\n<html lang="ar" dir="rtl" class="hero-img">'));
    assert.equal(build.withoutHeroFirstPaint(page), index);
    for (const other of ['privacy.html', 'account.html']) if (fs.existsSync(path.join(out, other))) assert.doesNotMatch(fs.readFileSync(path.join(out, other), 'utf8'), /hero-first/, other);
    assert.doesNotMatch(index, /hero-first/, 'the source page stays as the editor and Railway serve it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the faces of the logo, the tagline and the strip are preloaded, so the logo does not change width after the page opens', () => {
  const head = index.slice(0, index.indexOf('</head>'));
  const preloads = [...head.matchAll(/<link rel="preload" href="(\/assets\/fonts\/[^"]+\.woff2)" as="font" type="font\/woff2" crossorigin>/g)].map((m) => m[1]);
  assert.deepEqual(preloads.sort(), ['/assets/fonts/ibm-plex-sans-arabic-500.woff2', '/assets/fonts/ibm-plex-sans-arabic-600.woff2', '/assets/fonts/playfair-display-600.woff2', '/assets/fonts/playfair-display-700.woff2']);
  const fonts = read('fonts.css');
  for (const href of preloads) {
    assert.ok(fs.existsSync(path.join(root, href.slice(1))), href + ' exists');
    assert.ok(fonts.includes("url('" + href + "')"), href + ' is the file fonts.css names for that face (a preload of any other URL would be fetched twice)');
  }
  assert.ok(head.indexOf('rel="preload" href="/assets/fonts/') < head.indexOf('<link rel="stylesheet"'), 'before the stylesheets, so the fetch starts first');
});

test('header counters are only a number: no circle, no fill, gold on the page and white over the hero', () => {
  const rule = base.match(/header button\[data-n\]:not\(\[data-n="0"\]\):after\{[^}]*\}/)[0];
  assert.match(rule, /background:none/);
  assert.match(rule, /border-radius:0/);
  assert.match(rule, /color:#a37e2c/);
  assert.doesNotMatch(rule, /#c8962a|box-shadow/);
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
