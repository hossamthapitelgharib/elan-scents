#!/usr/bin/env node
'use strict';
/* Opens the PUBLISHED site from a GitHub runner (which can reach it; the Claude sandbox cannot) in a real Chromium, on a phone and on a laptop, as an ordinary visitor
   (nobody signed in, no secret, nothing sent or written), and reports what a person would see:
   (1) the home page: fonts, direction, horizontal overflow, headings, the gap between sections, buttons that are too small to tap, broken pictures, things fixed on the screen,
       errors in the console and failed requests, and screenshots of the page in slices;
   (2) the menu opened, then a tap on «طلباتي»: where it leads, what the page says, what it asks for, and a screenshot of it.
   Every measurement line starts with LOOK|, every screenshot is printed as text lines IMG|name|part|parts|data (turn them back into pictures with
   `node scripts/store-cards-review.js --decode <log> <dir>`). It never fails the run.
   Usage: node scripts/site-look-review.js <site-url> [screenshots-dir] */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const SITE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const SHOTS = path.resolve(process.argv[3] || 'site-look-shots');
const SIZES = [{ name: 'phone', width: 390, height: 844, mobile: true }, { name: 'laptop', width: 1280, height: 800, mobile: false }];
const log = (m) => console.log(m);

async function shoot(page, name, clip, full) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const buffer = await page.screenshot(Object.assign({ type: 'jpeg', quality: 55, animations: 'disabled', timeout: 20000 }, clip ? { clip, fullPage: true } : { fullPage: !!full }));
    fs.writeFileSync(path.join(SHOTS, name + '.jpg'), buffer);
    const text = buffer.toString('base64'), size = 3000, total = Math.ceil(text.length / size);
    for (let i = 0; i < total; i++) log(`IMG|${name}|${i}|${total}|${text.slice(i * size, (i + 1) * size)}`);
    log(`LOOK|${name}|screenshot ${Math.round(buffer.length / 1024)} KB`);
  } catch (error) { log('LOOK|' + name + '|no screenshot: ' + String(error.message).slice(0, 120)); }
}

/* the page's own measurements, run inside it */
const look = () => {
  const r1 = (n) => Math.round(n * 10) / 10;
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const out = {};
  const de = document.documentElement, body = document.body, bs = getComputedStyle(body);
  out.page = { dir: de.dir || getComputedStyle(de).direction, lang: de.lang, title: document.title, width: innerWidth, scrollWidth: de.scrollWidth, height: de.scrollHeight, bodyFont: bs.fontFamily.slice(0, 90), bodyColor: bs.color, bodyBg: bs.backgroundColor, bodySize: bs.fontSize };
  out.fonts = { plexLoaded: document.fonts && document.fonts.check ? document.fonts.check('16px "IBM Plex Sans Arabic"') : null, faces: Array.from(document.fonts || []).map((f) => f.family.replace(/"/g, '') + ' ' + f.weight + ' ' + f.status).slice(0, 12) };
  out.overflowX = Array.from(document.querySelectorAll('body *')).filter((e) => { const r = e.getBoundingClientRect(); return vis(e) && (r.right > innerWidth + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed'; }).slice(0, 12).map((e) => name(e) + ' ' + Math.round(e.getBoundingClientRect().left) + '→' + Math.round(e.getBoundingClientRect().right));
  out.sections = Array.from(document.querySelectorAll('#main > section, #main > .elan-block')).map((s) => { const r = s.getBoundingClientRect(), cs = getComputedStyle(s), h = s.querySelector('h1,h2,h3'); return { id: s.id || s.className.slice(0, 24), top: Math.round(r.top + scrollY), h: Math.round(r.height), padT: cs.paddingTop, padB: cs.paddingBottom, heading: h ? h.textContent.trim().slice(0, 40) : '', hSize: h ? getComputedStyle(h).fontSize : '', hAlign: h ? getComputedStyle(h).textAlign : '', hColor: h ? getComputedStyle(h).color : '' }; });
  const gaps = []; for (let i = 1; i < out.sections.length; i++) gaps.push(out.sections[i].top - (out.sections[i - 1].top + out.sections[i - 1].h));
  out.sectionGaps = gaps;
  out.headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(vis).slice(0, 30).map((h) => h.tagName.toLowerCase() + ' ' + getComputedStyle(h).fontSize + ' w' + getComputedStyle(h).fontWeight + ' ' + getComputedStyle(h).color + ' "' + h.textContent.trim().slice(0, 34) + '"');
  const taps = Array.from(document.querySelectorAll('a, button, [role=button], input, select, textarea')).filter(vis).map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.height < 36 || x.r.width < 36);
  out.smallTargets = { count: taps.length, examples: taps.slice(0, 10).map((x) => name(x.e) + ' ' + Math.round(x.r.width) + 'x' + Math.round(x.r.height) + ' "' + (x.e.textContent || x.e.getAttribute('aria-label') || '').trim().slice(0, 20) + '"') };
  const imgs = Array.from(document.images);
  out.images = { total: imgs.length, broken: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.currentSrc).map((i) => (i.currentSrc || i.src).slice(0, 110)).slice(0, 8), noAlt: imgs.filter((i) => !i.hasAttribute('alt')).length, lazyUnloaded: imgs.filter((i) => i.loading === 'lazy' && !i.complete).length };
  out.fixed = Array.from(document.querySelectorAll('body *')).filter((e) => getComputedStyle(e).position === 'fixed' && vis(e)).map((e) => { const r = e.getBoundingClientRect(); return name(e) + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }).slice(0, 10);
  const gold = Array.from(document.querySelectorAll('body *')).filter((e) => vis(e) && (getComputedStyle(e).color === 'rgb(200, 150, 42)' || getComputedStyle(e).borderTopColor === 'rgb(200, 150, 42)' || getComputedStyle(e).backgroundColor === 'rgb(200, 150, 42)')).length;
  out.gold = gold;
  const texts = Array.from(document.querySelectorAll('body *')).filter((e) => vis(e) && e.children.length === 0 && (e.textContent || '').trim().length > 2);
  const sizes = {}; texts.forEach((e) => { const s = getComputedStyle(e).fontSize; sizes[s] = (sizes[s] || 0) + 1; });
  out.fontSizes = sizes;
  out.clippedText = texts.filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'visible').slice(0, 8).map((e) => name(e) + ' "' + e.textContent.trim().slice(0, 30) + '"');
  out.footer = (document.querySelector('footer') || {}).innerText ? document.querySelector('footer').innerText.replace(/\s+/g, ' ').slice(0, 160) : '(no footer element)';
  return out;
};

const print = (tag, o) => {
  const L = (k, v) => log('LOOK|' + tag + '|' + k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));
  L('page', o.page); L('fonts', o.fonts); L('overflow beyond the screen sides', o.overflowX.length ? o.overflowX : 'none');
  L('sections (id, top, height, padding, heading, size)', (o.sections || []).map((s) => [s.id, s.top, s.h, s.padT + '/' + s.padB, s.heading, s.hSize, s.hAlign].join(' | ')));
  L('gaps between sections (px)', o.sectionGaps); L('headings', o.headings); L('small tap targets (<36px)', o.smallTargets); L('images', o.images);
  L('fixed on the screen', o.fixed); L('gold (#c8962a) elements', o.gold); L('font sizes used', o.fontSizes); L('text cut by its box', o.clippedText.length ? o.clippedText : 'none'); L('footer', o.footer);
};

async function visit(browser, size) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, deviceScaleFactor: 1, locale: 'ar-EG', timezoneId: 'Africa/Cairo' });
  const page = await ctx.newPage();
  const problems = { console: [], page: [], failed: [] };
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.console.push(m.type() + ': ' + m.text().slice(0, 160)); });
  page.on('pageerror', (e) => problems.page.push(String(e.message).slice(0, 160)));
  page.on('response', (r) => { if (r.status() >= 400) problems.failed.push(r.status() + ' ' + r.url().replace(SITE, '').slice(0, 110)); });
  page.on('requestfailed', (r) => problems.failed.push('failed ' + r.url().replace(SITE, '').slice(0, 100) + ' ' + (r.failure() || {}).errorText));
  const tag = size.name;
  try {
    // ---------- 1. the home page ----------
    await page.goto(SITE + '/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('#main section', { state: 'attached', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await shoot(page, tag + '-home-top', null, false);
    // every lazy picture in view once, so the slices show what a visitor scrolling would see
    const height = await page.evaluate(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += 600) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } scrollTo(0, 0); return h; });
    await page.waitForTimeout(1500);
    print(tag + '-home', await page.evaluate(look));
    const slice = size.mobile ? 1500 : 1100, total = Math.min(Math.ceil(height / slice), size.mobile ? 8 : 7);
    for (let i = 0; i < total; i++) await shoot(page, tag + '-home-' + (i + 1), { x: 0, y: i * slice, width: size.width, height: Math.min(slice, height - i * slice) }, true);
    // ---------- 2. the menu, then «طلباتي» ----------
    await page.evaluate(() => scrollTo(0, 0));
    await page.click('#mb', { timeout: 8000 }).catch((e) => log('LOOK|' + tag + '|menu button: ' + e.message.slice(0, 100)));
    await page.waitForTimeout(900);
    const menu = await page.evaluate(() => Array.from(document.querySelectorAll('#menu a, #menu button')).map((a) => (a.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean));
    log('LOOK|' + tag + '|menu items: ' + JSON.stringify(menu));
    await shoot(page, tag + '-menu', null, false);
    const link = page.locator('#menu a[href="/account.html"]').first();
    if (await link.count()) {
      await Promise.all([page.waitForURL(/account\.html/, { timeout: 20000 }).catch(() => {}), link.click({ timeout: 8000 }).catch((e) => log('LOOK|' + tag + '|tap «طلباتي»: ' + e.message.slice(0, 100)))]);
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(3500);
      const acct = await page.evaluate(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        return { url: location.pathname + location.search + location.hash, title: document.title, h1: Array.from(document.querySelectorAll('h1')).filter(vis).map((e) => e.textContent.trim()), h2: Array.from(document.querySelectorAll('h2')).filter(vis).map((e) => e.textContent.trim()), buttons: Array.from(document.querySelectorAll('button, a.ghost, .btn')).filter(vis).map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)), fields: Array.from(document.querySelectorAll('input, select, textarea')).filter(vis).map((e) => (e.type || e.tagName.toLowerCase()) + ':' + (e.getAttribute('placeholder') || e.getAttribute('aria-label') || e.name || e.id)), text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 420), loginShown: !!document.querySelector('#login') && vis(document.querySelector('#login')), appShown: !!document.querySelector('#app') && vis(document.querySelector('#app')), scrollWidth: document.documentElement.scrollWidth, innerWidth };
      });
      log('LOOK|' + tag + '|«طلباتي» opened: ' + JSON.stringify(acct));
      print(tag + '-account', await page.evaluate(look));
      await shoot(page, tag + '-account', null, true);
    } else log('LOOK|' + tag + '|no «طلباتي» link in the menu');
  } catch (error) { log('LOOK|' + tag + '|stopped: ' + String(error.message).slice(0, 200)); }
  log('LOOK|' + tag + '|console: ' + JSON.stringify(Array.from(new Set(problems.console)).slice(0, 12)));
  log('LOOK|' + tag + '|page errors: ' + JSON.stringify(Array.from(new Set(problems.page)).slice(0, 8)));
  log('LOOK|' + tag + '|failed requests: ' + JSON.stringify(Array.from(new Set(problems.failed)).slice(0, 14)));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const size of SIZES) await visit(browser, size);
  await browser.close();
  log('LOOK|done');
})().catch((e) => { log('LOOK|crashed: ' + (e && e.message || e)); process.exit(0); });
