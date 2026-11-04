/* Opens the real shop in a real Chromium (a phone-sized window), the way a visitor would, and checks the part of the home page under the
   hero ("سحر الخليج بين يديك" and the three counters) on the home page and on inner pages, then the brands strip right under the counters
   (no title, no gold line), a brand's own page, the page of all brands and the page of all perfumes (no title; the breadcrumb says «البراندات» / «كل العطور»), then the menu page (no lines between items, close button like the cart page's, every section entry opens its own page, and no inner page has a title: the breadcrumb names it). Takes screenshots into a folder.
   Run by the "Live browser check" workflow (GitHub runners can reach the site; the Claude sandbox cannot), or by hand:
     node scripts/live-browser-check.js [site address] [folder for the screenshots]
   Exits 1 when something is not as expected. It only reads the public site and clicks; it sends nothing and uses no secret. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const site = (process.argv[2] || 'https://elan-scents.hossamthapitelgharib.workers.dev').replace(/\/+$/, '') + '/';
const out = path.resolve(process.argv[3] || 'live-shots');
const problems = [];
const say = (m) => console.log(m);
const expect = (ok, m) => { if (!ok) problems.push(m); say((ok ? 'OK   ' : 'FAIL ') + m); };

/* What a visitor can see of the blocks under the hero right now. */
const look = () => {
  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0, top: Math.round(r.top + scrollY), height: Math.round(r.height), text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140) };
  };
  return { inner: document.body.classList.contains('inner'), htmlClass: document.documentElement.className, hero: box('#hero'), intro: box('#intro'), title: box('#intro h2'), counters: box('#intro .counters'), view: box('#view'), main: box('#main') };
};

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const failed = [];
  page.on('requestfailed', (r) => failed.push(r.url().slice(0, 120) + ' ' + ((r.failure() || {}).errorText || '')));
  page.on('pageerror', (e) => say('page error: ' + String(e).slice(0, 160)));
  const shot = (name) => page.screenshot({ path: path.join(out, name + '.png') });

  const started = Date.now();
  const res = await page.goto(site, { waitUntil: 'load' });
  expect(res && res.ok(), 'the home page answers (HTTP ' + (res && res.status()) + ')');
  await page.waitForTimeout(3000);
  say('opened and settled after ' + (Date.now() - started) + ' ms');

  const home = await page.evaluate(look);
  say('home: ' + JSON.stringify(home));
  await shot('1-home-top');
  expect(home.hero && home.hero.shown, 'the hero is on the home page');
  expect(home.intro && home.intro.shown, 'the title and counters block is shown on the home page');
  expect(home.intro && home.hero && home.intro.top >= home.hero.top + home.hero.height - 2, 'it sits under the hero, not over it (starts at ' + (home.intro && home.intro.top) + ', hero ends at ' + (home.hero && home.hero.top + home.hero.height) + ')');
  expect(home.title && /سحر الخليج بين يديك/.test(home.title.text), 'the title reads «سحر الخليج بين يديك»: «' + (home.title && home.title.text) + '»');
  expect(home.counters && (home.counters.text.match(/\d+/g) || []).length >= 3, 'the three counters are there: «' + (home.counters && home.counters.text) + '»');
  await page.evaluate(() => document.getElementById('intro') && document.getElementById('intro').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(600);
  await shot('2-home-intro');

  // The brands strip: no title and no gold line, the oval arrow and the brand icons right under the counters.
  const strip = await page.evaluate(() => {
    const sec = document.getElementById('brands'), counters = document.querySelector('#intro .counters');
    if (!sec || !counters) return null;
    const pill = sec.querySelector('.sub'), cards = sec.querySelectorAll('.strip .card'), c = counters.getBoundingClientRect();
    return { title: !!sec.querySelector('h3'), cards: cards.length, hasArrow: !!pill, gap: pill ? Math.round(pill.getBoundingClientRect().top - c.bottom) : null, firstCardBelowArrow: !!(pill && cards[0]) && cards[0].getBoundingClientRect().top >= pill.getBoundingClientRect().bottom, others: [...document.querySelectorAll('#main > section[id]')].filter((x) => x.id !== 'brands').map((x) => x.id + ':' + !!x.querySelector('h3')).join(' ') };
  });
  say('brands strip: ' + JSON.stringify(strip));
  expect(strip && !strip.title, 'the brands section has no title (so no gold line under it)');
  expect(strip && strip.hasArrow && strip.cards > 0 && strip.firstCardBelowArrow, 'the oval arrow and the brand icons are there, icons below the arrow');
  expect(strip && strip.gap !== null && strip.gap >= 0 && strip.gap <= 40, 'the arrow sits right under the counters (' + (strip && strip.gap) + ' px below them)');
  await page.evaluate(() => { const b = document.getElementById('brands'); b && b.scrollIntoView({ block: 'start' }); window.scrollBy(0, -120); });
  await page.waitForTimeout(500);
  await shot('2b-home-brands');
  // A brand's own page: click a brand icon like a visitor.
  const brandGo = await page.evaluate(() => { const c = [...document.querySelectorAll('#brands .strip .card')].find((x) => /^brand\|/.test(x.getAttribute('data-go') || '')); return c ? c.getAttribute('data-go') : null; });
  expect(!!brandGo, 'the brand icons open brand pages (' + brandGo + ')');
  if (brandGo) {
    await page.evaluate((g) => { const c = [...document.querySelectorAll('#brands .strip .card')].find((x) => x.getAttribute('data-go') === g); c.scrollIntoView({ block: 'center' }); c.click(); }, brandGo);
    await page.waitForTimeout(1800);
    const bp = await page.evaluate(() => ({ inner: document.body.classList.contains('inner'), titles: document.querySelectorAll('#view h3').length, crumb: ((document.querySelector('#view .bc b') || {}).textContent || '').trim(), middle: ((document.querySelector('#view .bc a[data-bc="1"]') || {}).textContent || '').trim(), filters: !!document.querySelector('#view .filter-panel') }));
    say('brand page: ' + JSON.stringify(bp));
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(400);
    await shot('2c-brand-page');
    expect(bp.inner && bp.titles === 0, 'a brand\'s own page has no title');
    expect(!!bp.crumb, 'the breadcrumb names the brand: «' + bp.crumb + '»');
    expect(bp.filters, 'the filters follow the breadcrumb');
    expect(bp.middle === 'البراندات', 'its breadcrumb calls the brands section «البراندات»: «' + bp.middle + '»');
    // The page of all brands: no title, no gold line, and the breadcrumb says «البراندات».
    await page.evaluate(() => { go('sec|brands'); });
    await page.waitForTimeout(1500);
    const hub = await page.evaluate(() => ({ titles: document.querySelectorAll('#view h3').length, crumb: ((document.querySelector('#view .bc b') || {}).textContent || '').trim(), cards: document.querySelectorAll('#view .grid .card').length, tagline: /للفخامة عنوان وللرقي حضور/.test(document.getElementById('view').innerText) }));
    say('all-brands page: ' + JSON.stringify(hub));
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(400);
    await shot('2d-all-brands-page');
    expect(hub.titles === 0 && !hub.tagline, 'the page of all brands has no title and no «للفخامة عنوان وللرقي حضور»');
    expect(hub.crumb === 'البراندات', 'its breadcrumb says «البراندات»: «' + hub.crumb + '»');
    expect(hub.cards > 0, 'it still lists the brand cards (' + hub.cards + ')');
    // The inner page of «سحر الخليج بين يديك» (all perfumes): no title and no gold line, «كل العطور» stays in the breadcrumb.
    await page.evaluate(() => { go('sec|all'); });
    await page.waitForTimeout(1500);
    const allp = await page.evaluate(() => ({ titles: document.querySelectorAll('#view h3').length, crumb: ((document.querySelector('#view .bc b') || {}).textContent || '').trim(), filters: !!document.querySelector('#view .filter-panel') }));
    say('all-perfumes page: ' + JSON.stringify(allp));
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(400);
    await shot('2e-all-perfumes-page');
    expect(allp.titles === 0, 'the all-perfumes page has no title (no «كل العطور» heading, no gold line)');
    expect(allp.crumb === 'كل العطور', 'but «كل العطور» stays in its breadcrumb: «' + allp.crumb + '»');
    expect(allp.filters, 'the filters follow the breadcrumb');
    // The menu page: no lines between its items, and its close button is drawn like the cart page's.
    await page.goto(site, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('mb').click());
    await page.waitForTimeout(900);
    const css = (sel) => page.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const c = getComputedStyle(e); return { w: e.getBoundingClientRect().width, bg: c.backgroundColor, border: c.borderTopWidth + ' ' + c.borderTopColor, radius: c.borderRadius, color: c.color, font: c.fontSize, shadow: c.boxShadow, text: e.textContent.trim() }; }, sel);
    const menu = await page.evaluate(() => ({ items: document.querySelectorAll('#menu a').length, withLine: [...document.querySelectorAll('#menu a')].filter((a) => parseFloat(getComputedStyle(a).borderBottomWidth) + parseFloat(getComputedStyle(a).borderTopWidth) > 0).length }));
    const menuX = await css('#menu .mx');
    await shot('2f-menu-page');
    say('menu page: ' + JSON.stringify(menu) + ' close: ' + JSON.stringify(menuX));
    expect(menu.items >= 10 && menu.withLine === 0, 'the menu page has no lines between its items (' + menu.items + ' items, ' + menu.withLine + ' with a line)');
    await page.evaluate(() => document.querySelector('#menu .mx').click());
    await page.waitForTimeout(500);
    await page.evaluate(() => { sheet('cart'); });
    await page.waitForTimeout(700);
    const cartX = await css('#sheet .sheet-close');
    say('cart page close: ' + JSON.stringify(cartX));
    expect(!!menuX && !!cartX && JSON.stringify(menuX) === JSON.stringify(cartX), 'the menu page close button is drawn exactly like the cart page one');
    // Every menu entry that is a section opens that section's own page (like «سحر الخليج بين يديك»); only «عن» and «تواصل معنا» scroll.
    const entries = await page.evaluate(() => ({ pages: [...document.querySelectorAll('#menu a[data-go]')].map((a) => a.getAttribute('data-go')), anchors: [...document.querySelectorAll('#menu a[href^="#"]:not(.mlogo)')].map((a) => a.getAttribute('href')) }));
    say('menu entries: ' + JSON.stringify(entries));
    expect(entries.pages.length === 9 && entries.anchors.join() === '#about,#contact', 'nine menu entries open pages, two (about, contact) scroll');
    for (const go of entries.pages) {
      await page.goto(site, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      await page.evaluate(() => document.getElementById('mb').click());
      await page.waitForTimeout(500);
      await page.evaluate((g) => document.querySelector('#menu a[data-go="' + g + '"]').click(), go);
      await page.waitForTimeout(900);
      const r = await page.evaluate((g) => { const w = { brands: 2, offers: 3, new: 4, master: 5, cats: 6, occ: 7, notes: 8, stores: 9 }[g.split('|')[1]]; return { inner: document.body.classList.contains('inner'), open: document.getElementById('menu').classList.contains('open'), crumb: ((document.querySelector('#view .bc b') || {}).textContent || '').trim(), word: w ? T().menu[w] : null, titles: document.querySelectorAll('#view h3').length, cards: document.querySelectorAll('#view .card').length }; }, go);
      say('menu entry ' + go + ': ' + JSON.stringify(r));
      expect(r.inner && !r.open && r.crumb.length > 0, 'the menu entry «' + go + '» opens its own page («' + r.crumb + '»)');
      expect(r.titles === 0 && (!r.word || r.crumb === r.word), '«' + go + '»: no title of its own, and the breadcrumb says the menu word («' + r.crumb + '»)');
    }
  }

  // Inner pages: open them the way a visitor does (click what has data-go), and look again.
  const targets = await page.evaluate(() => {
    const seen = new Set(), list = [];
    for (const e of document.querySelectorAll('[data-go]')) { const go = e.getAttribute('data-go'); if (!seen.has(go)) { seen.add(go); list.push(go); } }
    return list.slice(0, 4);
  });
  say('inner pages to open: ' + JSON.stringify(targets));
  expect(targets.length > 0, 'the page has links to inner pages');
  let n = 3;
  for (const go of targets) {
    await page.goto(site, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const clicked = await page.evaluate((g) => { const e = [...document.querySelectorAll('[data-go]')].find((x) => x.getAttribute('data-go') === g); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return true; }, go);
    await page.waitForTimeout(1800);
    const inner = await page.evaluate(look);
    say('inner (' + go + '): ' + JSON.stringify(inner));
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(500);
    await shot(n++ + '-inner-' + go.replace(/[^a-z0-9]+/gi, '-'));
    expect(clicked && inner.inner, 'opening «' + go + '» shows an inner page');
    expect(inner.intro && !inner.intro.shown, '«' + go + '»: the title and counters are NOT shown above the filters');
    expect(inner.hero && !inner.hero.shown && inner.main && !inner.main.shown, '«' + go + '»: the hero and the home sections are hidden');
    expect(inner.view && inner.view.shown, '«' + go + '»: the inner page itself is shown');
  }
  if (failed.length) say('requests that failed (' + failed.length + '): ' + failed.slice(0, 6).join(' | '));
  await browser.close();
  say(problems.length ? '\n' + problems.length + ' check(s) failed' : '\nall checks passed');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
