#!/usr/bin/env node
'use strict';
/* Reviews the PUBLISHED orders page («طلباتي», account.html) from a GitHub runner, which can reach the site (the Claude sandbox cannot).
   Usage: node scripts/account-page-review.js <site-url> [screenshots-dir]

   It reads no secret and no real data. In a real Chromium it opens the page twice (a phone and a laptop):
   1. signed out, against the live site: what a visitor sees, whether anything fails to load or is blocked by the security policy;
   2. signed in with a made-up session and made-up server answers (the browser itself answers every /api and database call, so nothing is sent to the live site):
      one order in each state the page can show.
   It prints measurements (overflow, small text, small tap targets, contrast, missing labels), the text a customer reads, and the screenshots as text
   (lines starting with IMG|) so that they can be read back from the run's log: `node scripts/account-page-review.js --decode <log> <dir>` turns them into .jpg files. */
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

const SITE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const SHOTS = process.argv[3] || 'account-review-shots';
const { chromium } = require('playwright');
const SIZES = [{ name: 'phone', width: 390, height: 844 }, { name: 'laptop', width: 1280, height: 800 }];
const SESSION = { access_token: 'review-made-up-token', refresh_token: 'review-made-up-refresh', user: { id: 'review-customer-1', email: 'customer@example.test' } };
const log = (...parts) => console.log(...parts);
let problems = 0;
const note = (text) => log('NOTE ' + text);
const bad = (text) => { problems++; log('FAIL ' + text); };
const ok = (text) => log('OK   ' + text);

const SIZE_ID = '3f2f7d1e-6a58-4a38-9d0c-0c1f7d3a9b11';
const line = (name, q, price) => ({ product_name: name, brand_name: 'Test Brand', size_label: '100 ml', product_size_id: SIZE_ID, quantity: q, unit_price: price, line_total: price * q, currency: 'EGP' });
const order = (id, no, status, extra = {}) => ({
  id, tracking_number: no, status, subtotal: 3450, shipping_amount: 60, total_amount: 3510, currency: 'EGP', created_at: '2026-11-12T10:00:00Z',
  stores: { name: 'متجر تجريبي' }, store_order_request_items: [line('عطر تجريبي', 1, 3450)], store_shipments: [], store_order_cart_restorations: [],
  store_order_cancellation_requests: [], store_shipment_events: [], payment_status: 'not_started', payment_window: null, cancel_reason: null, ...extra
});
const ORDERS = [
  order('o1', 'ELN-REVIEW-0001', 'awaiting_store_confirmation'),
  order('o2', 'ELN-REVIEW-0002', 'store_confirmed', { approved_at: '2026-11-13T09:00:00Z', payable_amount: 3510, payment_window: { state: 'opened', expires_at: new Date(Date.now() + 22 * 60 * 1000).toISOString() } }),
  order('o3', 'ELN-REVIEW-0003', 'processing', { approved_at: '2026-11-13T09:00:00Z', payment_status: 'paid', payment_method: 'card', paid_at: '2026-11-13T09:10:00Z', payable_amount: 3510 }),
  order('o4', 'ELN-REVIEW-0004', 'shipped', {
    approved_at: '2026-11-10T09:00:00Z', payment_status: 'cod_selected', payable_amount: 3510,
    store_order_request_items: [line('عطر أول', 2, 1000), line('عطر ثانٍ', 1, 500), line('عطر ثالث', 1, 400), line('عطر رابع', 1, 300), line('عطر خامس', 1, 200)],
    store_shipments: [{ carrier_name: 'شركة شحن تجريبية', tracking_code: 'TC-1', shipping_status: 'in_transit', estimated_delivery_at: '2026-12-20T00:00:00Z', updated_at: '2026-11-14T08:00:00Z' }],
    store_shipment_events: [{ shipping_status: 'handed_to_carrier', occurred_at: '2026-11-13T10:00:00Z', carrier_name: 'شركة شحن تجريبية' }, { shipping_status: 'in_transit', occurred_at: '2026-11-14T08:00:00Z', carrier_name: 'شركة شحن تجريبية' }]
  }),
  order('o5', 'ELN-REVIEW-0005', 'delivered', { payment_status: 'paid', payment_method: 'card', paid_at: '2026-10-30T10:00:00Z', created_at: '2026-10-29T10:00:00Z', store_shipments: [{ carrier_name: 'شركة شحن تجريبية', tracking_code: 'TC-2', shipping_status: 'delivered', delivery_verified_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T10:00:00Z' }] }),
  order('o6', 'ELN-REVIEW-0006', 'store_rejected', { rejection_reason: 'المنتج غير متوفر حاليًا', created_at: '2026-10-25T10:00:00Z' }),
  order('o7', 'ELN-REVIEW-0007', 'store_cancelled', { created_at: '2026-10-20T10:00:00Z' }),
  order('o8', 'ELN-REVIEW-0008', 'cancelled', { created_at: '2026-10-19T10:00:00Z', cancel_reason: 'payment_window_closed' }),
  order('o9', 'ELN-REVIEW-0009', 'cancelled', { created_at: '2026-10-18T10:00:00Z', cancel_reason: 'store_unresponsive' })
];

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function openPage(browser, size, { signedIn }) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale: 'ar-EG', serviceWorkers: 'block' });
  if (signedIn) await context.addInitScript((value) => { try { localStorage.setItem('elan_auth_session', JSON.stringify(value)); } catch (_) { /* optional */ } }, SESSION);
  const page = await context.newPage();
  const seen = { console: [], failed: [], csp: [], writes: 0 };
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const where = (message.location() || {}).url || '';
    if (where.startsWith(SITE) || !where) seen.console.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => seen.console.push('pageerror: ' + String(error.message).slice(0, 200)));
  page.on('response', (response) => { if (response.url().startsWith(SITE) && response.status() >= 400 && !/\/api\//.test(response.url())) seen.failed.push(response.status() + ' ' + response.url().replace(SITE, '')); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  if (signedIn) {
    // nothing reaches the live site or a real database: the browser answers every call itself
    await page.route((url) => url.origin === new URL(SITE).origin && url.pathname.startsWith('/api/') && url.pathname !== '/api/config', (route) => { if (route.request().method() !== 'GET') seen.writes++; return json(route, { ok: true, items: [], revision: 0 }); });
    await page.route('**/*.supabase.co/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/auth/v1/user') return json(route, SESSION.user);
      if (url.pathname === '/auth/v1/token') return json(route, SESSION);
      return json(route, route.request().method() === 'GET' ? [] : {});
    });
    await page.route('**/api/customer-orders*', (route) => json(route, { ok: true, sessions: [{ id: 's1', store_order_requests: ORDERS }], pagination: { total: ORDERS.length, hasMore: false } }));
  }
  return { context, page, seen };
}

/* what the page looks like to the eye: measured in the page itself */
function measure() {
  const out = { overflowX: document.documentElement.scrollWidth - window.innerWidth, lang: document.documentElement.lang, dir: getComputedStyle(document.documentElement).direction, title: document.title };
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  const all = Array.from(document.querySelectorAll('body *')).filter(visible);
  out.small = all.filter((el) => el.children.length === 0 && el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => ({ text: el.textContent.trim().slice(0, 40), px: getComputedStyle(el).fontSize }));
  out.tiny = Array.from(document.querySelectorAll('button, a[href], summary, input, select, textarea')).filter(visible).map((el) => { const r = el.getBoundingClientRect(); return { name: nameOf(el).slice(0, 40) || '(no name)', w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.h < 40 || x.w < 40);
  out.unnamed = Array.from(document.querySelectorAll('button, a[href], input, select, textarea')).filter(visible).filter((el) => !nameOf(el) && !(el.labels && el.labels.length) && !el.placeholder).map((el) => el.outerHTML.slice(0, 100));
  out.noAlt = Array.from(document.images).filter((i) => visible(i) && !i.hasAttribute('alt')).map((i) => i.src.slice(-50));
  out.dupIds = (() => { const seen = {}, dup = []; document.querySelectorAll('[id]').forEach((el) => { if (seen[el.id]) dup.push(el.id); seen[el.id] = 1; }); return dup; })();
  out.clipped = all.filter((el) => el.scrollWidth > el.clientWidth + 2 && /(hidden|clip)/.test(getComputedStyle(el).overflowX) && el.clientWidth > 0).map((el) => (el.className || el.tagName).toString().slice(0, 40));
  out.wide = all.filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 || el.getBoundingClientRect().left < -1).map((el) => (el.className || el.tagName).toString().slice(0, 40)).slice(0, 8);
  const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; const m = c.match(/[\d.]+/g); if (m && (m.length < 4 || Number(m[3]) > 0.9)) return c; } return 'rgb(255,255,255)'; };
  out.lowContrast = all.filter((el) => el.children.length === 0 && el.textContent.trim()).map((el) => { const fg = getComputedStyle(el).color, bg = bgOf(el); const a = lum(fg), b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); return { text: el.textContent.trim().slice(0, 36), ratio: Math.round(ratio * 10) / 10, px: getComputedStyle(el).fontSize }; }).filter((x) => x.ratio < 4.5).slice(0, 12);
  out.digits = /[٠-٩]/.test(document.body.innerText) ? 'Arabic-Indic digits appear in the page text' : 'Latin digits only';
  return out;
}

function report(label, m) {
  log(`--- ${label}: page ${m.title ? '«' + m.title + '»' : '(no title)'}, lang=${m.lang || '-'}, dir=${m.dir}`);
  (m.overflowX > 0 ? bad : ok)(`${label}: ${m.overflowX > 0 ? 'the page is ' + m.overflowX + 'px wider than the screen' : 'nothing wider than the screen'}`);
  if (m.wide.length) note(`${label}: elements poking out of the screen: ${m.wide.join(', ')}`);
  if (m.small.length) note(`${label}: text under 12px: ${JSON.stringify(m.small.slice(0, 8))}`);
  if (m.tiny.length) note(`${label}: tap targets under 40px: ${JSON.stringify(m.tiny.slice(0, 10))}`);
  if (m.unnamed.length) note(`${label}: controls with no name: ${JSON.stringify(m.unnamed.slice(0, 5))}`);
  if (m.noAlt.length) note(`${label}: pictures with no alt: ${JSON.stringify(m.noAlt)}`);
  if (m.dupIds.length) bad(`${label}: duplicate ids: ${m.dupIds.join(', ')}`);
  if (m.clipped.length) note(`${label}: text that may be cut off: ${m.clipped.join(', ')}`);
  if (m.lowContrast.length) note(`${label}: contrast under 4.5:1: ${JSON.stringify(m.lowContrast)}`);
  note(`${label}: ${m.digits}`);
}

async function shoot(page, name) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const buffer = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true });
    fs.writeFileSync(path.join(SHOTS, name + '.jpg'), buffer);
    const text = buffer.toString('base64'), size = 3000, total = Math.ceil(text.length / size);
    for (let i = 0; i < total; i++) log(`IMG|${name}|${i}|${total}|${text.slice(i * size, (i + 1) * size)}`);
    log(`shot ${name}: ${Math.round(buffer.length / 1024)} KB`);
  } catch (error) { note('no screenshot for ' + name + ': ' + error.message); }
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  for (const size of SIZES) {
    // 1. signed out, on the live site
    {
      const label = `${size.name} signed out`;
      const { context, page, seen } = await openPage(browser, size, { signedIn: false });
      try {
        const response = await page.goto(SITE + '/account.html', { waitUntil: 'load' });
        (response.status() === 200 ? ok : bad)(`${label}: the page answers ${response.status()}`);
        await page.waitForSelector('#login:not([hidden])', { timeout: 15000 }).then(() => ok(`${label}: the sign-in form shows`), () => bad(`${label}: the sign-in form did not show`));
        await page.waitForTimeout(1500);
        report(label, await page.evaluate(measure));
        log(`TEXT ${label}: ` + (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())).slice(0, 600));
        const csp = await page.evaluate(() => window.__csp);
        (csp.length ? bad : ok)(`${label}: ${csp.length ? 'the security policy blocked: ' + csp.join(' | ') : 'the security policy blocked nothing'}`);
        (seen.console.length ? bad : ok)(`${label}: ${seen.console.length ? 'console errors from the site: ' + seen.console.join(' | ') : 'no console errors from the site'}`);
        if (seen.failed.length) bad(`${label}: files that failed to load: ${seen.failed.join(', ')}`);
        await shoot(page, `${size.name}-signed-out`);
      } catch (error) { bad(`${label}: ${error.message}`); } finally { await context.close(); }
    }
    // 2. signed in, with made-up data
    {
      const label = `${size.name} signed in`;
      const { context, page, seen } = await openPage(browser, size, { signedIn: true });
      try {
        await page.goto(SITE + '/account.html', { waitUntil: 'load' });
        await page.waitForSelector('#app:not([hidden]) .acct-order', { timeout: 20000 }).then(() => ok(`${label}: the orders show`), () => bad(`${label}: the orders did not show`));
        await page.waitForTimeout(1200);
        log(`SUMMARY ${label}: ` + ((await page.locator('.acct-summary, #ordersHeadline, #stats, #archiveSearch, .acct-foot').count()) === 0 ? 'the removed blocks are gone' : 'STILL ON THE PAGE'));
        log(`CART ${label}: href=${await page.locator('#cartShortcut').getAttribute('href')} icon=${await page.locator('#cartShortcut svg').count()}`);
        const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.acct-order')).map((card) => ({
          list: card.closest('#activeOrders') ? 'active' : card.closest('#recentOrders') ? 'recent' : 'other', past: card.classList.contains('is-past'),
          steps: Array.from(card.querySelectorAll('.acct-steps li')).map((li) => li.className).join(','),
          buttons: Array.from(card.querySelectorAll('button, a.ghost, a.btn')).filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
          text: card.innerText.replace(/\s+/g, ' ').trim().slice(0, 330)
        })));
        cards.forEach((card, i) => log(`CARD ${label} #${i + 1} [${card.list}${card.past ? ', finished' : ''}] steps=${card.steps || '-'} buttons=${JSON.stringify(card.buttons)}\n     ${card.text}`));
        report(label, await page.evaluate(measure));
        const csp = await page.evaluate(() => window.__csp);
        (csp.length ? bad : ok)(`${label}: ${csp.length ? 'the security policy blocked: ' + csp.join(' | ') : 'the security policy blocked nothing'}`);
        (seen.console.length ? bad : ok)(`${label}: ${seen.console.length ? 'console errors from the site: ' + seen.console.join(' | ') : 'no console errors from the site'}`);
        (seen.writes === 0 ? ok : bad)(`${label}: ${seen.writes} writes were answered by the made-up server (none reached the live site)`);
        await shoot(page, `${size.name}-signed-in`);
        // the finished orders are folded: open the first one's details and take it again, as a customer would
        const first = page.locator('#recentOrders .acct-order.is-past summary').first();
        if (await first.count()) { await first.click().catch(() => {}); await page.waitForTimeout(300); await shoot(page, `${size.name}-signed-in-details-open`); }
        // keyboard: the first Tab stops must show a focus ring
        await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; const cs = getComputedStyle(el); return { tag: el.tagName, name: (el.textContent || '').trim().slice(0, 30), outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow !== 'none' }; });
        note(`${label}: after two Tab presses focus is on ${JSON.stringify(focus)}`);
      } catch (error) { bad(`${label}: ${error.message}`); } finally { await context.close(); }
    }
  }
  await browser.close();
  log(problems ? `${problems} problem(s) found` : 'Everything checked is in order');
  process.exit(0);   // a review: the exit code stays 0 so that the notes are always read
}
main().catch((error) => { console.error(error); process.exit(1); });
