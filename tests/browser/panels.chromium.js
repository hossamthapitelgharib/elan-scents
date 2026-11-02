'use strict';
/* The editor's creation panels and library window, in a real Chromium, against the owner's ORIGINAL editor file.
   tests/fixtures/elan-original-panels-golden.json holds what the original file draws for each panel (scripts/capture-original-panels.js
   writes it); here the live editor opens the same panels with the same lists and every drawn element must sit in the same place
   with the same type, spacing and borders (backgrounds excepted: the editor's surfaces are white on purpose). */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const F = require('./panel-fidelity.js');
const golden = require('../fixtures/elan-original-panels-golden.json');

const pw = H.loadPlaywright();
const skip = pw ? false : 'Playwright is not installed (npm install, then npx playwright install chromium)';
const WINDOW = { width: 1366, height: 860 };            // what the original was captured in
const REVISION = 'a'.repeat(64);

let browser, server;
test.before(async () => { if (!pw) return; server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

/* The editor, with /api/editor-data answered from the same lists the original panels were given. */
async function openEditor(size) {
  const { context, problems } = await H.openContext(browser, server, size || WINDOW);
  const calls = [];
  await context.route('**/api/editor-data*', async (route) => {
    const request = route.request(); let body = {};
    try { body = JSON.parse(request.postData() || '{}'); } catch (_) { body = {}; }
    const action = body.action || new URL(request.url()).searchParams.get('action');
    calls.push(action);
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (action === 'options') return json({ ok: true, options: F.OPTIONS });
    if (action === 'perfumes') return json({ ok: true, rows: F.PERFUMES });
    if (action === 'library') return json({ ok: true, library: { media: [], archive: [], savedElements: [], revision: REVISION } });
    return json({ ok: false, error: 'not_expected_in_this_test' });
  });
  await H.loginAsOwner(context, server);
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && document.getElementById('hero'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the platform loaded inside the editor');
  await page.waitForTimeout(1500);
  return { context, page, frame, errors, problems, calls };
}

/* Right click inside a section of the platform and read the tools menu. */
async function openMenu(page, frame) {
  const target = await frame.evaluate(() => {
    const e = window.ElanDesignLayer.elements().find((x) => x.kind === 'section' && x.id.startsWith('sec:') && x.el.getBoundingClientRect().height > 80);
    const top = e.el.getBoundingClientRect().top;
    document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: Math.max(0, scrollY + top - 120), behavior: 'instant' });
    const r = e.el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 30 };
  });
  await page.waitForTimeout(300);
  const box = await page.locator('iframe').first().boundingBox();
  const k = box.width / 390;
  await page.mouse.click(box.x + target.x * k, box.y + target.y * k, { button: 'right' });
  await page.waitForTimeout(400);
}
async function chooseTool(page, frame, re) {
  await openMenu(page, frame);
  const labels = await page.evaluate(() => Array.from(document.getElementById('menu').children).map((b) => b.textContent));
  const at = labels.findIndex((t) => re.test(t));
  assert.ok(at >= 0, 'the menu has ' + re + ': ' + labels.join(' | '));
  await page.locator('#menu > *').nth(at).click();
  await page.waitForTimeout(900);
}
const closeDialogs = (page) => page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
const shape = (page, selector) => page.evaluate(F.describePanel, { selector, props: F.PROPS });
const isAi = (e) => /الذكاء الاصطناعي/.test(e.text);
function same(live, name, drop, looseText) {
  assert.ok(live, name + ' is open');
  const problems = F.compare(live, golden.panels[name], 1, drop, looseText);
  assert.deepEqual(problems.slice(0, 12), [], name + ' differs from the original in ' + problems.length + ' places');
}

test('section panel: the same as the original (manual, automatic, with the timer)', { skip }, async () => {
  const { context, page, frame, errors } = await openEditor();
  try {
    await chooseTool(page, frame, /إنشاء سيكشن/);
    const host = await page.evaluate(() => ({ inHost: !!document.querySelector('dialog.sectionPanelClean[open]'), inFrame: !!document.querySelector('iframe') }));
    assert.ok(host.inHost, 'the panel is a dialog of the editor window itself, not of the platform inside it');
    await page.waitForTimeout(500);
    same(await shape(page, 'dialog.sectionPanelClean[open]'), 'section-manual');
    await page.evaluate(() => { const s = document.querySelector('dialog.sectionPanelClean fieldset select'); s.value = 'automatic'; s.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(400);
    same(await shape(page, 'dialog.sectionPanelClean[open]'), 'section-automatic');
    await page.evaluate(() => { const c = document.querySelector('dialog.sectionPanelClean .toggle input'); c.checked = true; c.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(300);
    same(await shape(page, 'dialog.sectionPanelClean[open]'), 'section-automatic-timer');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('text format panel (font, colour, size): the same as the original', { skip }, async () => {
  const { context, page, frame } = await openEditor();
  try {
    await chooseTool(page, frame, /تنسيق النص/);
    assert.ok(await page.evaluate(() => !!document.querySelector('#format[open]')), 'the format panel is open in the editor window');
    /* the panel shows the chosen element's own values: give it the ones the original was captured with (42px, centred, its three colours) */
    await page.evaluate((colors) => {
      const fire = (input) => { input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
      Array.from(document.querySelectorAll('#format input[type=color]')).forEach((input, i) => { if (colors[i]) { input.value = colors[i]; fire(input); } });
      const size = document.getElementById('size'), align = document.getElementById('align');
      size.value = '42'; fire(size); align.value = 'center'; fire(align);
    }, ['#a17b35', '#fffdf9', '#b99755']);
    await page.waitForTimeout(300);
    same(await shape(page, '#format[open]'), 'format', null, ['Élan Scents']);
  } finally { await context.close(); }
});

test('perfume card panel: the same as the original', { skip }, async () => {
  const { context, page, frame } = await openEditor();
  try {
    await chooseTool(page, frame, /إنشاء كارت عطر/);
    await page.waitForTimeout(500);
    same(await shape(page, 'dialog.sectionPanelClean[open]'), 'perfume-manual');
  } finally { await context.close(); }
});

test('brand card panel: the same as the original', { skip }, async () => {
  const { context, page, frame } = await openEditor();
  try {
    await chooseTool(page, frame, /إنشاء كارت براند/);
    same(await shape(page, 'dialog[open]'), 'brand');
  } finally { await context.close(); }
});

test('library window: the same layout as the original, with the cloud library behind it and nothing from the AI', { skip }, async () => {
  const { context, page, calls, errors } = await openEditor();
  try {
    /* the original was captured on an empty page: this platform's own archived blocks would add an "others" folder */
    await page.evaluate(() => { const live = window.elanLiveEditorBridge, real = live.request; live.request = (action, payload) => action === 'page.getState' ? Promise.resolve({ archive: [], design: { blocks: [] }, selected: null }) : real.call(live, action, payload); });
    await page.click('#library'); await page.waitForTimeout(900);
    assert.ok(calls.includes('library'), 'the window reads the cloud library');
    same(await shape(page, '#libraryDialog'), 'library-archive-section', isAi);
    await page.locator('#libraryDialog button', { hasText: 'الميديا والعناصر المحفوظة' }).first().click(); await page.waitForTimeout(250);
    await page.locator('#libraryDialog button', { hasText: 'صورة' }).first().click(); await page.waitForTimeout(250);
    same(await shape(page, '#libraryDialog'), 'library-saved-image', isAi);
    const words = await page.evaluate(() => document.getElementById('libraryDialog').innerText);
    assert.ok(!/الذكاء الاصطناعي|AI/.test(words), 'no AI picture or video in the library window: ' + words);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const width of [390, 411]) {
  test('phone window ' + width + 'px: the platform inside the editor fills the whole screen', { skip }, async () => {
    const { context, page } = await openEditor({ width, height: 844 });
    try {
      const box = await page.locator('iframe').first().boundingBox();
      assert.ok(box.width >= width - 2 && box.width <= width + 2, 'the platform is ' + box.width + 'px wide in a ' + width + 'px window');
      assert.ok(box.x >= -1 && box.x <= 1, 'and starts at the left edge: ' + box.x);
    } finally { await context.close(); }
  });
}
