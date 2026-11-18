'use strict';
/* Opens the PUBLISHED admin panel (platform-dashboard.html) from outside, the way the owner's browser would, and checks that everything is connected.
   Run by the "Live admin panel check" workflow (GitHub runners can reach the site; the Claude sandbox cannot), or by hand:
     node scripts/admin-live-check.js [site address] [folder for the screenshots]
   Part A (plain requests): the page and every script and style it names are served with the right type and cache rule, the page carries its
   security policy, the old customers and stores addresses forward to the panel, and the panel's endpoints exist on the Worker and refuse a caller
   with no sign-in or a made-up one (a 404, an HTML page or a 5xx there means the Worker does not have the endpoint).
   Part B (real Chromium): the sign-in card shows and nothing is blocked; then, with a made-up admin session and made-up answers for every /api call
   (tests/browser/admin-mock.js), all eight pages open on a laptop and a phone, the first notice opens in full, a message is marked read, the
   sound starts by itself after the first click anywhere (nobody presses the sound button), and news that arrives appears in the strip with a chime. The made-up answers are given by the browser itself, so no
   real customer, order or account is read or changed. What this cannot check is a real sign-in: that needs the owner's password and the
   "are you a person" box, which no robot gets. Exits 1 when something is not as expected. It uses no secret. */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const M = require('../tests/browser/admin-mock.js');

const site = (process.argv[2] || 'https://elan-scents.hossamthapitelgharib.workers.dev').replace(/\/+$/, '');
const out = path.resolve(process.argv[3] || 'admin-shots');
const problems = [];
const say = message => console.log(message);
const expect = (ok, message) => { if (!ok) problems.push(message); say((ok ? 'OK   ' : 'FAIL ') + message); };
async function step(name, fn) {
  try { await fn(); } catch (error) { expect(false, `${name}: ${String(error && error.message || error).split('\n')[0].slice(0, 220)}`); }
}
const get = (pathName, options = {}) => fetch(site + pathName, { redirect: 'manual', ...options });
const isJson = response => /application\/json/i.test(response.headers.get('content-type') || '');

async function partA() {
  say('--- A. the published files and endpoints');
  const response = await get('/platform-dashboard.html');
  const html = await response.text();
  expect(response.status === 200 && /text\/html/i.test(response.headers.get('content-type') || ''), `the panel page answers (HTTP ${response.status})`);
  const policy = response.headers.get('content-security-policy') || '';
  expect(/script-src/.test(policy), 'the page carries its security policy');
  expect(!/<script(?![^>]*\bsrc=)/i.test(html) && !/\son[a-z]+=/i.test(html), 'no inline script or handler in the page');
  const assets = [...html.matchAll(/(?:src|href)="(\/[A-Za-z0-9._-]+\.(?:js|css))\?v=([0-9A-Za-z-]+)"/g)].map(match => ({ file: match[1], version: match[2] }));
  const versions = new Set(assets.map(asset => asset.version));
  expect(versions.size === 1, `one ?v= number on every file (${[...versions].join(', ')})`);
  for (const wanted of ['/admin.css', '/admin-common.js', '/admin-alerts.js', '/admin-notices.js', '/admin-messages.js', '/admin-shell.js']) {
    expect(assets.some(asset => asset.file === wanted), `the page loads ${wanted}`);
  }
  for (const asset of assets) {
    const file = await get(`${asset.file}?v=${asset.version}`);
    const type = file.headers.get('content-type') || '';
    const cache = file.headers.get('cache-control') || '';
    const typeOk = asset.file.endsWith('.css') ? /text\/css/i.test(type) : /javascript/i.test(type);
    const shared = /admin|portal|pw-eye|turnstile|auth-session/.test(asset.file);
    expect(file.status === 200 && typeOk && (!shared || /immutable/.test(cache)), `${asset.file}: HTTP ${file.status}, ${type.split(';')[0]}${shared ? `, cache «${cache}»` : ''}`);
  }
  for (const [old, hash] of [['/customers-dashboard.html', '#customers'], ['/stores-dashboard.html', '#stores']]) {
    const page = await get(old);
    const text = await page.text();
    expect(page.status === 200 && text.includes(`url=/platform-dashboard.html${hash}`), `${old} forwards to the panel's ${hash} page`);
  }
  for (const endpoint of ['/api/platform-alerts', '/api/platform-first-notices']) {
    for (const [label, headers] of [['no sign-in', {}], ['a made-up token', { Authorization: 'Bearer not-a-real-token' }]]) {
      const answer = await get(endpoint, { headers });
      const body = await answer.text();
      const refused = answer.status === 401 || answer.status === 403;
      expect(refused && isJson(answer) && /no-store/.test(answer.headers.get('cache-control') || '') && !/<html/i.test(body), `${endpoint} with ${label}: HTTP ${answer.status}, JSON, no-store${refused ? '' : ' (expected 401: is the endpoint on the Worker?)'}`);
    }
  }
  const mark = await get('/api/platform-alerts', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) });
  expect(mark.status === 401, `marking messages read with no sign-in is refused (HTTP ${mark.status})`);
  const config = await get('/api/config');
  const settings = await config.json().catch(() => ({}));
  expect(config.status === 200 && !!settings.url && !!settings.key, '/api/config gives the sign-in form its settings');
}

/* Errors the panel's own scripts raise. What Cloudflare's "are you a person" frame writes to its own console (it probes data: addresses and its own
   policy refuses them) is not ours and not a fault of the panel, so a console line counts only when it comes from a file of this site. */
const readErrors = page => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error).slice(0, 200)));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const from = (message.location() || {}).url || '';
    if (from.startsWith(site)) errors.push('console: ' + message.text().slice(0, 200));
  });
  return errors;
};

async function signInCard(browser) {
  say('--- B1. the sign-in card, as a visitor with no session sees it');
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  await context.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', event => window.__csp.push(event.violatedDirective + ' ' + String(event.blockedURI || '').slice(0, 120))); });
  const page = await context.newPage();
  const errors = readErrors(page);
  const bad = [];
  page.on('response', response => { if (response.url().startsWith(site) && response.status() >= 400) bad.push(`${response.status()} ${response.url().slice(site.length, site.length + 80)}`); });
  await step('sign-in card', async () => {
    await page.goto(site + '/platform-dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#login:not([hidden])', { timeout: 15000 });
    expect(await page.locator('#app').isHidden(), 'the panel itself stays closed until sign-in');
    await page.screenshot({ path: path.join(out, 'b1-login.png') });
    // opening the form starts the "are you a person" check; its script and frame must not be blocked by the page's policy
    await page.click('#loginForm [name="email"]');
    await page.waitForTimeout(5000);
    expect((await page.evaluate(() => window.__csp)).length === 0, `the security policy blocked nothing (${JSON.stringify(await page.evaluate(() => window.__csp))})`);
    expect(bad.length === 0, `every file of the same site answered (${bad.join('; ') || 'none failed'})`);
    expect(errors.length === 0, `no script error on the sign-in card (${errors.join(' | ') || 'none'})`);
  });
  await context.close();
}

async function fakeSession(browser, size, label) {
  say(`--- B2. ${label}: a made-up admin session and made-up server answers`);
  const phone = size.width < 600;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2 });
  const world = M.newWorld();
  await M.installFakeServer(context, world);
  const page = await context.newPage();
  const errors = readErrors(page);
  const shot = name => page.screenshot({ path: path.join(out, `${label}-${name}.png`) });
  const goTo = async key => {
    if (phone && await page.locator('#menuToggle').isVisible()) { await page.click('#menuToggle'); await page.waitForTimeout(300); }
    await page.click(`#adminNav a[data-page="${key}"]`);
    await page.waitForFunction(k => !document.querySelector(`#page-${k}`).hidden, key, { timeout: 10000 });
    await page.waitForTimeout(350);
  };

  await step(`${label}: open`, async () => {
    await page.goto(site + '/platform-dashboard.html', { waitUntil: 'load' });
    await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
    expect(world.calls.some(call => call === 'GET /api/platform-alerts'), 'the panel asked the alerts endpoint on opening');
    expect(/الرئيسية/.test(await page.textContent('#pageTitle')), 'it opens on the overview');
    await page.evaluate(() => { window.__kept = 1; });
  });

  for (const key of M.PAGES) {
    await step(`${label}: ${key}`, async () => {
      await goTo(key);
      if (key === 'first-notices') await page.waitForSelector('.notice-row', { timeout: 10000 });
      if (key === 'messages') await page.waitForSelector('.message', { timeout: 10000 });
      if (key === 'stores') await page.waitForSelector('#page-stores tbody tr, #page-stores .store-row', { timeout: 10000 });
      await page.waitForTimeout(250);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways === 0 && (await page.locator('.page:not([hidden])').count()) === 1, `${label}: page «${key}» opens, alone, with no sideways scroll`);
      if (!phone || ['first-notices', 'messages', 'stores'].includes(key)) await shot(key);
    });
  }
  await step(`${label}: no reload`, async () => {
    expect(await page.evaluate(() => window.__kept) === 1, `${label}: moving through the pages never reloaded the document`);
    const asked = new Set(world.calls.map(call => call.replace(/^[A-Z]+ /, '')));
    for (const endpoint of ['/api/platform-first-notices', '/api/platform-customers', '/api/platform-stores', '/api/platform-audit-log', '/api/platform-commission-settlement', '/api/platform-product-rankings']) {
      expect(asked.has(endpoint), `${label}: the pages asked ${endpoint}`);
    }
  });

  await step(`${label}: first notice`, async () => {
    await goTo('first-notices');
    await page.click('.notice-row >> nth=0');
    await page.waitForFunction(() => /ELN-TEST-0001/.test(document.querySelector('#noticeDetail').textContent) && /PAY-TEST-123/.test(document.querySelector('#noticeDetail').textContent), null, { timeout: 8000 });
    expect(true, `${label}: a first notice opens in full (items, payment reference, delivery)`);
    await shot('notice-detail');
    if (phone) {
      // on a phone the list gives way to the notice, and «الرجوع إلى القائمة» brings it back
      expect(await page.locator('.notice-row').first().isHidden(), `${label}: the list steps aside while a notice is open`);
      await page.click('[data-notice-back]');
      await page.waitForSelector('.notice-row', { state: 'visible', timeout: 5000 });
    }
    await page.click('.notice-row[data-notice-id$="103"]');
    await page.waitForFunction(() => /ELN-TEST-0003/.test(document.querySelector('#noticeDetail').textContent), null, { timeout: 8000 });
    expect(await page.locator('#noticeList img, #noticeDetail img').count() === 0 && await page.evaluate(() => window.__xss === undefined), `${label}: a store name that is an attack stays text`);
  });

  await step(`${label}: messages`, async () => {
    await goTo('messages');
    await page.waitForSelector('.message');
    expect(await page.locator('.message.is-unread').count() === 2, `${label}: two unread messages shown`);
    await page.click('#messagesTabUnread');
    await page.click('[data-message-read] >> nth=0');
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 1, null, { timeout: 8000 });
    expect(world.patches.length === 1 && world.patches[0].id === M.id(1), `${label}: «تمت القراءة» sent one PATCH with that message's id`);
  });

  await step(`${label}: sound and news`, async () => {
    if (phone) return;
    expect(await page.evaluate(() => window.__notes) === 0, `${label}: the opening poll was silent`);
    expect(await page.evaluate(() => AdminAlerts.state().soundOn === true), `${label}: the sound is on without anybody pressing the sound button`);
    await page.mouse.click(3, 3);
    await page.waitForFunction(() => document.querySelector('#soundToggle').dataset.state === 'on', null, { timeout: 5000 });
    expect(await page.evaluate(() => window.__notes) === 0, `${label}: the first click anywhere starts the audio silently`);
    world.alerts.unshift({ id: M.id(50), type: 'order_payment_recorded', title: 'دفع جديد وصل', body: 'الطلب ELN-TEST-0050', isRead: false, createdAt: M.ago(0), trackingNumber: 'ELN-TEST-0050', requestId: M.id(150), storeId: M.id(91) });
    await page.evaluate(() => AdminAlerts.pollOnce());
    await page.waitForSelector('#alertStrip:not([hidden]) .alert-item', { timeout: 8000 });
    expect(await page.evaluate(() => window.__notes) === 2, `${label}: news that arrives shows a card and plays a chime`);
    world.alerts.unshift({ id: M.id(51), type: 'order_cancelled', title: 'طلب أُلغي', body: 'الطلب ELN-TEST-0051', isRead: false, createdAt: M.ago(0), trackingNumber: 'ELN-TEST-0051', requestId: M.id(151), storeId: M.id(91) });
    await page.evaluate(() => AdminAlerts.pollOnce());
    await page.waitForFunction(() => document.querySelectorAll('#alertStripList .alert-item').length === 2, null, { timeout: 8000 });
    expect(await page.evaluate(() => window.__notes) === 5, `${label}: a cancellation (stage 1 message) plays the three-note warning`);
    await shot('alert-strip');
  });

  const violations = await page.evaluate(() => window.__csp);
  expect(violations.length === 0, `${label}: the security policy blocked nothing (${violations.join('; ') || 'none'})`);
  expect(errors.length === 0, `${label}: no script error (${errors.join(' | ') || 'none'})`);
  await context.close();
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  say(`checking ${site}`);
  await step('part A', partA);
  const browser = await chromium.launch();
  try {
    await signInCard(browser);
    await fakeSession(browser, { width: 1366, height: 820 }, 'laptop');
    await fakeSession(browser, { width: 390, height: 844 }, 'phone');
  } finally { await browser.close(); }
  say(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nEverything checked is as expected.');
  process.exit(problems.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
