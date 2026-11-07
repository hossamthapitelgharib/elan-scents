'use strict';
/* Opens the editor of a running site in a real Chromium, signs in as the owner and compares the panels with the owner's original editor file
   (tests/fixtures/elan-original-panels-golden.json): every look the original draws (colours, type, borders, radius) must be drawn by the live
   panel too, and each panel must be as wide. It also checks the menu has "دخول لصفحة", the header has "صفحة سابقة" next to the GitHub step and the
   save button has its lamp. It never presses save and never changes anything. A phone-sized window is checked too (the platform fills the width).
   Used by .github/workflows/live-editor-check.yml, which gives the owner's e-mail and password from repository secrets (never written anywhere):
     EDITOR_LIVE_EMAIL, EDITOR_LIVE_PASSWORD, SITE_URL. tests/browser/live-editor-check.chromium.js runs the same code against the local test server. */
const fs = require('node:fs');
const path = require('node:path');
const F = require('../tests/browser/panel-fidelity.js');
const golden = require('../tests/fixtures/elan-original-panels-golden.json');

const isAi = (e) => /الذكاء الاصطناعي/.test(e.text);
const PANELS = [
  { name: 'section', tool: /إنشاء سيكشن/, selector: 'dialog.sectionPanelClean[open]', key: 'section-manual' },
  { name: 'perfume card', tool: /إنشاء كارت عطر/, selector: 'dialog.sectionPanelClean[open]', key: 'perfume-manual' },
  { name: 'brand card', tool: /إنشاء كارت براند/, selector: 'dialog[open]', key: 'brand' },
  { name: 'store card', tool: /إنشاء كارت متجر/, selector: 'dialog[open]', key: 'store' },
  { name: 'picture/video source', tool: /إنشاء صورة أو فيديو/, selector: '#elanMediaDlg[open]', key: 'media-source', drop: isAi },
  { name: 'text format', tool: /تنسيق النص/, selector: '#format[open]', key: 'format', drop: (e) => e.text === 'Élan Scents' /* the sample line shows the chosen element's own look */, after: async (page) => {
    await page.evaluate((controls) => {      // the original was captured on an element with these colours
      Array.from(document.querySelectorAll('#format input[type=color]')).forEach((input, i) => { const c = controls.filter((x) => x.type === 'color')[i]; if (c) { input.value = c.value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); } });
    }, golden.formatControls);
  } }
];

async function findFrame(page) {
  let frame = null;
  for (let i = 0; i < 120 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && document.getElementById('hero'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  return frame;
}
async function openMenu(page, frame) {
  const target = await frame.evaluate(() => {
    const e = window.ElanDesignLayer.elements().find((x) => x.kind === 'section' && x.id.startsWith('sec:') && x.el.getBoundingClientRect().height > 80);
    document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: Math.max(0, scrollY + e.el.getBoundingClientRect().top - 120), behavior: 'instant' });
    const r = e.el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 30 };
  });
  await page.waitForTimeout(300);
  const box = await page.locator('iframe').first().boundingBox(), k = box.width / 390;
  await page.mouse.click(box.x + target.x * k, box.y + target.y * k, { button: 'right' });
  await page.waitForTimeout(400);
  return page.evaluate(() => { const m = document.getElementById('menu'); return !m || m.style.display === 'none' ? [] : Array.from(m.children).map((b) => b.textContent); });
}

/* check({ context, base, login, shots }) -> { lines, problems }. `login(page)` signs in when the editor shows its login page. */
async function check({ context, base, login, shots, loginWaitMs }) {
  const lines = [], problems = [];
  const say = (t) => lines.push(t), bad = (t) => { problems.push(t); lines.push('FAIL ' + t); };
  const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name + '.png') }); } };

  const page = await context.newPage();
  /* What the sign-in did, kept only as facts about the network (a status per address, never a body, a header or what was typed), so a run that
     cannot sign in says why: the security check's script not arriving, its box waiting for a tick, or the answer the server gave. */
  const seen = [], errors = [];
  const hostOf = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch (_) { return ''; } };
  page.on('response', (r) => { const u = hostOf(r.url()); if (/\/api\/(config|editor-login)$|challenges\.cloudflare\.com/.test(u)) seen.push(u.replace(/^[^/]*\/api\//, '/api/').slice(0, 60) + ' ' + r.status()); });
  page.on('requestfailed', (r) => { const u = hostOf(r.url()); if (/challenges\.cloudflare\.com|\/api\//.test(u)) seen.push(u.slice(0, 60) + ' failed ' + String(r.failure() && r.failure().errorText || '').slice(0, 40)); });
  page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 120)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(String(m.text()).slice(0, 120)); });
  await page.goto(base + '/editor', { waitUntil: 'load' });
  if (await page.locator('#loginBtn').count()) { await login(page); await page.waitForURL((u) => !/login/.test(u.search) && u.pathname === '/editor', { timeout: loginWaitMs || 30000 }).catch(() => {}); await page.waitForTimeout(1000); }
  const frame = await findFrame(page);
  if (!frame) {
    // The login page's own status line (an Arabic sentence such as the security-check refusal; never the typed values) says why the sign-in did not go through.
    const said = ((await page.locator('#msg').first().innerText({ timeout: 1000 }).catch(() => '')) || '').trim().slice(0, 200);
    /* Still on «جاري الدخول...» and the server was never asked: Cloudflare's security check (the Turnstile box the sign-in waits for) did not
       hand a token to this automated browser. That is the check doing its job, not a fault of the site, and nothing after the sign-in was
       looked at, so it is reported as NOT CHECKED (a warning), never as a pass; a refused sign-in or a page that failed is still a failure. */
    const waitedForCheck = /\u062c\u0627\u0631\u064a \u0627\u0644\u062f\u062e\u0648\u0644/.test(said) && !seen.some((x) => x.indexOf('/api/editor-login') >= 0);
    if (waitedForCheck) {
      lines.push('NOT CHECKED: the sign-in waits for Cloudflare\u2019s security check, which an automated browser does not pass, so the editor was not opened and no panel was compared.');
    } else {
      bad('the editor did not open the platform (login refused or the page failed to load)' + (said ? '; the login page says: \u00ab' + said + '\u00bb' : ''));
    }
    const box = await page.evaluate(() => ({ frames: Array.from(document.querySelectorAll('iframe')).map((f) => (f.src || '').replace(/\?.*$/, '').slice(0, 70)), holder: !!document.querySelector('.elan-turnstile'), url: location.pathname + location.search.replace(/key=[^&]*/, 'key=*') })).catch(() => null);
    lines.push('     where it stopped: ' + JSON.stringify(box));
    lines.push('     network: ' + (seen.slice(0, 12).join(' | ') || 'nothing about the sign-in was seen'));
    if (errors.length) lines.push('     page messages: ' + errors.slice(0, 5).join(' | '));
    return { lines, problems, notChecked: waitedForCheck };
  }
  await page.waitForTimeout(1500);
  say('editor open at ' + base + '/editor');
  await shot(page, 'editor');

  /* the header */
  const header = await page.evaluate(() => ({ prev: !!document.getElementById('editorPrevPage'), order: Array.from(document.getElementById('editorStages').children).map((c) => c.id || c.dataset.label), lamp: !!document.querySelector('#save .lamp') }));
  if (!header.prev || header.order[0] !== 'editorPrevPage' || header.order[1] !== 'رفع على GitHub') bad('"صفحة سابقة" is not next to the GitHub step: ' + header.order.join(' | ')); else say('ok   "صفحة سابقة" sits next to "رفع على GitHub"');
  if (!header.lamp) bad('the save button has no lamp'); else say('ok   the save button has its lamp (not pressed here)');

  /* the menu */
  let labels = await openMenu(page, frame);
  if (!labels.includes('دخول لصفحة')) bad('the menu has no "دخول لصفحة": ' + labels.join(' | ')); else say('ok   the menu lists "دخول لصفحة"');
  if (await frame.evaluate(() => !!document.querySelector('.eo-open'))) bad('the element box still has the open-page chip');
  await page.keyboard.press('Escape');

  /* the panels */
  for (const panel of PANELS) {
    try {
      labels = await openMenu(page, frame);
      const at = labels.findIndex((t) => panel.tool.test(t));
      if (at < 0) { bad(panel.name + ': no menu item ' + panel.tool); continue; }
      await page.locator('#menu > *').nth(at).click(); await page.waitForTimeout(1500);
      if (panel.after) { await panel.after(page); await page.waitForTimeout(300); }
      const live = await page.evaluate(F.describePanel, { selector: panel.selector, props: F.PROPS });
      await shot(page, panel.key);
      if (!live) { bad(panel.name + ': the panel did not open'); continue; }
      const missing = F.missingLooks(live, golden.panels[panel.key], panel.drop);
      if (missing.length) bad(panel.name + ': differs from the original in ' + missing.length + ' looks: ' + missing.slice(0, 6).join(' ; ')); else say('ok   ' + panel.name + ': every colour, type size and border of the original is there');
    } catch (e) { bad(panel.name + ': ' + e.message); }
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close())).catch(() => {});
  }

  /* the library window */
  try {
    await page.click('#library'); await page.waitForTimeout(1800);
    const live = await page.evaluate(F.describePanel, { selector: '#libraryDialog', props: F.PROPS });
    await shot(page, 'library');
    /* the original's row under «إغلاق» (load, sync, the connection line) was removed on the owner's order: it did nothing the window does not do itself */
    const rows = golden.panels['library-archive-section'], close = rows.findIndex((e) => e.tag === 'button' && e.text === 'إغلاق');
    const missing = live ? F.missingLooks(live, rows, (e) => isAi(e) || (close > 0 && rows.indexOf(e) > close)) : ['the library window did not open'];
    if (missing.length) bad('library: differs from the original in ' + missing.length + ' looks: ' + missing.slice(0, 6).join(' ; ')); else say('ok   library: every colour, type size and border of the original is there');
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  } catch (e) { bad('library: ' + e.message); }

  /* a phone-sized window: the platform must fill the screen */
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(1200);
  const box = await page.locator('iframe').first().boundingBox();
  await shot(page, 'phone');
  if (!box || box.width < 386 || box.width > 394 || Math.abs(box.x) > 2) bad('on a 390px window the platform is ' + (box && Math.round(box.width)) + 'px wide'); else say('ok   on a 390px window the platform fills the width');
  return { lines, problems };
}

module.exports = { check, PANELS };

if (require.main === module) {
  (async () => {
    const base = (process.argv[2] || process.env.SITE_URL || 'https://elan-scents.hossamthapitelgharib.workers.dev').replace(/\/$/, '');
    const email = process.env.EDITOR_LIVE_EMAIL || '', password = process.env.EDITOR_LIVE_PASSWORD || '';
    if (!email || !password) {
      console.log('The repository secrets EDITOR_LIVE_EMAIL and EDITOR_LIVE_PASSWORD are not set, so the editor cannot be opened from here.');
      console.log('Add them under Settings > Secrets and variables > Actions, then run this workflow again. Nothing was checked.');
      return;
    }
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'ar-EG' });
    const login = async (page) => { await page.fill('#email', email); await page.fill('#pass', password); await page.click('#loginBtn'); };
    const out = await check({ context, base, login, shots: process.argv[3] || 'live-editor-shots' });
    await browser.close();
    console.log(out.lines.join('\n'));
    if (out.notChecked) console.log('::warning title=Live editor check::NOT CHECKED - the sign-in waits for Cloudflare\u2019s security check, which this automated browser does not pass. Nothing about the editor was compared.');
    process.exitCode = out.problems.length ? 1 : 0;
  })().catch((e) => { console.error('the check could not run:', e.message); process.exit(1); });
}
