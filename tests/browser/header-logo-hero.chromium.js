'use strict';
/* Owner, 2026-11-27: «لون الذهبي بتاع اسم إيلان في الهيدر مش واضح من خلفية صورة الهيرو». Measured on his phone screenshot: the gold of «Élan» is 3.7:1 against the dark water behind it and 1.1:1 against the white spray,
   so no single gold reads on the whole word. The fix he chose to try (his option 4):
   a lighter glossy gold for the word, and over a hero that carries a picture or video, while the header is still over it, a soft dark shade behind the whole logo (header::before, NOT .logo: below 380px .logo is
   overflow:hidden and would cut the shade to a box). If he does not like the shade the word goes white like the rest of the header over the hero (his option 2) and the shade tests below change with it.
   Then, after trying it, he said (27 Nov 19:26) «I like the new shade of the gold, keep it fixed, it must not go back to the old one anywhere on the platform»: the lighter gold is the word's colour on the header over the hero
   AND after it, on the inner pages, in the menu, in the About section and on the orders page; only the shade is limited to the hero.
   The shade is cut at the hero's bottom edge (--hcut, written by hdTone()) and fades to nothing at the edges of its own box (his screenshot of 27 Nov 14:23 showed it spilling onto the white page and the title under the hero,
   with a faint box at its two ends); both are measured on the pixels: the screenshot with the shade and the screenshot without it.
   The readability is measured on the pixels, not on the CSS: the same word over a light spray-coloured hero, glyph pixels against the picture under them (WCAG contrast), with the hero we serve ourselves so it does not depend
   on what the owner saved. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

const MEDIA = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/uploads/test/spray.png';
/* The worst case for a gold word: the colour of sea spray, a light grey-blue. */
const SPRAY = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="#a9bcc4"/></svg>';
const LIGHT_GOLD = 'rgb(255, 224, 138)';   // the first stop of the lighter gold, the word's colour everywhere
const OLD_GOLD = 'rgb(243, 201, 79)';      // the first stop of the old `.gold`, which the word never goes back to

async function openHome(size) {
  const { context } = await H.openContext(browser, server, size);
  await context.route('**/storage/v1/object/public/site-media/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SPRAY, headers: { 'access-control-allow-origin': '*' } }));
  const page = await context.newPage();
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.ElanDesignLayer && ElanDesignLayer.current() !== null && typeof document.getElementById('mb').onclick === 'function', null, { timeout: 15000 });
  await H.quiet(page);
  return { context, page };
}
/* A design of our own: with or without a picture on the hero (never the one the owner saved). */
async function setHero(page, withMedia) {
  await page.evaluate((a) => { const edits = { all: {} }; if (a.withMedia) edits.all.hero = { style: { media: a.url } }; ElanDesignLayer.set({ version: 1, edits }); }, { withMedia, url: MEDIA });
  if (withMedia) await page.waitForFunction(() => { const h = document.getElementById('hero'); return h && h.hasAttribute('data-media'); }, null, { timeout: 10000 });
  else await page.waitForFunction(() => { const h = document.getElementById('hero'); return h && !h.hasAttribute('data-media'); }, null, { timeout: 10000 });
  await page.evaluate(() => { window.dispatchEvent(new Event('scroll')); window.dispatchEvent(new Event('resize')); });
  await H.quiet(page);
}
const state = (page) => page.evaluate(() => {
  const h = document.querySelector('header'), b = h.querySelector('.logo b'), s = getComputedStyle(h, '::before');
  /* the width of what the visitor sees of the logo (the word, "Scents", the tagline), not of the .logo box, which a grid column can stretch far beyond it */
  const parts = ['.logo b', '.logo span', '.logo small'].map((q) => { const r = document.createRange(); r.selectNodeContents(h.querySelector(q)); return r.getBoundingClientRect(); });   // the text, not a block that fills its column
  const seen = Math.max.apply(null, parts.map((r) => r.right)) - Math.min.apply(null, parts.map((r) => r.left));
  return { over: document.body.classList.contains('hd-over'), inner: document.body.classList.contains('inner'), halo: s.opacity, haloW: parseFloat(s.width), logoW: seen, gold: getComputedStyle(b).backgroundImage };
});
const settled = (page, want) => page.waitForFunction((o) => getComputedStyle(document.querySelector('header'), '::before').opacity === o, want, { timeout: 5000 });

/* The word's glyph pixels against the picture under them: the screenshot with the word and the screenshot with it hidden (the shade stays), the pixels that differ are the word. */
async function wordContrast(page) {
  const rect = await page.evaluate(() => { const b = document.querySelector('header .logo b').getBoundingClientRect(); return { x: Math.max(0, Math.floor(b.x)), y: Math.max(0, Math.floor(b.y)), width: Math.ceil(b.width), height: Math.ceil(b.height) }; });
  const withWord = await page.screenshot({ clip: rect });
  const hide = await page.addStyleTag({ content: 'header .logo b{visibility:hidden!important}' });
  const without = await page.screenshot({ clip: rect });
  await hide.evaluate((n) => n.remove());
  return page.evaluate(async (pair) => {
    const load = async (s) => { const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height; const cx = cv.getContext('2d'); cx.drawImage(bmp, 0, 0); return cx.getImageData(0, 0, bmp.width, bmp.height).data; };
    const a = await load(pair[0]), b = await load(pair[1]);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = (d, i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
    const ratios = [];
    for (let i = 0; i < a.length; i += 4) {
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) <= 24) continue;
      const x = lum(a, i), y = lum(b, i); ratios.push((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05));
    }
    ratios.sort((p, q) => p - q);
    return { n: ratios.length, median: ratios[Math.floor(ratios.length / 2)] || 0, readable: ratios.length ? ratios.filter((r) => r >= 3).length / ratios.length : 0 };
  }, [withWord.toString('base64'), without.toString('base64')]);
}

/* The same clip with the shade and without it (the shade switched off): the largest per-channel difference over the whole clip and over its outer frame (two CSS pixels at the left, the right and the top). */
async function shadeDiff(page, clip) {
  const withShade = await page.screenshot({ clip, animations: 'disabled' });
  const hide = await page.addStyleTag({ content: 'header::before{display:none!important}' });
  const without = await page.screenshot({ clip, animations: 'disabled' });
  await hide.evaluate((n) => n.remove());
  return page.evaluate(async (a) => {
    const load = async (s) => { const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height; const cx = cv.getContext('2d'); cx.drawImage(bmp, 0, 0); return { d: cx.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height }; };
    const A = await load(a.pair[0]), B = await load(a.pair[1]), fr = Math.max(2, Math.round(2 * A.w / a.cssW));
    const out = { max: 0, left: 0, right: 0, top: 0 };
    for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
      const i = (y * A.w + x) * 4, v = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2]));
      if (v > out.max) out.max = v;
      if (x < fr && v > out.left) out.left = v;
      if (x >= A.w - fr && v > out.right) out.right = v;
      if (y < fr && v > out.top) out.top = v;
    }
    return out;
  }, { pair: [withShade.toString('base64'), without.toString('base64')], cssW: clip.width });
}

for (const size of H.WIDTHS) {
  test('at ' + size.width + 'px over a hero picture «Élan» is the lighter gold with the shade behind the logo, and it reads even over a light, spray-coloured picture', async () => {
    const { context, page } = await openHome(size);
    try {
      await setHero(page, true);
      await settled(page, '1');
      const s = await state(page);
      assert.ok(s.over && !s.inner, 'the header is over the hero: ' + JSON.stringify(s));
      assert.equal(s.halo, '1', 'the shade is on behind the logo');
      assert.ok(s.gold.includes(LIGHT_GOLD), 'the word is the lighter gold: ' + s.gold);
      assert.ok(s.haloW > s.logoW + 20, 'the shade is wider than what the visitor sees of the logo, so .logo\'s overflow:hidden below 380px does not cut it to a rectangle: ' + s.haloW + ' vs ' + s.logoW);
      const c = await wordContrast(page);
      assert.ok(c.n > 300, 'the word was found in the screenshot: ' + JSON.stringify(c));
      assert.ok(c.median >= 3.5, 'the word has a contrast of 3.5:1 or more against the picture under it (median of its pixels): ' + JSON.stringify(c));
      assert.ok(c.readable >= 0.6, 'at least 60% of the word\'s pixels are at 3:1 or more (the owner\'s screenshot had 20%): ' + JSON.stringify(c));
    } finally { await context.close(); }
  });

  test('at ' + size.width + 'px the shade is gone once the header is past the hero, on an inner page, and when the hero has no picture, while the word keeps the same lighter gold in all three', async () => {
    const { context, page } = await openHome(size);
    try {
      await setHero(page, true);
      await settled(page, '1');
      // scrolled past the hero: the header is over the white page
      await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.getElementById('hero').getBoundingClientRect().height + 400); });
      await page.waitForFunction(() => !document.body.classList.contains('hd-over'), null, { timeout: 5000 });
      await settled(page, '0');
      let s = await state(page);
      assert.equal(s.halo, '0', 'no shade once the header is past the hero');
      assert.ok(s.gold.includes(LIGHT_GOLD) && !s.gold.includes(OLD_GOLD), 'past the hero the word is still the lighter gold, not the old one (owner, 27 Nov 19:26): ' + s.gold);
      // back at the top, then an inner page
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(() => document.body.classList.contains('hd-over'), null, { timeout: 5000 });
      await settled(page, '1');
      await page.evaluate(() => go('sec|brands'));
      await page.waitForFunction(() => document.body.classList.contains('inner'), null, { timeout: 5000 });
      await settled(page, '0');
      s = await state(page);
      assert.equal(s.halo, '0', 'no shade on an inner page');
      assert.ok(s.gold.includes(LIGHT_GOLD) && !s.gold.includes(OLD_GOLD), 'the word keeps the lighter gold on an inner page: ' + s.gold);
      await page.evaluate(() => { document.querySelector('#view .bc a[data-bc="0"]').click(); });
      await page.waitForFunction(() => !document.body.classList.contains('inner'), null, { timeout: 5000 });
      // a hero with no picture is a white slot: the shade would sit on white
      await setHero(page, false);
      await settled(page, '0');
      s = await state(page);
      assert.equal(s.halo, '0', 'no shade over a hero without a picture');
      assert.ok(s.gold.includes(LIGHT_GOLD) && !s.gold.includes(OLD_GOLD), 'the word is the lighter gold over a white hero too: ' + s.gold);
    } finally { await context.close(); }
  });

  test('at ' + size.width + 'px the shade fades out to nothing at the edges of its own box and is cut at the bottom edge of the hero, so it never lands on the white page under the hero (owner, 27 Nov 14:23)', async () => {
    const { context, page } = await openHome(size);
    try {
      await setHero(page, true);
      await settled(page, '1');
      const box = () => page.evaluate(() => { const h = document.querySelector('header'), q = h.getBoundingClientRect(), s = getComputedStyle(h, '::before'), w = parseFloat(s.width), t = parseFloat(s.height); return { x: q.left + q.width / 2 - w / 2, y: q.top + q.height / 2 - t / 2, width: w, height: t, mid: q.top + q.height / 2, hb: document.getElementById('hero').getBoundingClientRect().bottom, vw: innerWidth }; });
      // 1. no hard edge: at the top of the page, the shade's own box against the same box without it
      let g = await box();
      // (on a phone the top of the box is above the screen, so its top edge cannot be seen and is only checked when it is on the screen)
      const topOnScreen = g.y >= 2;
      const edges = await shadeDiff(page, { x: Math.max(0, Math.floor(g.x)), y: Math.max(0, Math.floor(g.y)), width: Math.ceil(g.width), height: Math.ceil(g.height + Math.min(0, g.y)) });
      assert.ok(edges.max >= 20, 'the shade paints something over the hero picture (otherwise the edge check below proves nothing): ' + JSON.stringify(edges));
      assert.ok(edges.left <= 2 && edges.right <= 2 && (!topOnScreen || edges.top <= 2), 'the shade is gone at the left and the right edge of its box (and at the top edge when that is on the screen), so no faint rectangle shows (the first version left about 7/255 there): ' + JSON.stringify(edges));
      // 2. the hero ends 30px under the middle of the header (the header is still over it): nothing of the shade below that edge
      for (let i = 0; i < 4; i++) {
        g = await box();
        const off = g.hb - (g.mid + 30);
        if (Math.abs(off) < 1) break;
        await page.evaluate((d) => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollBy(0, d); }, off);
        await H.quiet(page);
      }
      await settled(page, '1');
      g = await box();
      assert.ok(g.hb - g.mid > 20 && g.hb - g.mid < 40, 'the hero ends under the middle of the header: ' + JSON.stringify(g));
      const cutAt = await page.evaluate(() => document.querySelector('header').style.getPropertyValue('--hcut'));
      assert.ok(/^\d+px$/.test(cutAt) && parseInt(cutAt, 10) > 64 && parseInt(cutAt, 10) < 128, 'hdTone() tells the stylesheet how much of the box is still above the hero\'s edge (' + (g.hb - g.mid + 64) + 'px): ' + cutAt);
      const above = await shadeDiff(page, { x: Math.max(0, Math.floor(g.x)), y: Math.max(0, Math.floor(g.y)), width: Math.ceil(g.width), height: Math.max(8, Math.floor(g.hb - g.y) - 2) });
      assert.ok(above.max >= 20, 'above the hero\'s edge the shade is there: ' + JSON.stringify(above));
      const below = await shadeDiff(page, { x: 0, y: Math.ceil(g.hb) + 1, width: g.vw, height: 60 });
      assert.ok(below.max <= 1, 'under the hero\'s edge, on the white page, the shade paints nothing: ' + JSON.stringify(below));
    } finally { await context.close(); }
  });
}

test('«Élan», the word of the logo, is the same lighter gold in the header, the menu, the About section and the orders page, and never the old gold (owner, 27 Nov 19:26)', async () => {
  const { context, page } = await openHome(H.WIDTHS[0]);
  try {
    const look = (q) => page.evaluate((sel) => { const e = document.querySelector(sel); return e ? { bg: getComputedStyle(e).backgroundImage, filter: getComputedStyle(e).filter, clip: getComputedStyle(e).webkitBackgroundClip || getComputedStyle(e).backgroundClip } : null; }, q);
    const check = (name, l) => {
      assert.ok(l, name + ': the word is on the page');
      assert.ok(l.bg.includes(LIGHT_GOLD) && l.bg.includes('rgb(246, 213, 106)') && !l.bg.includes(OLD_GOLD), name + ': the lighter gold, not the old one: ' + l.bg);
      assert.match(l.filter, /drop-shadow/, name + ': with the soft edge that keeps it readable on white: ' + l.filter);
      assert.equal(l.clip, 'text', name + ': painted through the letters');
    };
    check('header', await look('header .logo b'));
    check('About section', await look('.alogo .logo b'));
    await page.evaluate(() => document.getElementById('mb').click());
    await page.waitForSelector('#menu a.mlogo .logo b', { state: 'attached', timeout: 5000 });
    check('menu', await look('#menu a.mlogo .logo b'));
    const orders = await context.newPage();
    await orders.goto(H.SITE + '/account.html', { waitUntil: 'load' });
    await orders.waitForSelector('.acct-mark b', { timeout: 5000 });
    check('orders page', await orders.evaluate(() => { const e = document.querySelector('.acct-mark b'); return { bg: getComputedStyle(e).backgroundImage, filter: getComputedStyle(e).filter, clip: getComputedStyle(e).webkitBackgroundClip || getComputedStyle(e).backgroundClip }; }));
  } finally { await context.close(); }
});
