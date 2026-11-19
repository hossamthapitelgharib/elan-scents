#!/usr/bin/env node
'use strict';
/* Reviews the PUBLISHED home page's cards from a GitHub runner, which can reach the site (the Claude sandbox cannot).
   Usage: node scripts/store-cards-review.js <site-url> [screenshots-dir]
          node scripts/store-cards-review.js --decode <log> <dir>     (turns the IMG| lines of a run's log back into .jpg files)

   It reads no secret and sends nothing. In a real Chromium (a phone and a laptop) it opens the home page the way a visitor would and, for every
   section of the page (brands, categories, occasions, notes, master pieces, stores, banners and the owner's own blocks), prints for every card:
   its box, the picture's own size, how the picture is fitted (cover / contain / stretched), how much of the picture is cut off or left empty,
   the text written INSIDE the card, and the sentence «بانتظار ربط كتالوج المتاجر». Then it prints one screenshot per section as text lines (IMG|). */
const fs = require('node:fs');
const path = require('node:path');

if (process.argv[2] === '--decode') {
  const [, , , log, dir] = process.argv;
  fs.mkdirSync(dir, { recursive: true });
  const shots = {};
  for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('IMG|');
    if (at < 0) continue;
    const [, name, index, , data] = line.slice(at).split('|');
    (shots[name] ||= [])[Number(index)] = data;
  }
  for (const [name, parts] of Object.entries(shots)) fs.writeFileSync(path.join(dir, name + '.jpg'), Buffer.from(parts.join(''), 'base64'));
  console.log('decoded', Object.keys(shots).join(', '));
  process.exit(0);
}

const { chromium } = require('playwright');
const SITE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const SHOTS = path.resolve(process.argv[3] || 'store-cards-shots');
const SIZES = [{ name: 'phone', width: 390, height: 844, mobile: true }, { name: 'laptop', width: 1280, height: 800, mobile: false }];
const log = (m) => console.log(m);

/* Runs inside the page: one record per card of every section. */
const measure = () => {
  const num = (n) => Math.round(n * 100) / 100;
  const sizeOf = (url) => new Promise((resolve) => {
    if (!url) return resolve(null);
    const i = new Image();
    const timer = setTimeout(() => resolve(null), 4000);
    i.onload = () => { clearTimeout(timer); resolve({ w: i.naturalWidth, h: i.naturalHeight }); };
    i.onerror = () => { clearTimeout(timer); resolve(null); };
    i.src = url;
  });
  const bgUrl = (cs) => { const m = /url\(["']?([^"')]+)["']?\)/.exec(cs.backgroundImage || ''); return m ? m[1] : ''; };
  const fit = (boxW, boxH, nat, mode) => {
    if (!nat || !boxW || !boxH) return null;
    const rb = boxW / boxH, rn = nat.w / nat.h;
    if (mode === 'cover') return { cut: num(1 - Math.min(rb / rn, rn / rb)), empty: 0 };
    if (mode === 'contain' || mode === 'scale-down') return { cut: 0, empty: num(1 - Math.min(rb / rn, rn / rb)) };
    return { cut: 0, empty: 0, stretch: num(Math.abs(rb / rn - 1)) };   // fill / 100% 100%: the picture is pulled to the box
  };
  return (async () => {
    const out = { sections: [], pending: [], url: location.href };
    const parts = Array.from(document.querySelectorAll('#main > section[id], #main > .elan-block, #hero, #intro'));
    for (const s of parts) {
      const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
      const rec = { id: s.id || (s.getAttribute('data-elan-id') || s.className).toString().slice(0, 40), cls: s.className.toString().slice(0, 50), top: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height), shown: cs.display !== 'none' && r.height > 0, heading: ((s.querySelector('h2,h3') || {}).textContent || '').trim().slice(0, 50), cards: [], media: [] };
      if (s.matches('.elan-block, #hero')) {
        // a banner / block: its own background picture or video
        const url = bgUrl(cs), nat = await sizeOf(url);
        const video = s.querySelector('video');
        const vr = video ? video.getBoundingClientRect() : null;
        rec.media.push({ kind: video ? 'video' : (url ? 'bg-image' : 'none'), bgSize: cs.backgroundSize, bgRepeat: cs.backgroundRepeat, bgColor: cs.backgroundColor, nat, box: [Math.round(r.width), Math.round(r.height)], videoFit: video ? getComputedStyle(video).objectFit : '', videoNat: video ? [video.videoWidth, video.videoHeight] : null, videoBox: vr ? [Math.round(vr.width), Math.round(vr.height)] : null, fit: nat ? fit(r.width, r.height, nat, /contain/.test(cs.backgroundSize) ? 'contain' : /cover/.test(cs.backgroundSize) ? 'cover' : 'fill') : null });
        const img = s.querySelector('img');
        if (img) { const ir = img.getBoundingClientRect(), ic = getComputedStyle(img); rec.media.push({ kind: 'img', objectFit: ic.objectFit, nat: { w: img.naturalWidth, h: img.naturalHeight }, box: [Math.round(ir.width), Math.round(ir.height)], fit: fit(ir.width, ir.height, { w: img.naturalWidth, h: img.naturalHeight }, ic.objectFit === 'fill' ? 'fill' : ic.objectFit) }); }
      }
      const cards = Array.from(s.querySelectorAll('.card')).slice(0, 14);
      for (const c of cards) {
        const cr = c.getBoundingClientRect(), cc = getComputedStyle(c);
        const rec2 = { go: (c.getAttribute('data-go') || '').slice(0, 40), w: Math.round(cr.width), h: Math.round(cr.height), ratio: num(cr.width / Math.max(1, cr.height)), text: (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70), bg: cc.backgroundColor, cardBgSize: cc.backgroundSize, ar: cc.aspectRatio, imgs: [] };
        const own = bgUrl(cc);
        if (own) { const nat = await sizeOf(own); rec2.imgs.push({ via: 'card-bg', nat, mode: cc.backgroundSize, fit: fit(cr.width, cr.height, nat, /contain/.test(cc.backgroundSize) ? 'contain' : /cover/.test(cc.backgroundSize) ? 'cover' : 'fill') }); }
        for (const node of Array.from(c.querySelectorAll('*')).slice(0, 12)) {
          const ns = getComputedStyle(node), nr = node.getBoundingClientRect();
          if (node.tagName === 'IMG') {
            const nat = { w: node.naturalWidth, h: node.naturalHeight };
            rec2.imgs.push({ via: 'img.' + (node.className || node.parentElement.className || '').toString().slice(0, 20), nat, box: [Math.round(nr.width), Math.round(nr.height)], objectFit: ns.objectFit, fit: fit(nr.width, nr.height, nat, ns.objectFit), insideCardW: num(nr.width / Math.max(1, cr.width)), insideCardH: num(nr.height / Math.max(1, cr.height)) });
          } else if (node.tagName === 'VIDEO') {
            rec2.imgs.push({ via: 'video', nat: { w: node.videoWidth, h: node.videoHeight }, box: [Math.round(nr.width), Math.round(nr.height)], objectFit: ns.objectFit });
          } else if (bgUrl(ns)) {
            const nat = await sizeOf(bgUrl(ns));
            rec2.imgs.push({ via: 'bg.' + (node.className || '').toString().slice(0, 20), nat, box: [Math.round(nr.width), Math.round(nr.height)], mode: ns.backgroundSize, fit: fit(nr.width, nr.height, nat, /contain/.test(ns.backgroundSize) ? 'contain' : /cover/.test(ns.backgroundSize) ? 'cover' : 'fill') });
          }
        }
        rec.cards.push(rec2);
      }
      rec.cardCount = s.querySelectorAll('.card').length;
      out.sections.push(rec);
    }
    // the «waiting for the stores' catalog» sentence, wherever it is
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) { const n = walker.currentNode; if (/بانتظار ربط|في انتظار ربط|انتظار ربط/.test(n.textContent)) { const p = n.parentElement; const card = p.closest('.card'); out.pending.push({ text: n.textContent.trim().slice(0, 60), inCard: !!card, section: (p.closest('section[id]') || {}).id || '' }); } }
    out.perfumeCards = document.querySelectorAll('.card.pf, .pcard, [data-pid]').length;
    out.storeCards = document.querySelectorAll('#stores .card').length;
    out.brandCards = document.querySelectorAll('#brands .card').length;
    return out;
  })();
};

/* A screenshot of a part of the page by its box (not element.screenshot: that waits for the element to be "stable" and never gets it on a moving strip). */
async function shootBox(page, box, name) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 1400), height: Math.min(Math.max(box.height, 20), 2400) };
    const buffer = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true, clip, animations: 'disabled', timeout: 15000 });
    fs.writeFileSync(path.join(SHOTS, name + '.jpg'), buffer);
    const text = buffer.toString('base64'), size = 3000, total = Math.ceil(text.length / size);
    for (let i = 0; i < total; i++) log(`IMG|${name}|${i}|${total}|${text.slice(i * size, (i + 1) * size)}`);
    log(`shot ${name}: ${Math.round(buffer.length / 1024)} KB`);
  } catch (error) { log('NOTE no screenshot for ' + name + ': ' + String(error.message).slice(0, 120)); }
}
const boxOf = (page, selector, index = 0) => page.evaluate(([sel, i]) => { const e = document.querySelectorAll(sel)[i]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; }, [selector, index]);

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: size.mobile, hasTouch: size.mobile, locale: 'ar-EG' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));
    page.on('requestfailed', (r) => errors.push('request failed ' + r.url().slice(0, 100)));
    log(`\n===== ${size.name} ${size.width}x${size.height} =====`);
    const res = await page.goto(SITE + '/', { waitUntil: 'load' });
    log(`home page: HTTP ${res && res.status()}`);
    await page.waitForTimeout(6000);   // the catalog loads after the first paint
    // scroll once through the page so lazy pictures load
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); });
    await page.waitForTimeout(1500);
    const m = await page.evaluate(measure);
    log(`catalog on the page: ${m.brandCards} brand cards, ${m.storeCards} store cards, ${m.perfumeCards} perfume cards`);
    log(`waiting sentence «بانتظار ربط…» found ${m.pending.length} time(s): ${JSON.stringify(m.pending.slice(0, 4))}`);
    for (const s of m.sections) {
      log(`SECTION #${s.id} [${s.cls}] shown=${s.shown} ${s.w}x${s.h} cards=${s.cardCount} heading="${s.heading}"`);
      for (const md of s.media) log(`  MEDIA ${JSON.stringify(md)}`);
      for (const c of s.cards) log(`  CARD ${JSON.stringify(c)}`);
    }
    if (errors.length) log('page errors: ' + errors.slice(0, 5).join(' | '));
    // one screenshot per section
    let n = 0;
    for (const s of m.sections) {
      if (!s.shown || n >= 14) continue;
      const sel = s.id && /^[A-Za-z][\w-]*$/.test(s.id) ? '#' + s.id : null;
      if (!sel) continue;
      const box = await boxOf(page, sel);
      if (box && box.height > 0) { await shootBox(page, box, `${size.name}-${s.id}`); n++; }
    }
    // the owner's own blocks (banners)
    const count = await page.evaluate(() => document.querySelectorAll('#main > .elan-block').length);
    for (let k = 0; k < Math.min(count, 6); k++) { const box = await boxOf(page, '#main > .elan-block', k); if (box && box.height > 0) await shootBox(page, box, `${size.name}-block${k + 1}`); }
    await ctx.close();
  }
  await browser.close();
  log('\nReview finished: it only reads the public site.');
}

main().catch((e) => { console.error(e); process.exit(1); });
