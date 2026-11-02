'use strict';
/* Developer tool, not part of the test run. Opens the owner's ORIGINAL editor file in a real Chromium, opens its library, section,
   perfume and brand panels (with the same lists the live-editor test gives its panels), and writes what is drawn to
   tests/fixtures/elan-original-panels-golden.json.
   node scripts/capture-original-panels.js /path/to/elan-editor-handoff.html */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const F = require('../tests/browser/panel-fidelity.js');

(async () => {
  const file = path.resolve(process.argv[2] || '');
  if (!fs.existsSync(file)) { console.error('give the path of the original editor html file'); process.exit(1); }
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'ar-EG' });
  await context.route('**/*', (r) => r.request().url().startsWith('file:') ? r.continue() : r.fulfill({ status: 204, body: '' }));
  const page = await context.newPage();
  await page.addInitScript((data) => {
    window.elanSectionDataProvider = { getOptions: async () => data.OPTIONS, getPerfumes: async () => data.PERFUMES };
  }, { OPTIONS: F.OPTIONS, PERFUMES: F.PERFUMES });
  await page.goto('file://' + file); await page.waitForTimeout(1200);
  const golden = { capturedFrom: path.basename(file), viewport: '1366x860', panels: {} };
  const grab = (name, selector) => page.evaluate(F.describePanel, { selector, props: F.PROPS }).then((d) => { golden.panels[name] = d; });
  const toolMenu = async (re) => {
    await page.mouse.click(300, 400, { button: 'right' }); await page.waitForTimeout(300);
    const items = await page.evaluate(() => Array.from(document.getElementById('menu').children).map((b) => b.textContent));
    await page.locator('#menu button').nth(items.findIndex((t) => re.test(t))).click(); await page.waitForTimeout(900);
  };
  const closeAll = () => page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  const press = async (text) => { await page.locator('#libraryDialog button', { hasText: text }).first().click(); await page.waitForTimeout(250); };

  await page.click('#library'); await page.waitForTimeout(500);
  await grab('library-archive-section', '#libraryDialog');
  await press('الميديا والعناصر المحفوظة'); await press('صورة');
  await grab('library-saved-image', '#libraryDialog');
  await closeAll();

  await toolMenu(/إنشاء سيكشن/);
  await grab('section-manual', 'dialog.sectionPanelClean[open]');
  await page.evaluate(() => { const s = document.querySelector('dialog.sectionPanelClean fieldset select'); s.value = 'automatic'; s.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(300);
  await grab('section-automatic', 'dialog.sectionPanelClean[open]');
  await page.evaluate(() => { const c = document.querySelector('dialog.sectionPanelClean .toggle input'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(200);
  await grab('section-automatic-timer', 'dialog.sectionPanelClean[open]');
  await closeAll();

  await toolMenu(/إنشاء كارت عطر/);
  await grab('perfume-manual', 'dialog.sectionPanelClean[open]');
  await closeAll();

  await toolMenu(/إنشاء كارت براند/);
  await grab('brand', 'dialog[open]');
  await closeAll();
  /* the text-format panel (font, colour, size): select the first element on the page, right click it, pick the format tool */
  const first = page.locator('.item').first();
  await first.click(); await first.click({ button: 'right' }); await page.waitForTimeout(300);
  const labels = await page.evaluate(() => Array.from(document.getElementById('menu').children).map((b) => b.textContent));
  await page.locator('#menu button').nth(labels.findIndex((t) => /الخط واللون|تنسيق/.test(t))).click(); await page.waitForTimeout(700);
  await grab('format', '#format[open]');
  await closeAll();
  await browser.close();

  const target = path.join(__dirname, '..', 'tests', 'fixtures', 'elan-original-panels-golden.json');
  fs.writeFileSync(target, JSON.stringify(golden, null, 1) + '\n');
  console.log('written', target, Object.entries(golden.panels).map(([k, v]) => k + ':' + v.length).join(' '));
})().catch((e) => { console.error(e); process.exit(1); });
