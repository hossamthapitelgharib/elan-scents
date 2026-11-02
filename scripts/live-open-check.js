/* What a visitor sees while the shop OPENS, measured on the real site from a real Chromium (a phone-sized window) on a slowed-down
   network, for a first visit (empty cache) and a repeat visit (same browser, cache kept):
     node scripts/live-open-check.js [site address] [folder for the screenshots]
   Every ~120 ms it takes a real screenshot and measures how much of the screen is still white, so "the white page before the hero" is a
   number: how long the screen stays white, when the header shows, when the hero picture is on screen. It also lists how the hero picture
   was fetched (from this site or another host, from cache or the network, how long it took) and which classes <html> carried.
   Read-only: it opens the public page and takes screenshots; nothing is sent, no secret is used. Prints a report; always exits 0. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const site = (process.argv[2] || 'https://elan-scents.hossamthapitelgharib.workers.dev').replace(/\/+$/, '') + '/';
const out = path.resolve(process.argv[3] || 'open-shots');
const PROFILES = [
  { name: '4G (170 ms, 9 Mbps)', key: '4g', latency: 170, mbps: 9 },
  { name: 'slow 3G (400 ms, 1.6 Mbps)', key: '3g', latency: 400, mbps: 1.6 },
];
const WATCH_MS = 9000;

async function analyse(blank, jpegs) {
  // Decode the screenshots on a blank page and measure each: share of white pixels and mean brightness.
  return blank.evaluate(async (list) => {
    const res = [];
    for (const [t, b64] of list) {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, img.width, img.height).data;
      let white = 0, sum = 0, n = img.width * img.height;
      for (let i = 0; i < d.length; i += 4) { if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++; sum += (d[i] + d[i + 1] + d[i + 2]) / 3; }
      res.push([t, Math.round(white / n * 100), Math.round(sum / n)]);
    }
    return res;
  }, jpegs);
}

async function visit(ctx, blank, profile, label, tag) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.mbps * 1024 * 1024 / 8, uploadThroughput: 1024 * 1024 / 8 });
  await page.addInitScript(() => {
    window.__states = []; window.__paint = {};
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__paint[e.name] = Math.round(e.startTime); }).observe({ type: 'paint', buffered: true });
    const t0 = performance.now(); let last = null;
    const snap = () => { const k = document.documentElement.className || '(none)'; if (k !== last) { last = k; window.__states.push([Math.round(performance.now() - t0), k]); } };
    // <html> does not exist yet when this runs: start watching it as soon as it does.
    const start = () => { snap(); new MutationObserver(snap).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); };
    if (document.documentElement) start();
    else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); start(); } }).observe(document, { childList: true });
  });
  const shots = [];
  const t00 = Date.now();
  let going = true;
  const loop = (async () => { while (going && Date.now() - t00 < WATCH_MS) { const t = Date.now() - t00; try { const b = await page.screenshot({ type: 'jpeg', quality: 30, timeout: 3000 }); shots.push([t, b.toString('base64')]); } catch (e) { /* page still starting */ } } })();
  await page.goto(site, { waitUntil: 'commit' }).catch(() => {});
  await page.waitForTimeout(WATCH_MS);
  going = false; await loop;
  const info = await page.evaluate(() => ({
    paint: window.__paint, states: window.__states,
    hero: performance.getEntriesByType('resource').filter((e) => /\/assets\/hero\/|site-media\/uploads/.test(e.name) && !/\.png(\?|$)/.test(e.name)).map((e) => ({ url: e.name.replace(/^https?:\/\//, '').slice(0, 90), start: Math.round(e.startTime), end: Math.round(e.responseEnd), bytes: e.transferSize, size: e.encodedBodySize, proto: e.nextHopProtocol })),
    nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { html_ms: Math.round(n.responseEnd), proto: n.nextHopProtocol } : null; })(),
    css: performance.getEntriesByType('resource').filter((e) => /\.css(\?|$)/.test(e.name)).map((e) => Math.round(e.responseEnd)),
  })).catch(() => ({}));
  const frames = await analyse(blank, shots);
  fs.mkdirSync(out, { recursive: true });
  // keep a few screenshots: the first, the ones where the picture first shows, and the last
  const keep = new Set([0, 1, 2, 3, shots.length - 1]);
  const firstHero = frames.findIndex(([, w]) => w < 40);
  if (firstHero > 0) [firstHero - 1, firstHero, firstHero + 1].forEach((i) => keep.add(i));
  for (const i of keep) if (shots[i]) fs.writeFileSync(path.join(out, tag + '-' + String(shots[i][0]).padStart(5, '0') + 'ms.jpg'), Buffer.from(shots[i][1], 'base64'));
  await page.close();
  return { label, info, frames };
}

function report(profile, r) {
  const { label, info, frames } = r;
  console.log('\n--- ' + profile.name + ' · ' + label + ' ---');
  if (info.nav) console.log('page HTML arrived at ' + info.nav.html_ms + ' ms (' + info.nav.proto + '); stylesheets done at ' + (info.css || []).join(', ') + ' ms');
  console.log('first paint ' + (info.paint && info.paint['first-paint']) + ' ms, first contentful paint ' + (info.paint && info.paint['first-contentful-paint']) + ' ms');
  console.log('<html> classes: ' + (info.states || []).map(([t, k]) => t + 'ms «' + k + '»').join(' → '));
  for (const h of info.hero || []) console.log('hero picture: ' + h.url + ' · asked at ' + h.start + ' ms, finished ' + h.end + ' ms · ' + (h.bytes === 0 ? 'FROM CACHE' : h.bytes + ' bytes over the network') + ' · ' + h.proto);
  if (!(info.hero || []).length) console.log('hero picture: no request seen');
  const firstShown = frames.findIndex(([, w]) => w < 95);
  const firstHero = frames.findIndex(([, w]) => w < 40);
  console.log('screenshots taken: ' + frames.length + '; the screen is blank white until ' + (firstShown < 0 ? 'the end of the watch' : frames[firstShown][0] + ' ms') + '; the hero picture is on screen from ' + (firstHero < 0 ? 'NEVER within ' + WATCH_MS + ' ms' : frames[firstHero][0] + ' ms'));
  console.log('white share over time (ms:%white): ' + frames.filter((_, i) => i % 2 === 0).map(([t, w]) => t + ':' + w).join('  '));
}

(async () => {
  console.log('site: ' + site);
  const browser = await chromium.launch();
  const blankCtx = await browser.newContext();
  const blank = await blankCtx.newPage();
  await blank.setContent('<canvas></canvas>');
  for (const profile of PROFILES) {
    const ctx = await browser.newContext({ viewport: { width: 393, height: 760 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    report(profile, await visit(ctx, blank, profile, 'first visit (empty cache)', profile.key + '-first'));
    report(profile, await visit(ctx, blank, profile, 'repeat visit (cache kept)', profile.key + '-repeat'));
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); });
